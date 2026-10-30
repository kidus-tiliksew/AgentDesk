import { closeSync, openSync, readSync } from "node:fs";
import { type Context, InstallerError, startTimer } from "./context.js";
import { ENROLL_ATTEMPT_TIMEOUT_MS, ENROLL_RETRY_LIMIT_MS, POLL_INTERVAL_MS } from "./defaults.js";
import { type HarnessId, harnessById, isHarnessId } from "./harnesses.js";
import {
  type Connection,
  InvalidSignInResult,
  machineName,
  reportedConnections,
  validateConnections,
} from "./signin.js";

// Install-key enrollment (component-installer §Sign-in; overlay-install-keys
// §Installer; req-install-keys REQ-2; DEC-21). The key replaces the short code
// for the harnesses the re-run check leaves unconnected. It is read and checked
// before the run prints anything or makes any request, and it joins the run's
// secret set, so no output line can carry it.

/** An install key is `adk_` and 32 random bytes in base64url. */
export const INSTALL_KEY_PATTERN = /^adk_[A-Za-z0-9_-]{43}$/;

/** `--key-file` reads standard input when the path is this value. */
export const STDIN_PATH = "-";

/**
 * The most input `--key-file` reads, in bytes. A key is 47 characters, so
 * longer input is refused as not a key without reading the rest of it.
 */
export const MAX_KEY_INPUT_LENGTH = 4096;

export const KEY_FILE_UNREADABLE = "The --key-file file could not be read. Nothing was connected.";
export const KEY_STDIN_UNREADABLE =
  "The install key could not be read from standard input. Nothing was connected.";
export const KEY_MALFORMED =
  "The --key-file input is not an AgentDesk install key, which is adk_ followed by 43 characters. Nothing was connected.";

/** The message for each refusal `POST /device/enroll` answers (AC-2.2). */
export const ENROLL_REFUSALS = {
  unknown: "AgentDesk does not know this install key. Nothing was connected.",
  revoked: "This install key was revoked in the AgentDesk app. Nothing was connected.",
  expired: "This install key has expired. Nothing was connected.",
  limit_reached:
    "This install key has reached its machine limit. Revoke a machine it connected, or create another key, in the AgentDesk app. Nothing was connected.",
  harness_not_allowed:
    "This install key does not allow one of the selected harnesses. Leave it out with --only. Nothing was connected.",
} as const;

/**
 * The refusal for a harness the key does not allow. It names the harness only
 * when the answer names a known harness this run requested.
 */
export function harnessNotAllowed(
  ctx: Context,
  harness: unknown,
  requested: readonly HarnessId[],
): string {
  if (typeof harness === "string" && isHarnessId(harness) && requested.includes(harness)) {
    return `This install key does not allow ${harnessById(ctx, harness).displayName}. Leave it out with --only. Nothing was connected.`;
  }
  return ENROLL_REFUSALS.harness_not_allowed;
}

