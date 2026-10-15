import { type Context, startTimer } from "../context.js";
import type { HookAdapters } from "./process.js";
import { isSafeId, ResumeStore } from "./storage.js";
import { readCredentials, resumeMessage, resumes, watchDecision } from "./waiter.js";

// component-resume §Cursor hooks. `after-mcp` records each `ask` result's
// decision against its conversation; `stop` holds while a recorded decision is
// pending, for at most 50 minutes, and returns the resume message as
// `followup_message` (DEC-15(5); AC-12.6).

/** A hold prints `{}` this long after it starts. */
export const CURSOR_HOLD_LIMIT_MS = 50 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The conversation and decision of an `afterMCPExecution` input for the
 * `agentdesk` `ask` tool: `decision_id` from the JSON text of `result_json`'s
 * first content item.
 */
export function parseAfterMcpInput(
  text: string | undefined,
): { conversationId: string; decisionId: string } | undefined {
  const input = parseObject(text);
  if (!input) return undefined;
  if (input.mcp_server_name !== "agentdesk" || input.tool_name !== "ask") return undefined;
  if (!isSafeId(input.conversation_id)) return undefined;
  const result =
    typeof input.result_json === "string" ? parseObject(input.result_json) : input.result_json;
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const first: unknown = result.content[0];
  if (!isRecord(first) || typeof first.text !== "string") return undefined;
  const payload = parseObject(first.text);
  if (!payload || !isSafeId(payload.decision_id)) return undefined;
  return { conversationId: input.conversation_id, decisionId: payload.decision_id };
}

/** `agentdesk hook after-mcp --harness cursor`. Prints `{}` on every path. */
export async function runCursorAfterMcp(ctx: Context, adapters: HookAdapters): Promise<number> {
  try {
    const record = parseAfterMcpInput(await adapters.readInput());
    if (record) {
      new ResumeStore(ctx).recordCursorDecision(record.conversationId, record.decisionId);
    }
  } catch {
    // A record that cannot be written leaves the turn as it is.
  }
  ctx.io.out("{}");
  return 0;
}

/**
 * Holds on the conversation's recorded decisions. Returns the resume message
 * of the first decision that resumes and wins its claim, or undefined when
 * none does within the limit.
 */
export async function cursorHold(
  ctx: Context,
  adapters: HookAdapters,
): Promise<string | undefined> {
  // The 50-minute bound counts from the hold's start and covers reading the
  // input, retries, and requests in flight.
  const limit = startTimer(ctx, CURSOR_HOLD_LIMIT_MS);
  const stop = new AbortController();
  limit.promise.then(() => stop.abort());
  // The winner is set in the same synchronous step as its claim, so a claim
  // made just before the limit still delivers.
  const result: { winner?: string } = {};
  try {
    const work = holdWork(ctx, adapters, stop.signal, result);
    work.catch(() => {});
    await Promise.race([work, limit.promise]);
  } finally {
    stop.abort();
    limit.cancel();
  }
  return result.winner === undefined ? undefined : resumeMessage(result.winner);
}

async function holdWork(
  ctx: Context,
  adapters: HookAdapters,
  signal: AbortSignal,
  result: { winner?: string },
): Promise<void> {
  const input = parseObject(await adapters.readInput());
  if (input?.status !== "completed" || !isSafeId(input.conversation_id)) return;
  const conversationId = input.conversation_id;
  const store = new ResumeStore(ctx);
  store.cleanupCursorRecords(ctx.now());
  const decisionIds = store.cursorDecisions(conversationId);
  if (decisionIds.length === 0 || signal.aborted) return;
  const { server, token } = readCredentials(ctx, "cursor");

  // Each decision is watched on its own, so a pending one never delays
  // another's settlement. The first that resumes and wins its claim ends the
  // hold and stops the others.
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
          // This decision ends without a follow-up; the others continue.
        }
      }),
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    local.abort();
  }
}

/**
 * `agentdesk hook stop --harness cursor`. Prints `{"followup_message": ...}`
 * for a decision that resumes, otherwise `{}`, on every path.
 */
export async function runCursorStop(ctx: Context, adapters: HookAdapters): Promise<number> {
  let message: string | undefined;
  try {
    message = await cursorHold(ctx, adapters);
  } catch {
    message = undefined;
  }
  ctx.io.out(JSON.stringify(message === undefined ? {} : { followup_message: message }));
  return 0;
}
