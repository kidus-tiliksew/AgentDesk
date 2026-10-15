import { readMcpEntry } from "../config.js";
import { type Context, InstallerError, startTimer } from "../context.js";
import { type HarnessId, harnessById } from "../harnesses.js";
import { readState, recordedServer } from "../state.js";
import { SseParser } from "./sse.js";
import { ResumeStore } from "./storage.js";

// component-resume §Waiter and §Resume message. The waiter waits on one
// decision through `POST /device/wait` (component-gateway §Waiter endpoint),
// which opens no MCP session, and resumes the asking session once when the
// decision settles outside the chat (DEC-15(2), DEC-15(6)).

/** The `timeout_seconds` every wait request sends. */
export const WAIT_TIMEOUT_SECONDS = 600;
/** Delay before retrying a network failure, a 5xx, or a stream without its event. */
export const RETRY_DELAY_MS = 15_000;
/**
 * A request still open this long after it started is abandoned and retried.
 * The gateway answers within `timeout_seconds` and sends a keepalive every 15
 * seconds, so only a lost connection reaches this bound.
 */
export const REQUEST_LIMIT_MS = (WAIT_TIMEOUT_SECONDS + 60) * 1000;

/** The fields of the contract's Decision that decide a resume. */
export interface SettledDecision {
  id: string;
  state: string;
  answered_via: string | null;
  applied_by_default: boolean;
}

/** The message that resumes a session. It never carries the answer (DEC-15(7)). */
export function resumeMessage(decisionId: string): string {
  return `AgentDesk decision ${decisionId} settled. Read it with check, tell the user the answer and where it was given, then act on it.`;
}

/**
 * Whether a settled decision resumes its session: answered on a surface other
 * than chat, or expired with its default applied (DEC-15(6); AC-12.1 to
 * AC-12.3). A chat relay, a cancel, and every other settlement resume nothing.
 */
export function resumes(decision: SettledDecision): boolean {
  if (decision.state === "answered") return decision.answered_via !== "chat";
  if (decision.state === "expired") return decision.applied_by_default === true;
  return false;
}

export type WaitOutcome =
  | { kind: "settled"; decision: SettledDecision }
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "refused"; detail: string }
  | { kind: "aborted" };

type Attempt = WaitOutcome | { kind: "pending" } | { kind: "retry"; detail: string };

export interface WaitTarget {
  server: string;
  token: string;
  decisionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one `message` event's JSON into an attempt result. */
export function classifyEvent(data: string, decisionId: string): Attempt {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "refused", detail: "the server sent an answer the waiter cannot read" };
  }
  if (!isRecord(value)) {
    return { kind: "refused", detail: "the server sent an answer the waiter cannot read" };
  }
  if (isRecord(value.decision)) {
    const d = value.decision;
    if (typeof d.id !== "string" || typeof d.state !== "string") {
      return { kind: "refused", detail: "the server sent a decision the waiter cannot read" };
    }
    if (d.id !== decisionId) {
      return { kind: "refused", detail: "the server answered for another decision" };
    }
    if (d.state === "pending") return { kind: "pending" };
    return {
      kind: "settled",
      decision: {
        id: d.id,
        state: d.state,
        answered_via: typeof d.answered_via === "string" ? d.answered_via : null,
        applied_by_default: d.applied_by_default === true,
      },
    };
  }
  if (value.state === "pending") return { kind: "pending" };
  if (isRecord(value.error)) {
    const code = value.error.code;
    if (code === "not_found") return { kind: "not_found" };
    if (code === "unavailable") return { kind: "retry", detail: "the server was unavailable" };
    if (code === "unauthenticated") return { kind: "revoked" };
    return {
      kind: "refused",
      detail: `the server refused the wait (${typeof code === "string" ? code : "unknown error"})`,
    };
  }
  return { kind: "refused", detail: "the server sent an answer the waiter cannot read" };
}

