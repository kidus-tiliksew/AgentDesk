import type { Harness } from "./harnesses.js";

/** Result of a harness CLI invocation. Output stays private to the caller. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: readonly string[]) => Promise<RunResult>;

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
