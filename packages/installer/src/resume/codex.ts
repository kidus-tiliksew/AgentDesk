import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { type Context, startTimer } from "../context.js";
import { agentdeskCommand, type HookAdapters } from "./process.js";
import { isSafeId, ResumeStore } from "./storage.js";

// component-resume §Codex stop hook. `agentdesk hook stop --harness codex`
// runs as Codex's `Stop` hook with a 10-second timeout. The turn stays active
// until it returns, so it never waits on a decision: it starts one detached
// waiter per `ask` decision without a live waiter and returns `{}`
// (DEC-15(4); AC-12.5).

/** The hook's own bound, under Codex's 10-second hook timeout. */
export const CODEX_HOOK_BUDGET_MS = 8000;
/** Transcript bytes scanned at most. */
export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
/** A start lock older than this was left by a hook that died. */
export const START_LOCK_STALE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The decision id of one transcript line when it records a completed
 * `agentdesk` `ask` call: `payload.type` `item_completed` and `payload.item`
 * with `type` `McpToolCall`, `server` `agentdesk`, `tool` `ask`, and `status`
 * `completed`.
 */
export function askDecisionId(line: string): string | undefined {
  // Most lines are other records; skip them without parsing.
  if (!line.includes("McpToolCall")) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || !isRecord(record.payload)) return undefined;
  const payload = record.payload;
  if (payload.type !== "item_completed" || !isRecord(payload.item)) return undefined;
  const item = payload.item;
  if (
    item.type !== "McpToolCall" ||
    item.server !== "agentdesk" ||
    item.tool !== "ask" ||
    item.status !== "completed" ||
    !isRecord(item.result) ||
    !isRecord(item.result.structuredContent)
  ) {
    return undefined;
  }
  const id = item.result.structuredContent.decision_id;
  return isSafeId(id) ? id : undefined;
}

/** The distinct `ask` decision ids in a Codex transcript, in order of appearance. */
export async function scanCodexTranscript(path: string): Promise<string[]> {
  const ids = new Set<string>();
  const stream = createReadStream(path, { encoding: "utf8", end: MAX_TRANSCRIPT_BYTES - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const id = askDecisionId(line);
      if (id) ids.add(id);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...ids];
}

export interface CodexStopInput {
  sessionId: string;
  transcriptPath: string;
}

/** Reads `session_id`, the thread id, and `transcript_path` from the hook input. */
export function parseCodexStopInput(text: string | undefined): CodexStopInput | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { session_id: sessionId, transcript_path: transcriptPath } = value;
  if (!isSafeId(sessionId)) return undefined;
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)) return undefined;
  return { sessionId, transcriptPath };
}

/**
 * Starts a waiter for each decision without a live one. A per-decision start
 * lock makes the liveness check, the start, and the record one step, so
 * concurrent hooks start one waiter per decision.
 */
export async function startCodexWaiters(
  ctx: Context,
  adapters: HookAdapters,
  input: CodexStopInput,
  decisionIds: readonly string[],
): Promise<void> {
  const store = new ResumeStore(ctx);
  const { command, prefix } = agentdeskCommand(ctx);
  for (const decisionId of decisionIds) {
    let release: (() => void) | undefined;
    try {
      release = store.lockWaiterStart(decisionId, ctx.now(), START_LOCK_STALE_MS);
      // Another hook is starting this decision's waiter now.
      if (!release) continue;
      const recorded = store.waiterPid(decisionId);
      if (recorded !== undefined && adapters.isAlive(recorded)) continue;
      const pid = await adapters.launch(command, [
        ...prefix,
        "wait",
        "--harness",
        "codex",
        "--codex-thread",
        input.sessionId,
        decisionId,
      ]);
      store.recordWaiter(decisionId, pid);
    } catch {
      // A waiter that could not start is not recorded; the next Stop retries.
    } finally {
      release?.();
    }
  }
}

async function codexStopWork(ctx: Context, adapters: HookAdapters): Promise<void> {
  const input = parseCodexStopInput(await adapters.readInput());
  if (!input) return;
  let decisionIds: string[];
  try {
    decisionIds = await scanCodexTranscript(input.transcriptPath);
  } catch {
    return;
  }
  if (decisionIds.length === 0) return;
  await startCodexWaiters(ctx, adapters, input, decisionIds);
}

/**
 * `agentdesk hook stop --harness codex`. Prints `{}` and returns 0 on every
 * path, including bad input and an unreadable transcript, within the hook's
 * budget.
 */
export async function runCodexStop(ctx: Context, adapters: HookAdapters): Promise<number> {
  const budget = startTimer(ctx, CODEX_HOOK_BUDGET_MS);
  try {
    await Promise.race([codexStopWork(ctx, adapters).catch(() => {}), budget.promise]);
  } finally {
    budget.cancel();
  }
  ctx.io.out("{}");
  return 0;
}
