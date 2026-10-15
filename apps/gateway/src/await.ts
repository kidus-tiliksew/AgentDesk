import type { Decision } from "@agentdesk/contract";
import type { ServiceCall, ServiceRoute } from "./convex.js";

// component-gateway §Tools and §Waiter endpoint: the poll loop behind `await`
// and `POST /device/wait`. Each call owns its loop, deadline, and timers, and
// keeps nothing between polls (DEC-4), so several waits on one decision each
// read its settlement (req-agent-tools AC-3.5).

// Poll starts are 15 seconds apart on the call's own clock, so service
// latency does not accumulate into the interval. The poll after a settlement
// starts within 15 seconds and answers within the 10-second service timeout,
// so `await` returns within 25 seconds of the settlement (AC-3.1).
export const POLL_INTERVAL_MS = 15_000;

// Polls `route` with `body` at once and every 15 seconds until the decision
// is no longer pending, and returns it. Returns null when `timeoutSeconds`
// elapse first: the deadline cancels a poll in flight, and no poll starts at
// or after it. `await` polls `/svc/decisions/poll`, which touches the agent
// session, so a waiting agent never goes stale (req-agent-status AC-3.4); the
// waiter endpoint polls `/svc/decisions/watch`. Aborting `signal` stops the
// loop, cancels a poll in flight, and rejects.
export async function pollDecision(
  svc: ServiceCall,
  route: ServiceRoute,
  body: Record<string, unknown>,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<Decision | null> {
  const start = Date.now();
  const deadline = start + timeoutSeconds * 1000;
  // Aborted by the caller's signal or by the deadline, whichever comes first.
  const stop = new AbortController();
  let expired = false;
  const limit = setTimeout(() => {
    expired = true;
    stop.abort();
  }, deadline - start);
  const cancel = () => stop.abort();
  if (signal.aborted) {
    cancel();
  }
  signal.addEventListener("abort", cancel);

  try {
    for (let polls = 1; ; polls++) {
      const decision = (await untilAborted(svc(route, body, stop.signal), stop.signal)) as Decision;
      if (decision.state !== "pending") {
        return decision;
      }
      const next = start + polls * POLL_INTERVAL_MS;
      // At or after the deadline, wait for the limit timer instead.
      await sleep(next < deadline ? next - Date.now() : null, stop.signal);
    }
  } catch (error) {
    if (expired && !signal.aborted) {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(limit);
    signal.removeEventListener("abort", cancel);
  }
}

class Stopped extends Error {
  constructor() {
    super("await stopped");
    this.name = "Stopped";
  }
}

// Settles with `promise`, or rejects once `signal` aborts, so a service call
// that ignores its signal cannot hold the loop past the deadline. Either path
// removes the listener, including for a promise that never settles. The
// losing promise's rejection is observed.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Stopped());
      return;
    }
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Stopped());
    };
    signal.addEventListener("abort", onAbort);
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Waits `ms`, or only for `signal` when `ms` is null, and rejects once
// `signal` aborts.
function sleep(ms: number | null, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Stopped());
      return;
    }
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new Stopped());
    };
    const timer =
      ms === null
        ? undefined
        : setTimeout(
            () => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            },
            Math.max(0, ms),
          );
    signal.addEventListener("abort", onAbort);
  });
}
