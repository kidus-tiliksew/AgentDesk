import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Context } from "../context.js";
import { runningExecutable } from "../guidance.js";

// Process adapters for the resume hooks: the hook input on standard input,
// process liveness, and the detached waiter start. Tests replace them.

/** The largest hook input the hooks read. */
export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
/** How long a hook waits for its input to end. */
export const HOOK_INPUT_TIMEOUT_MS = 3000;

export interface HookAdapters {
  /**
   * Reads the hook input; undefined when it is missing, too large, or late,
   * or when `signal` aborts first.
   */
  readInput(signal?: AbortSignal): Promise<string | undefined>;
  /** Whether a process with this id runs. */
  isAlive(pid: number): boolean;
  /** Starts `command` detached with standard streams closed and returns its process id. */
  launch(command: string, args: readonly string[]): Promise<number>;
  /**
   * Ends the process with `code` once its output is written. The Codex hook
   * calls it only after its budget expired, when a filesystem request the
   * runtime cannot cancel may still be pending.
   */
  exitAfterOutput?(code: number): void;
}

/** Reads standard input up to the size and time bounds, then stops reading it. */
export function readStdin(
  input: NodeJS.ReadStream = process.stdin,
  limit = MAX_HOOK_INPUT_BYTES,
  timeoutMs = HOOK_INPUT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      // Nothing more is read, and an open input must not keep the process alive.
      input.destroy();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limit) finish(undefined);
      else chunks.push(buffer);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(undefined);
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    if (signal?.aborted) {
      finish(undefined);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Spawns `command` detached in its own process group with every standard
 * stream closed, so it outlives the hook. Rejects when it cannot start.
 */
export function launchDetached(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { detached: true, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    if (child.pid === undefined) {
      child.once("error", reject);
      return;
    }
    // A later error has nowhere to go; the waiter's absence is the result.
    child.on("error", () => {});
    child.unref();
    resolve(child.pid);
  });
}

/** Exits once everything written to standard output has been flushed. */
export function exitAfterStdout(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

export const nodeHookAdapters: HookAdapters = {
  readInput: (signal) =>
    readStdin(process.stdin, MAX_HOOK_INPUT_BYTES, HOOK_INPUT_TIMEOUT_MS, signal),
  isAlive: processIsAlive,
  launch: launchDetached,
  exitAfterOutput: exitAfterStdout,
};

/**
 * The command that runs this `agentdesk`: the compiled binary itself, or Node
 * with the bundle file when Node runs the bundle (component-installer
 * §Standing guidance).
 */
export function agentdeskCommand(ctx: Context): { command: string; prefix: string[] } {
  const executable = ctx.executable ?? runningExecutable();
  const runtime = basename(process.execPath).toLowerCase();
  if ((runtime === "node" || runtime === "nodejs") && executable !== process.execPath) {
    return { command: process.execPath, prefix: [executable] };
  }
  return { command: executable, prefix: [] };
}
