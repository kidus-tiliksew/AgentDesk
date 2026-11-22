import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { type Context, startTimer } from "../context.js";
import { HookCancelledError, openTranscript } from "./codex.js";
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
/**
 * A transcript line longer than this is never held in memory. It is read past
 * and counts as a step that is neither an `ask` call nor its result. An `ask`
 * call and its result are a few kilobytes, so such a line never hides one.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** The size of each read from the transcript. */
const READ_CHUNK_BYTES = 1024 * 1024;

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

/**
 * The step types of the observed transcript shape (DEC-24(3)): the agent's
 * `PLANNER_RESPONSE` step holds the tool call, and the `GENERIC` step right
 * after it holds the tool's result. A step's type is its `type` field.
 */
export const CALL_STEP_TYPE = "PLANNER_RESPONSE";
export const RESULT_STEP_TYPE = "GENERIC";

/** The steps a transcript line can be, for matching an `ask` call to its result. */
type Step =
  /**
   * A `PLANNER_RESPONSE` step whose only tool call is `call_mcp_tool` for the
   * `agentdesk` `ask` tool.
   */
  | { kind: "ask-call"; index: number | undefined }
  /**
   * A `GENERIC` step with text `content` and no tool calls: the only kind of
   * step that can hold a tool's result.
   */
  | { kind: "result"; index: number | undefined; content: string }
  /**
   * Every other step: another tool call, a call beside others, the user's
   * input, the agent's text, or a line that is not a step. None of these
   * holds an `ask` result.
   */
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

function stepIndex(step: Record<string, unknown>): number | undefined {
  return Number.isSafeInteger(step.step_index) ? (step.step_index as number) : undefined;
}

/** Classifies one transcript line. */
export function classifyStep(line: string): Step {
  const step = parseRecord(line);
  if (!step) return { kind: "other" };
  const calls = step.tool_calls;
  const hasCalls = Array.isArray(calls) && calls.length > 0;
  if (step.type === CALL_STEP_TYPE && hasCalls) {
    // A step with several calls is followed by several results, and nothing
    // ties a result to its call, so such a step names no decision.
    return calls.length === 1 && isAgentDeskAsk(calls[0])
      ? { kind: "ask-call", index: stepIndex(step) }
      : { kind: "other" };
  }
  // A step that holds a call, or that is not a GENERIC step, is never a
  // result, so the user's input and the agent's own text cannot name a
  // decision (component-resume §Antigravity stop hook).
  if (step.type === RESULT_STEP_TYPE && !hasCalls && typeof step.content === "string") {
    return { kind: "result", index: stepIndex(step), content: step.content };
  }
  return { kind: "other" };
}

/** The keys of the `ask` tool's result (apps/gateway/src/tools.ts). */
const ASK_RESULT_KEYS = ["decision_id", "state"];

/**
 * The `decision_id` of the `ask` result that ends a result step's `content`,
 * after the timestamp lines before it. The result is the JSON object that the
 * gateway's `ask` tool returns, `{"decision_id": <id>, "state": "pending"}`,
 * with no other key. It starts at the beginning of a line and runs to the end
 * of the content. Any other text names no decision.
 */
export function resultDecisionId(content: string): string | undefined {
  if (content.length > MAX_RESULT_CONTENT) return undefined;
  const text = content.trimEnd();
  if (!text.endsWith("}")) return undefined;
  const lines = text.split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!lines[start]?.trimStart().startsWith("{")) continue;
    const result = parseRecord(lines.slice(start).join("\n"));
    if (!result) continue;
    const keys = Object.keys(result).sort();
    if (keys.length !== ASK_RESULT_KEYS.length || keys.some((k, i) => k !== ASK_RESULT_KEYS[i])) {
      return undefined;
    }
    if (result.state !== "pending") return undefined;
    return isSafeId(result.decision_id) ? result.decision_id : undefined;
  }
  return undefined;
}

function decodeLine(parts: readonly Buffer[]): string {
  const text = Buffer.concat(parts).toString("utf8");
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * Splits a byte stream into lines, holding at most one line of at most
 * `maxLineBytes` bytes in memory. Yields each line without its line ending,
 * or undefined for a line longer than `maxLineBytes`, whose bytes are read
 * past and dropped. A last line without a line ending is yielded too.
 */
export async function* transcriptLines(
  chunks: AsyncIterable<Buffer>,
  maxLineBytes = MAX_LINE_BYTES,
): AsyncGenerator<string | undefined> {
  let parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of chunks) {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!oversized && end > start) {
        if (size + (end - start) > maxLineBytes) {
          oversized = true;
          parts = [];
          size = 0;
        } else {
          parts.push(chunk.subarray(start, end));
          size += end - start;
        }
      }
      if (newline === -1) break;
      yield oversized ? undefined : decodeLine(parts);
      parts = [];
      size = 0;
      oversized = false;
      start = newline + 1;
    }
  }
  if (oversized) yield undefined;
  else if (size > 0) yield decodeLine(parts);
}

