import { type Context, InstallerError } from "./context.js";
import { MAX_CODES_NONINTERACTIVE, POLL_INTERVAL_MS } from "./defaults.js";
import type { HarnessId } from "./harnesses.js";

export const CODE_INSTRUCTION =
  "Open AgentDesk on your phone, choose Add machine, and enter this code";
export const DECLINED_MESSAGE = "Sign-in was declined in the app";

export interface Connection {
  harness: HarnessId;
  connectionId: string;
  token: string;
}

interface Started {
  userCode: string;
  deviceSecret: string;
  expiresInMs: number;
}

type PollOutcome =
  | { kind: "approved"; connections: Connection[] }
  | { kind: "declined" }
  | { kind: "expired" };

const NETWORK_FAILURE = Symbol("network");

async function request(
  ctx: Context,
  server: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Response | typeof NETWORK_FAILURE> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  try {
    return await ctx.fetch(`${server}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return NETWORK_FAILURE;
  }
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats an 8-character code as XXXX-XXXX (AC-6.1). */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function machineName(ctx: Context): string {
  const name = ctx.hostname.trim();
  return (name.length > 0 ? name : "unknown machine").slice(0, 255);
}

async function start(
  ctx: Context,
  server: string,
  harnesses: readonly HarnessId[],
): Promise<Started> {
  const response = await request(ctx, server, "POST", "/device/start", {
    body: { machine_name: machineName(ctx), harnesses },
  });
  if (response === NETWORK_FAILURE)
    throw new InstallerError(`Could not reach AgentDesk at ${server}.`);
  if (response.status === 429) {
    throw new InstallerError(
      "Too many sign-in requests from this network. Wait a minute, then run again.",
    );
  }
  if (!response.ok) {
    throw new InstallerError(
      `AgentDesk at ${server} answered ${response.status} to the sign-in request.`,
    );
  }
  const body = await jsonBody(response);
  if (
    !isRecord(body) ||
    typeof body.user_code !== "string" ||
    !/^[0-9A-Z]{8}$/.test(body.user_code) ||
    typeof body.device_secret !== "string" ||
    body.device_secret.length === 0
  ) {
    throw new InstallerError(`AgentDesk at ${server} returned an invalid sign-in request.`);
  }
  ctx.secrets.add(body.device_secret);
  const expiresIn =
    typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 600;
  return {
    userCode: body.user_code,
    deviceSecret: body.device_secret,
    expiresInMs: expiresIn * 1000,
  };
}

/**
 * Checks an approved result: exactly one connection per requested harness,
 * each with its own connection id and token (AC-6.4).
 */
/** A connection the server reported as issued, as far as it can be read. */
export interface ReportedConnection {
  harness?: string;
  connectionId?: string;
  token?: string;
}

/**
 * An approved result the installer cannot use. The server may still have
 * issued the connections it lists, so they travel with the error for the
 * caller to revoke or record (AC-9.6).
 */
export class InvalidSignInResult extends InstallerError {
  constructor(
    server: string,
    readonly reported: ReportedConnection[],
  ) {
    super(`AgentDesk at ${server} returned an invalid sign-in result.`);
  }
}

function reportedConnections(raw: unknown): ReportedConnection[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => ({
    ...(typeof item.harness === "string" ? { harness: item.harness } : {}),
    ...(typeof item.connection_id === "string" && item.connection_id.length > 0
      ? { connectionId: item.connection_id }
      : {}),
    ...(typeof item.token === "string" && item.token.length > 0 && !/\s/.test(item.token)
      ? { token: item.token }
      : {}),
  }));
}

function validateConnections(
  server: string,
  raw: unknown,
  requested: readonly HarnessId[],
): Connection[] {
  const invalid = () => new InvalidSignInResult(server, reportedConnections(raw));
  if (!Array.isArray(raw) || raw.length !== requested.length) throw invalid();
  const connections: Connection[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.harness !== "string" ||
      typeof item.connection_id !== "string" ||
      item.connection_id.length === 0 ||
      typeof item.token !== "string" ||
      item.token.length === 0 ||
      /\s/.test(item.token)
    ) {
      throw invalid();
    }
    const harness = requested.find((id) => id === item.harness);
    if (!harness) throw invalid();
    connections.push({ harness, connectionId: item.connection_id, token: item.token });
  }
  const distinct = (values: string[]) => new Set(values).size === values.length;
  if (
    !distinct(connections.map((c) => c.harness)) ||
    !distinct(connections.map((c) => c.connectionId)) ||
    !distinct(connections.map((c) => c.token))
  ) {
    throw invalid();
  }
  return requested.map((id) => connections.find((c) => c.harness === id) as Connection);
}

async function poll(
  ctx: Context,
  server: string,
  started: Started,
  requested: readonly HarnessId[],
): Promise<PollOutcome> {
  const deadline = ctx.now() + started.expiresInMs;
  for (;;) {
    await ctx.sleep(POLL_INTERVAL_MS);
    const response = await request(ctx, server, "POST", "/device/poll", {
      body: { device_secret: started.deviceSecret },
    });
    // A dropped connection, a rate limit, or a server error is retried until the code expires.
    const transient =
      response === NETWORK_FAILURE || response.status === 429 || response.status >= 500;
    if (!transient) {
      if (!response.ok) {
        throw new InstallerError(
          `AgentDesk at ${server} answered ${response.status} while waiting for approval.`,
        );
      }
      const body = await jsonBody(response);
      if (isRecord(body) && Array.isArray(body.connections)) {
        // Register every token before validation so no error path can print one.
        for (const item of body.connections) {
          if (isRecord(item) && typeof item.token === "string") ctx.secrets.add(item.token);
        }
      }
      const status = isRecord(body) ? body.status : undefined;
      switch (status) {
        case "approved":
          return {
            kind: "approved",
            connections: validateConnections(
              server,
              isRecord(body) ? body.connections : undefined,
              requested,
            ),
          };
        case "declined":
          return { kind: "declined" };
        case "expired":
          return { kind: "expired" };
        case "pending":
          break;
        case "not_found":
          throw new InstallerError(
            "The sign-in request is no longer valid. Run the installer again.",
          );
        default:
          throw new InstallerError(`AgentDesk at ${server} returned an invalid sign-in status.`);
      }
    }
    if (ctx.now() >= deadline) return { kind: "expired" };
  }
}

/**
 * Short-code sign-in from the machine (component-installer §Sign-in;
 * req-accounts-and-connections REQ-6). Prints the code, polls every two
 * seconds, and returns one connection per harness. The user types no
 * credential, and no browser opens (AC-9.7).
 *
 * On expiry, an interactive session asks before requesting a new code. A
 * noninteractive session requests new codes automatically, up to
 * MAX_CODES_NONINTERACTIVE codes in total, then fails.
 */
export async function signIn(
  ctx: Context,
  server: string,
  harnesses: readonly HarnessId[],
): Promise<Connection[]> {
  let codes = 0;
  for (;;) {
    codes++;
    const started = await start(ctx, server, harnesses);
    ctx.io.out("");
    ctx.io.out(`  ${formatCode(started.userCode)}`);
    ctx.io.out("");
    ctx.io.out(CODE_INSTRUCTION);
    ctx.io.out("Waiting for approval...");
    const outcome = await poll(ctx, server, started, harnesses);
    if (outcome.kind === "approved") return outcome.connections;
    if (outcome.kind === "declined") throw new InstallerError(DECLINED_MESSAGE, 1);
    ctx.io.out("The code expired.");
    if (ctx.io.prompt) {
      const answer = (
        await ctx.io.prompt("Press Enter for a new code, or type q to stop: ")
      ).trim();
      if (answer.toLowerCase().startsWith("q")) {
        throw new InstallerError("Sign-in stopped. No harness was connected.");
      }
    } else if (codes >= MAX_CODES_NONINTERACTIVE) {
      throw new InstallerError(
        `The code expired ${codes} times. Run the installer again when you can approve it.`,
      );
    }
    ctx.io.out("Requesting a new code.");
  }
}

export type ConnectionCheck =
  | { kind: "ok" }
  | { kind: "refused"; status: number }
  | { kind: "failed"; detail: string };

/** `GET /device/connection` with the harness's token (component-gateway §Routes). */
export async function checkConnection(
  ctx: Context,
  server: string,
  token: string,
): Promise<ConnectionCheck> {
  ctx.secrets.add(token);
  const response = await request(ctx, server, "GET", "/device/connection", { token });
  if (response === NETWORK_FAILURE) return { kind: "failed", detail: `could not reach ${server}` };
  if (response.status === 200) return { kind: "ok" };
  if (response.status === 401 || response.status === 403)
    return { kind: "refused", status: response.status };
  return { kind: "failed", detail: `the server answered ${response.status}` };
}

export type RevokeResult = { kind: "revoked" } | { kind: "failed"; detail: string };

/**
 * `DELETE /device/connection` with the harness's token. A 401 means the
 * server no longer accepts the token, so nothing remains to revoke.
 */
export async function revokeConnection(
  ctx: Context,
  server: string,
  token: string,
): Promise<RevokeResult> {
  ctx.secrets.add(token);
  const response = await request(ctx, server, "DELETE", "/device/connection", { token });
  if (response === NETWORK_FAILURE) return { kind: "failed", detail: `could not reach ${server}` };
  if (response.ok || response.status === 401) return { kind: "revoked" };
  return { kind: "failed", detail: `the server answered ${response.status}` };
}
