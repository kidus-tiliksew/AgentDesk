import type { NotificationActionBackgroundModule } from "../modules/notification-action-background";
import type { ActionRequest, ActionWindow } from "./notification-actions";

// component-mobile-app §Notifications: the iOS background window for one
// action button press. The native delegate in
// modules/notification-action-background begins a UIApplication background
// task while the response is delivered, before expo-notifications completes
// it. JavaScript adopts that task here and ends it once processing settles;
// iOS ends it on expiry. iOS grants about 30 seconds and guarantees no
// duration, so an expired window can end processing silently if iOS suspends
// the app first.

// A window that protects nothing: Android, a build without the native module,
// a task iOS refused to grant, or a window an earlier JavaScript context
// already finished.
const UNPROTECTED: ActionWindow = {
  expired: () => false,
  onExpire: () => undefined,
  finish: async () => undefined,
};

function describe(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// Returns the function that adopts a press's window. `native` is null on
// Android, so Android never loads or requires the iOS module.
export function createActionWindows(
  native: NotificationActionBackgroundModule | null,
  warn: (message: string) => void,
): (request: ActionRequest) => Promise<ActionWindow> {
  if (native === null) {
    return async () => UNPROTECTED;
  }
  const expired = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  native.addListener("onExpire", ({ id }) => {
    expired.add(id);
    const waiting = listeners.get(id);
    listeners.delete(id);
    for (const listener of waiting ?? []) {
      listener();
    }
  });

  return async (request) => {
    let adopted: Awaited<ReturnType<NotificationActionBackgroundModule["begin"]>>;
    try {
      adopted = await native.begin(request.requestId, request.actionId, request.categoryId);
    } catch (error) {
      warn(`Could not adopt the notification action background task (${describe(error)})`);
      return UNPROTECTED;
    }
    if (adopted === null || adopted.state === "finished") {
      return UNPROTECTED;
    }
    if (adopted.state === "unavailable") {
      warn("iOS granted no background time for the notification action");
      return UNPROTECTED;
    }
    const { id } = adopted;
    if (adopted.state === "expired") {
      expired.add(id);
    }
    let finished: Promise<void> | null = null;
    return {
      expired: () => expired.has(id),
      onExpire: (listener) => {
        if (expired.has(id)) {
          return;
        }
        const waiting = listeners.get(id) ?? new Set<() => void>();
        waiting.add(listener);
        listeners.set(id, waiting);
      },
      finish: () => {
        listeners.delete(id);
        finished ??= native.finish(id);
        return finished;
      },
    };
  };
}