/**
 * The distinct decisions of `agentdesk` `ask` results in an Antigravity
 * transcript, in order of appearance. A `PLANNER_RESPONSE` step whose only
 * tool call is the `agentdesk` `ask` call is followed by the `GENERIC` step
 * that holds its result, and the `ask` result at the end of that step's
 * `content` names the decision. When both steps carry `step_index`, the
 * result's index is the call's index plus one. An `ask` call followed by any
 * other line, or by no line, names nothing.
 *
 * The scan reads the whole transcript to its end, however long it is, in
 * pieces of 1 MiB, so an `ask` late in a long conversation is found. Only the
 * hold's 50-minute limit bounds it (AC-12.9). Aborting `signal` closes the
 * reader and rejects with HookCancelledError.
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
    start: 0,
    highWaterMark: READ_CHUNK_BYTES,
    autoClose: true,
  });
  const stopReading = () => {
    stream.destroy();
  };
  signal.addEventListener("abort", stopReading, { once: true });
  // The `ask` call the previous line held, if it held one.
  let call: { index: number | undefined } | undefined;
  try {
    for await (const line of transcriptLines(stream as AsyncIterable<Buffer>)) {
      if (signal.aborted) break;
      // A line too long to hold is neither an `ask` call nor its result.
      if (line === undefined) {
        call = undefined;
        continue;
      }
      // Most lines are neither an `ask` call nor the line after one.
      if (!call && !line.includes(MCP_CALL_TOOL)) continue;
      const step = classifyStep(line);
      if (call && step.kind === "result" && follows(call.index, step.index)) {
        const id = resultDecisionId(step.content);
        if (id) ids.add(id);
      }
      call = step.kind === "ask-call" ? { index: step.index } : undefined;
    }
  } catch (error) {
    // A reader closed by the limit ends with an error of its own.
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", stopReading);
    stopReading();
  }
  if (signal.aborted) throw new HookCancelledError();
  return [...ids];
}

/** Whether a result's step index follows its call's, when both are known. */
function follows(callIndex: number | undefined, resultIndex: number | undefined): boolean {
  return callIndex === undefined || resultIndex === undefined || resultIndex === callIndex + 1;
}

/**
 * Holds on the transcript's `ask` decisions. Returns the resume message of
 * the first decision that resumes and wins its claim, or undefined when none
 * does within the limit or the input names nothing to hold on.
 */
export async function antigravityHold(
  ctx: Context,
  adapters: HookAdapters,
): Promise<{ message: string | undefined; cancelled: boolean }> {
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
    // The limit and a winning claim each abort waits that may still be open.
    cancelled: expired || result.winner !== undefined,
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
  // hold at once and aborts the others: the hold does not wait for them to
  // close, so a request that ignores its abort cannot delay the continuation.
  // A decision that settles without resuming, or whose claim another waiter
  // or hold won, is dropped. When none resumes, the hold ends once every
  // watch has ended.
  const local = new AbortController();
  const onAbort = () => local.abort();
  signal.addEventListener("abort", onAbort);
  let won: () => void = () => {};
  const winning = new Promise<void>((resolve) => {
    won = resolve;
  });
  try {
    const watches = Promise.all(
      decisionIds.map(async (decisionId) => {
        try {
          const outcome = await watchDecision(ctx, { server, token, decisionId }, local.signal);
          if (outcome.kind !== "settled" || !resumes(outcome.decision)) return;
          // Claiming is synchronous, so once one decision wins no other claims.
          if (result.winner !== undefined || local.signal.aborted) return;
          if (!store.claim(decisionId)) return;
          result.winner = decisionId;
          local.abort();
          won();
        } catch {
          // This decision ends without a continuation; the others continue.
        }
      }),
    );
    await Promise.race([watches, winning]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    local.abort();
  }
}

/**
 * `agentdesk hook stop --harness antigravity`. Prints
 * `{"decision": "continue", "reason": <message>}` for a decision that
 * resumes, otherwise `{}`, and returns 0 on every path. When the hold ends at
 * its limit or with a winning claim, it has aborted waits that may still be
 * open, so the process exits once the output is written: a request the
 * runtime cannot cancel does not keep the process, or Antigravity's loop,
 * waiting.
 */
export async function runAntigravityStop(ctx: Context, adapters: HookAdapters): Promise<number> {
  let message: string | undefined;
  let cancelled = false;
  try {
    ({ message, cancelled } = await antigravityHold(ctx, adapters));
  } catch {
    message = undefined;
  }
  ctx.io.out(
    JSON.stringify(message === undefined ? {} : { decision: "continue", reason: message }),
  );
  if (cancelled) adapters.exitAfterOutput?.(0);
  return 0;
}
