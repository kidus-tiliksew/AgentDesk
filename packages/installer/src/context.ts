import type { Harness } from "./harnesses.js";

/** Result of a harness CLI invocation. Output stays private to the caller. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: readonly string[]) => Promise<RunResult>;

/** A cancellable one-shot timer. */
export interface Timer {
  promise: Promise<void>;
  cancel(): void;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Reads one answer from the user; absent when the session is not interactive. */
  prompt?: (question: string) => Promise<string>;
}

/**
 * Everything the installer reads from the machine. The CLI builds it from the
 * process; tests build it from temporary homes, a fake PATH, a fake clock, and
 * an in-process fake gateway.
 */
export interface Context {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  hostname: string;
  fetch: typeof globalThis.fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  run: Runner;
  io: Io;
  skill: { content: string; version: string };
  defaultServer: string | undefined;
  harnesses: readonly Harness[];
  /** The standing guidance embedded from `@agentdesk/skill/agentdesk/GUIDANCE.md`. */
  guidance?: string;
  /**
   * Absolute path of the running `agentdesk` executable, which the
   * session-start hooks run. Defaults to the path the process reports.
   */
  executable?: string;
  /** Starts a timer that bounds a subprocess; defaults to a real timer. */
  startTimer?: (ms: number) => Timer;
  /**
   * Secrets seen during the run. Output passes through `redact`, so a token or
   * device secret never reaches stdout or stderr even through an error path.
   */
  secrets: Set<string>;
}

export class InstallerError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InstallerError";
  }
}

/**
 * The prompt could not read the terminal, such as Bun's `EINVAL` from kqueue
 * on macOS. Callers fall back to their non-interactive behavior; Ctrl+C and
 * other rejections are not this error.
 */
export class TerminalReadError extends Error {
  constructor(readonly readError: unknown) {
    super(
      `the terminal could not be read: ${readError instanceof Error ? readError.message : String(readError)}`,
    );
    this.name = "TerminalReadError";
  }
}

export function redact(text: string, secrets: ReadonlySet<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[redacted]");
  }
  return result;
}

/** Wraps output so every line is redacted against the run's secrets. */
export function redactingIo(io: Io, secrets: ReadonlySet<string>): Io {
  return {
    out: (line) => io.out(redact(line, secrets)),
    err: (line) => io.err(redact(line, secrets)),
    ...(io.prompt ? { prompt: io.prompt } : {}),
  };
}

/** Starts `ctx.startTimer`, or a real timer when the context gives none. */
export function startTimer(ctx: Context, ms: number): Timer {
  if (ctx.startTimer) return ctx.startTimer(ms);
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}
