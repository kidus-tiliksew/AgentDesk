import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { type Context, startTimer } from "../context.js";
import { HookCancelledError, MAX_TRANSCRIPT_BYTES, openTranscript } from "./codex.js";
import type { HookAdapters } from "./process.js";
import { isSafeId, ResumeStore } from "./storage.js";
import { readCredentials, resumeMessage, resumes, watchDecision } from "./waiter.js";

// component-resume §Antigravity stop hook. `agentdesk hook stop --harness
// antigravity` runs as Antigravity's `Stop` hook with a 3600-second timeout
// (DEC-24(3)). Antigravity runs hooks synchronously, so the hook holds while
// an `ask` decision of the conversation is pending, for at most 50 minutes,
// and continues the loop with the resume message when one settles outside
// the chat (AC-12.9). It never reads `continuationActive`, which Antigravity
// reports as false after a continuation (DEC-24(4)): a resumed decision holds
// its claim and is never waited on again.

/** A hold prints `{}` this long after it starts (AC-12.9). */
export const ANTIGRAVITY_HOLD_LIMIT_MS = 50 * 60 * 1000;

/** The only `terminationReason` that holds: the agent ended its turn. */
const HOLDING_REASON = "NO_TOOL_CALL";
/** The tool through which Antigravity calls an MCP server's tool. */
const MCP_CALL_TOOL = "call_mcp_tool";
/** A result step's `content` larger than this names no decision. */
const MAX_RESULT_CONTENT = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface AntigravityStopInput {
  conversationId: string;
  transcriptPath: string;
  terminationReason: string;
}

/**
 * Reads `conversationId`, `transcriptPath`, and `terminationReason` from the
 * hook input. `continuationActive` and `executionNum` are never read.
 */
export function parseAntigravityStopInput(
  text: string | undefined,
): AntigravityStopInput | undefined {
  if (text === undefined) return undefined;
  const input = parseRecord(text);
  if (!input) return undefined;
  const { conversationId, transcriptPath, terminationReason } = input;
  if (!isSafeId(conversationId)) return undefined;
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)) return undefined;
  if (typeof terminationReason !== "string") return undefined;
  return { conversationId, transcriptPath, terminationReason };
}

/** The steps a transcript line can be, for matching an `ask` call to its result. */
type Step =
  /** A step whose only tool call is `call_mcp_tool` for the `agentdesk` `ask` tool. */
  | { kind: "ask-call" }
  /** A step that holds tool calls of any other shape, or more than one call. */
  | { kind: "other-call" }
  /** A step with text `content` and no tool calls: a possible result. */
  | { kind: "content"; content: string }
  | { kind: "other" };

function callArgs(call: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(call.args)) return call.args;
  return typeof call.args === "string" ? parseRecord(call.args) : undefined;
}

function isAgentDeskAsk(call: unknown): boolean {
  if (!isRecord(call) || call.name !== MCP_CALL_TOOL) return false;
  const args = callArgs(call);
  return args?.ServerName === "agentdesk" && args.ToolName === "ask";
}

/** Classifies one transcript line. */
export function classifyStep(line: string): Step {
  const step = parseRecord(line);
  if (!step) return { kind: "other" };
  const calls = step.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    // A step with several calls is followed by several results, and nothing
    // ties a result to its call, so such a step names no decision.
    return calls.length === 1 && isAgentDeskAsk(calls[0])
      ? { kind: "ask-call" }
      : { kind: "other-call" };
  }
  if (typeof step.content === "string") return { kind: "content", content: step.content };
  return { kind: "other" };
}

/**
 * The `decision_id` of the JSON object that ends a result step's `content`,
 * after any timestamp lines before it. Only an object that starts at the
 * beginning of a line and runs to the end of the content counts.
 */
export function resultDecisionId(content: string): string | undefined {
  if (content.length > MAX_RESULT_CONTENT) return undefined;
  const text = content.trimEnd();
  if (!text.endsWith("}")) return undefined;
  const lines = text.split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!lines[start]?.trimStart().startsWith("{")) continue;
    const result = parseRecord(lines.slice(start).join("\n"));
    if (result) return isSafeId(result.decision_id) ? result.decision_id : undefined;
  }
  return undefined;
}

/**
 * The distinct decisions of `agentdesk` `ask` results in an Antigravity
 * transcript, in order of appearance. A step whose only tool call is the
 * `agentdesk` `ask` call is followed by the step that holds its result, and
 * the JSON object at the end of that step's `content` names the decision. An
 * `ask` call followed by another call, or by no step, names nothing.
 * Aborting `signal` closes the reader and rejects with HookCancelledError.
 */