/** Reads the first MAX_KEY_INPUT_LENGTH + 1 bytes of the file at `path` as UTF-8. */
function readFileStart(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_KEY_INPUT_LENGTH + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Reads `input` as UTF-8 to its end, or until it exceeds MAX_KEY_INPUT_LENGTH bytes. */
export function readStream(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    const done = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
    };
    const onData = (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      data += buffer.toString("utf8");
      bytes += buffer.length;
      if (bytes > MAX_KEY_INPUT_LENGTH) {
        done();
        resolve(data);
      }
    };
    const onEnd = () => {
      done();
      resolve(data);
    };
    const onError = (error: unknown) => {
      done();
      reject(error);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * Reads the install key from `path`, or from standard input for `-`, trims
 * surrounding whitespace, and checks its form (overlay-install-keys
 * §Installer). The raw input and the key join the run's secret set before any
 * error is raised. Every failure exits with status 1 and a fixed message that
 * names neither the path nor the content.
 */
export async function readInstallKey(ctx: Context, path: string): Promise<string> {
  let raw: string;
  if (path === STDIN_PATH) {
    if (!ctx.readStdin) throw new InstallerError(KEY_STDIN_UNREADABLE);
    try {
      raw = await ctx.readStdin();
    } catch {
      throw new InstallerError(KEY_STDIN_UNREADABLE);
    }
  } else {
    try {
      raw = readFileStart(path);
    } catch {
      throw new InstallerError(KEY_FILE_UNREADABLE);
    }
  }
  const key = raw.trim();
  if (raw.length > 0) ctx.secrets.add(raw);
  if (key.length > 0) ctx.secrets.add(key);
  if (!INSTALL_KEY_PATTERN.test(key)) throw new InstallerError(KEY_MALFORMED);
  return key;
}

type Attempt =
  | { kind: "transient"; detail: string }
  | { kind: "http"; status: number }
  | { kind: "answered"; body: unknown };

const INVALID_JSON = Symbol("invalid-json");

/**
 * One `POST /device/enroll` and its body read, bounded by `ms` on the
 * context's timer. The request is aborted when the bound passes.
 */
async function attempt(ctx: Context, server: string, body: unknown, ms: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = startTimer(ctx, ms);
  const work = (async (): Promise<Attempt> => {
    let response: Response;
    try {
      response = await ctx.fetch(`${server}/device/enroll`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return { kind: "transient", detail: `could not reach ${server}` };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: "transient", detail: `the server answered ${response.status}` };
    }
    if (!response.ok) return { kind: "http", status: response.status };
    try {
      return { kind: "answered", body: await response.json() };
    } catch {
      return controller.signal.aborted
        ? { kind: "transient", detail: "the request timed out" }
        : { kind: "answered", body: INVALID_JSON };
    }
  })();
  const timedOut = timer.promise.then(
    (): Attempt => ({ kind: "transient", detail: "the request timed out" }),
  );
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    timer.cancel();
    controller.abort();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Connects `harnesses` with one `POST /device/enroll` (overlay-install-keys
 * §Installer; AC-2.1, AC-2.4). A network failure, 429, or 5xx answer is
 * retried every 2 seconds, and no attempt starts once 2 minutes have passed
 * since the first. `enrolled` goes through the same checks as an approved
 * short-code result; every other status exits with status 1 and a message
 * naming it (AC-2.2). No code is shown and nothing waits for approval.
 */
export async function enroll(
  ctx: Context,
  server: string,
  installKey: string,
  harnesses: readonly HarnessId[],
): Promise<Connection[]> {
  ctx.secrets.add(installKey);
  const request = { install_key: installKey, machine_name: machineName(ctx), harnesses };
  const deadline = ctx.now() + ENROLL_RETRY_LIMIT_MS;
  for (;;) {
    const remaining = deadline - ctx.now();
    const result = await attempt(
      ctx,
      server,
      request,
      Math.min(ENROLL_ATTEMPT_TIMEOUT_MS, remaining),
    );
    if (result.kind === "transient") {
      if (ctx.now() < deadline) await ctx.sleep(POLL_INTERVAL_MS);
      if (ctx.now() >= deadline) {
        throw new InstallerError(
          `AgentDesk at ${server} did not complete the enrollment within 2 minutes (${result.detail}). Run the installer again.`,
        );
      }
      continue;
    }
    if (result.kind === "http") {
      throw new InstallerError(
        `AgentDesk at ${server} answered ${result.status} to the enrollment request. Nothing was connected.`,
      );
    }
    return enrolled(ctx, server, installKey, harnesses, result.body);
  }
}

function enrolled(
  ctx: Context,
  server: string,
  installKey: string,
  harnesses: readonly HarnessId[],
  body: unknown,
): Connection[] {
  const invalidStatus = () =>
    new InstallerError(`AgentDesk at ${server} returned an invalid enrollment status.`);
  if (!isRecord(body)) throw invalidStatus();
  switch (body.status) {
    case "enrolled":
      break;
    case "unknown":
    case "revoked":
    case "expired":
    case "limit_reached":
      throw new InstallerError(ENROLL_REFUSALS[body.status]);
    case "harness_not_allowed":
      throw new InstallerError(harnessNotAllowed(ctx, body.harness, harnesses));
    default:
      throw invalidStatus();
  }
  // Register every token before validation so no error path can print one.
  if (Array.isArray(body.connections)) {
    for (const item of body.connections) {
      if (isRecord(item) && typeof item.token === "string") ctx.secrets.add(item.token);
    }
  }
  const invalid = () =>
    new InvalidSignInResult(
      server,
      // A token equal to the install key is never sent or stored as a connection token.
      reportedConnections(body.connections).map(({ token, ...rest }) =>
        token === installKey ? rest : { ...rest, ...(token !== undefined ? { token } : {}) },
      ),
      "enrollment result",
    );
  let connections: Connection[];
  try {
    connections = validateConnections(server, body.connections, harnesses);
  } catch (error) {
    if (error instanceof InvalidSignInResult) throw invalid();
    throw error;
  }
  if (connections.some((c) => c.token === installKey)) throw invalid();
  return connections;
}
