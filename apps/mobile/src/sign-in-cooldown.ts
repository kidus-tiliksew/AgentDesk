import { useEffect, useState } from "react";

// How long the code step waits after a code is sent before it offers to send
// another (design "Sign in: code"), so repeated presses do not flood the
// inbox or Clerk's rate limit.
export const RESEND_COOLDOWN_MS = 30_000;

// Whole seconds left as m:ss, e.g. 0:24.
export function formatCooldown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The seconds left before a new code may be sent, and `start` to begin the
// wait when a code goes out. It reads the clock, so a wait that passes while
// the app is suspended has passed on return.
export function useResendCooldown(): { remaining: number; start: () => void } {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) {
      return;
    }
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= until) {
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return {
    remaining: Math.max(0, Math.ceil((until - now) / 1000)),
    start: () => {
      const time = Date.now();
      setNow(time);
      setUntil(time + RESEND_COOLDOWN_MS);
    },
  };
}
