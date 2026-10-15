import { close, constants, createReadStream, fstat, open, type Stats, stat } from "node:fs";
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

/** The scan or start stopped because the hook's budget expired. */
export class HookCancelledError extends Error {
  constructor() {
    super("the hook's budget expired");
    this.name = "HookCancelledError";
  }
}

/** The transcript path names something other than a regular file. */
export class TranscriptRefusedError extends Error {
  constructor() {
    super("the transcript is not a regular file");
    this.name = "TranscriptRefusedError";
  }
}

const statAsync = (path: string) =>
  new Promise<Stats>((resolve, reject) =>
    stat(path, (error, stats) => (error ? reject(error) : resolve(stats))),
  );
const fstatAsync = (fd: number) =>
  new Promise<Stats>((resolve, reject) =>
    fstat(fd, (error, stats) => (error ? reject(error) : resolve(stats))),
  );
const openAsync = (path: string, flags: number) =>
  new Promise<number>((resolve, reject) =>
    open(path, flags, (error, fd) => (error ? reject(error) : resolve(fd))),
  );

/**
 * Opens the transcript for reading only when it is a regular file. `stat`
 * refuses a FIFO, device, socket, or directory before any open, so nothing
 * waits for a writer. The open itself is non-blocking, so a path swapped for
 * a FIFO after the check still opens at once, and `fstat` on the open file
 * refuses it unless it is the same regular file.
 */
async function openTranscript(path: string, signal: AbortSignal): Promise<number> {
  const before = await statAsync(path);
  if (!before.isFile()) throw new TranscriptRefusedError();
  if (signal.aborted) throw new HookCancelledError();
  const fd = await openAsync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (signal.aborted) throw new HookCancelledError();
    const opened = await fstatAsync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TranscriptRefusedError();
    }
    if (signal.aborted) throw new HookCancelledError();
    return fd;
  } catch (error) {
    close(fd, () => {});
    throw error;
  }
}

/**
 * The distinct `ask` decision ids in a Codex transcript, in order of
 * appearance. Aborting `signal` closes the reader and rejects with
 * HookCancelledError. `onLine` sees each line before it is read, so a test
 * can abort at a known point of the scan.
 */
export async function scanCodexTranscript(
  path: string,
  signal: AbortSignal = new AbortController().signal,
  onLine?: (line: string) => void,
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
  try {
    for await (const line of lines) {
      if (signal.aborted) break;
      onLine?.(line);
      if (signal.aborted) break;
      const id = askDecisionId(line);
      if (id) ids.add(id);
    }
  } finally {
    signal.removeEventListener("abort", stopReading);
    stopReading();
  }
  if (signal.aborted) throw new HookCancelledError();
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
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const store = new ResumeStore(ctx);
  const { command, prefix } = agentdeskCommand(ctx);
  for (const decisionId of decisionIds) {
    // No waiter starts once the hook's budget has expired.
    if (signal.aborted) return;
    let release: (() => void) | undefined;
    try {
      release = store.lockWaiterStart(decisionId, ctx.now(), START_LOCK_STALE_MS);
      // Another hook is starting this decision's waiter now.
      if (!release) continue;
      const recorded = store.waiterPid(decisionId);
      if (recorded !== undefined && adapters.isAlive(recorded)) continue;
      if (signal.aborted) return;
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

async function codexStopWork(
  ctx: Context,
  adapters: HookAdapters,
  signal: AbortSignal,
): Promise<void> {
  const input = parseCodexStopInput(await adapters.readInput(signal));
  if (!input || signal.aborted) return;
  let decisionIds: string[];
  try {
    decisionIds = await scanCodexTranscript(input.transcriptPath, signal);
  } catch {
    return;
  }
  if (decisionIds.length === 0) return;
  await startCodexWaiters(ctx, adapters, input, decisionIds, signal);
}

/**
 * `agentdesk hook stop --harness codex`. Prints `{}` and returns 0 on every
 * path, including bad input and an unreadable transcript, within the hook's
 * budget. When the budget expires, the input read and the transcript reader
 * are closed and no further waiter starts; the hook then prints `{}` and asks
 * the process to exit, so a request still pending in the runtime cannot keep
 * it alive until Codex's 10-second timeout.
 */
export async function runCodexStop(ctx: Context, adapters: HookAdapters): Promise<number> {
  const budget = startTimer(ctx, CODEX_HOOK_BUDGET_MS);
  const stop = new AbortController();
  let expired = false;
  budget.promise.then(() => {
    expired = true;
    stop.abort();
  });
  try {
    await Promise.race([codexStopWork(ctx, adapters, stop.signal).catch(() => {}), budget.promise]);
  } finally {
    budget.cancel();
    stop.abort();
  }
  ctx.io.out("{}");
  if (expired) adapters.exitAfterOutput?.(0);
  return 0;
}
