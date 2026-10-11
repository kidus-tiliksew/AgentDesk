// component-gateway §Verification: runs the smoke run's answer helper as a
// child process that never outlives its caller. The module uses no Node API,
// so the Workers-runtime tests drive it with a fake process; `smoke-mcp.ts`
// supplies the real one.

// A started process. `kill` signals the process and everything it started.
export interface HelperProcess {
  // Settles once the process has exited and its output is closed.
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  // The tail of the process's standard error.
  stderr(): string;
}

export interface HelperLimits {
  // Aborting terminates the process.
  signal: AbortSignal;
  timeoutMs: number;
  // How long the process has to exit after SIGTERM before SIGKILL.
  graceMs: number;
}

// Starts a process and resolves when it exits with status 0. On abort or
// timeout it sends SIGTERM, then SIGKILL after the grace period, and rejects
// only after the process has exited, so a rejection never leaves it running.
// An aborted signal starts nothing.
export async function runHelperProcess(
  start: () => HelperProcess,
  limits: HelperLimits,
): Promise<void> {
  const { signal } = limits;
  if (signal.aborted) {
    throw signal.reason;
  }
  const child = start();
  let stopped: "aborted" | "timed out" | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: "aborted" | "timed out") => {
    if (stopped !== undefined) {
      return;
    }
    stopped = why;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), limits.graceMs);
  };
  const onAbort = () => stop("aborted");
  signal.addEventListener("abort", onAbort);
  const timeout = setTimeout(() => stop("timed out"), limits.timeoutMs);
  let exit: Awaited<HelperProcess["exited"]>;
  try {
    exit = await child.exited;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(timeout);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  }
  if (stopped === "aborted") {
    throw signal.reason;
  }
  if (stopped === "timed out") {
    throw new Error(`helper timed out after ${limits.timeoutMs} ms`);
  }
  if (exit.code !== 0) {
    const how = exit.code === null ? `signal ${exit.signal}` : `exit ${exit.code}`;
    throw new Error(`helper failed (${how})\n${child.stderr()}`.trimEnd());
  }
}