/** One `POST /device/wait` request, read until its `message` event. */
export async function requestWait(
  ctx: Context,
  target: WaitTarget,
  signal: AbortSignal,
): Promise<Attempt> {
  if (signal.aborted) return { kind: "aborted" };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);
  const limit = startTimer(ctx, REQUEST_LIMIT_MS);
  limit.promise.then(onAbort);
  const failed = (detail: string): Attempt =>
    signal.aborted ? { kind: "aborted" } : { kind: "retry", detail };
  try {
    let response: Response;
    try {
      response = await ctx.fetch(`${target.server}/device/wait`, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${target.token}`,
        },
        body: JSON.stringify({
          decision_id: target.decisionId,
          timeout_seconds: WAIT_TIMEOUT_SECONDS,
        }),
        signal: controller.signal,
      });
    } catch {
      return failed("the server could not be reached");
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) return { kind: "revoked" };
      if (response.status >= 500) return failed(`the server answered ${response.status}`);
      return { kind: "refused", detail: `the server answered ${response.status}` };
    }
    if (!response.body) return failed("the server sent no event stream");
    const reader = response.body.getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          return failed("the event stream was interrupted");
        }
        const events = chunk.done ? parser.end() : parser.push(chunk.value);
        const message = events.find((event) => event.event === "message");
        if (message) return classifyEvent(message.data, target.decisionId);
        if (chunk.done) return failed("the event stream ended without its event");
      }
    } catch {
      return { kind: "refused", detail: "the server sent an event stream the waiter cannot read" };
    } finally {
      reader.cancel().catch(() => {});
    }
  } finally {
    limit.cancel();
    signal.removeEventListener("abort", onAbort);
  }
}

/** Waits `ms` on the context's clock; resolves false when `signal` aborts first. */
export function delay(ctx: Context, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const timer = startTimer(ctx, ms);
  return new Promise((resolve) => {
    const onAbort = () => {
      timer.cancel();
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    });
  });
}

/**
 * Calls `POST /device/wait` until the decision is no longer pending. A network
 * failure, a 5xx, an `unavailable` event, or a stream that ends without its
 * event is retried after 15 seconds.
 */
export async function watchDecision(
  ctx: Context,
  target: WaitTarget,
  signal: AbortSignal,
): Promise<WaitOutcome> {
  for (;;) {
    const attempt = await requestWait(ctx, target, signal);
    if (attempt.kind === "pending") continue;
    if (attempt.kind === "retry") {
      if (!(await delay(ctx, RETRY_DELAY_MS, signal))) return { kind: "aborted" };
      continue;
    }
    return attempt;
  }
}

/**
 * The harness's connection token, read from its MCP entry as the re-run reads
 * it, and the server recorded for it. The token joins the redaction set before
 * anything can print.
 */
export function readCredentials(ctx: Context, id: HarnessId): { server: string; token: string } {
  const harness = harnessById(ctx, id);
  const state = readState(ctx);
  const server = state ? recordedServer(state, id) : undefined;
  if (!server) {
    throw new InstallerError(
      `AgentDesk is not installed for ${harness.displayName}. Run agentdesk install.`,
    );
  }
  const entry = readMcpEntry(ctx, harness);
  if (entry.token) ctx.secrets.add(entry.token);
  if (!entry.token) {
    throw new InstallerError(
      `${harness.displayName} has no AgentDesk connection. Run agentdesk install.`,
    );
  }
  return { server, token: entry.token };
}

export interface WaitOptions {
  harness: HarnessId;
  decisionId: string;
  codexThread?: string;
}

/**
 * Prints the resume message, or with a Codex thread queues it with
 * `codex queue` and returns that command's status (DEC-15(3), DEC-15(4)).
 * The command's output is captured and never shown.
 */
export async function deliverResume(
  ctx: Context,
  decisionId: string,
  codexThread: string | undefined,
): Promise<number> {
  const message = resumeMessage(decisionId);
  if (codexThread === undefined) {
    ctx.io.out(message);
    return 0;
  }
  try {
    const result = await ctx.run("codex", ["queue", "--thread", codexThread, "--message", message]);
    return result.code;
  } catch {
    ctx.io.err("codex queue could not be started.");
    return 1;
  }
}

/** `agentdesk wait --harness <id> [--codex-thread <thread>] <decision-id>`. */
export async function runWait(ctx: Context, options: WaitOptions): Promise<number> {
  const { server, token } = readCredentials(ctx, options.harness);
  const store = new ResumeStore(ctx);
  store.cleanupClaims(ctx.now());
  const outcome = await watchDecision(
    ctx,
    { server, token, decisionId: options.decisionId },
    new AbortController().signal,
  );
  switch (outcome.kind) {
    case "revoked":
      ctx.io.err(
        `The AgentDesk connection for ${harnessById(ctx, options.harness).displayName} was revoked. Run agentdesk install to sign in again.`,
      );
      return 1;
    case "refused":
      ctx.io.err(`agentdesk wait stopped: ${outcome.detail}.`);
      return 1;
    case "not_found":
    case "aborted":
      return 0;
    case "settled":
      if (!resumes(outcome.decision)) return 0;
      // AC-12.4: of all waiters and holds on the machine, one resumes.
      if (!store.claim(options.decisionId)) return 0;
      return await deliverResume(ctx, options.decisionId, options.codexThread);
  }
}