export async function scanAntigravityTranscript(
  path: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<string[]> {
  if (signal.aborted) throw new HookCancelledError();
  const fd = await openTranscript(path, signal);
  const ids = new Set<string>();
  const stream = createReadStream("", {
    fd,
    encoding: "utf8",
    start: 0,
    end: MAX_TRANSCRIPT_BYTES - 1,
    autoClose: true,
  });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  const stopReading = () => {
    lines.close();
    stream.destroy();
  };
  signal.addEventListener("abort", stopReading, { once: true });
  let afterAsk = false;
  try {
    for await (const line of lines) {
      if (signal.aborted) break;
      // Most lines are neither an `ask` call nor the line after one.
      if (!afterAsk && !line.includes(MCP_CALL_TOOL)) continue;
      const step = classifyStep(line);
      if (afterAsk && step.kind === "content") {
        const id = resultDecisionId(step.content);
        if (id) ids.add(id);
      }
      afterAsk = step.kind === "ask-call";
    }
  } finally {
    signal.removeEventListener("abort", stopReading);
    stopReading();
  }
  if (signal.aborted) throw new HookCancelledError();
  return [...ids];
}

/**
 * Holds on the transcript's `ask` decisions. Returns the resume message of
 * the first decision that resumes and wins its claim, or undefined when none
 * does within the limit or the input names nothing to hold on.
 */
export async function antigravityHold(
  ctx: Context,
  adapters: HookAdapters,
): Promise<{ message: string | undefined; expired: boolean }> {
  // The 50-minute bound counts from the hook's start and covers reading the
  // input and the transcript, retries, and requests in flight.
  const limit = startTimer(ctx, ANTIGRAVITY_HOLD_LIMIT_MS);
  const stop = new AbortController();
  let expired = false;
  limit.promise.then(() => {
    expired = true;
    stop.abort();
  });
  // The winner is set in the same synchronous step as its claim, so a claim
  // made just before the limit still delivers, and none is made after it.
  const result: { winner?: string } = {};
  try {
    const work = holdWork(ctx, adapters, stop.signal, result);
    work.catch(() => {});
    await Promise.race([work, limit.promise]);
  } finally {
    stop.abort();
    limit.cancel();
  }
  return {
    message: result.winner === undefined ? undefined : resumeMessage(result.winner),
    expired,
  };
}

async function holdWork(
  ctx: Context,
  adapters: HookAdapters,
  signal: AbortSignal,
  result: { winner?: string },
): Promise<void> {
  const input = parseAntigravityStopInput(await adapters.readInput(signal));
  if (!input || input.terminationReason !== HOLDING_REASON || signal.aborted) return;
  let found: string[];
  try {
    found = await scanAntigravityTranscript(input.transcriptPath, signal);
  } catch {
    return;
  }
  const store = new ResumeStore(ctx);
  // A claimed decision already resumed a session, or is resuming one now.
  const decisionIds = found.filter((id) => !store.hasClaim(id));
  if (decisionIds.length === 0 || signal.aborted) return;
  const { server, token } = readCredentials(ctx, "antigravity");

  // Each decision is watched on its own, so a pending one never delays
  // another's settlement. The first that resumes and wins its claim ends the
  // hold and stops the others. A decision that settles without resuming, or
  // whose claim another waiter or hold won, is dropped.
  const local = new AbortController();
  const onAbort = () => local.abort();
  signal.addEventListener("abort", onAbort);
  try {
    await Promise.all(
      decisionIds.map(async (decisionId) => {
        try {
          const outcome = await watchDecision(ctx, { server, token, decisionId }, local.signal);
          if (outcome.kind !== "settled" || !resumes(outcome.decision)) return;
          // Claiming is synchronous, so once one decision wins no other claims.
          if (result.winner !== undefined || local.signal.aborted) return;
          if (!store.claim(decisionId)) return;
          result.winner = decisionId;
          local.abort();
        } catch {
          // This decision ends without a continuation; the others continue.
        }
      }),
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    local.abort();
  }
}

/**
 * `agentdesk hook stop --harness antigravity`. Prints
 * `{"decision": "continue", "reason": <message>}` for a decision that
 * resumes, otherwise `{}`, and returns 0 on every path. When the limit
 * expires, the process exits once the output is written, so a request the
 * runtime cannot cancel does not hold Antigravity's loop until its timeout.
 */
export async function runAntigravityStop(ctx: Context, adapters: HookAdapters): Promise<number> {
  let message: string | undefined;
  let expired = false;
  try {
    ({ message, expired } = await antigravityHold(ctx, adapters));
  } catch {
    message = undefined;
  }
  ctx.io.out(
    JSON.stringify(message === undefined ? {} : { decision: "continue", reason: message }),
  );
  if (expired) adapters.exitAfterOutput?.(0);
  return 0;
}
