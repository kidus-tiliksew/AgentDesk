import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

const TICK_MS = 1000;

function isForeground(state: AppStateStatus | null) {
  return state !== "background" && state !== "inactive";
}

// The current time for a screen's elapsed-time labels. It ticks every second
// while the screen is focused and the app is in the foreground, and reads the
// time again at once on focus and on return to the foreground. It stops when
// either ends. One clock serves every card on a screen.
export function useScreenClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (timer === null) {
          setNow(Date.now());
          timer = setInterval(() => setNow(Date.now()), TICK_MS);
        }
      };
      const stop = () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
      if (isForeground(AppState.currentState)) {
        start();
      }
      const subscription = AppState.addEventListener("change", (state) => {
        if (isForeground(state)) {
          start();
        } else {
          stop();
        }
      });
      return () => {
        subscription.remove();
        stop();
      };
    }, []),
  );
  return now;
}

// Elapsed time from `since` (an ISO 8601 instant) to `now`, in whole
// seconds, minutes, hours, or days. A time ahead of the device clock reads as
// zero seconds.
export function formatElapsed(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
