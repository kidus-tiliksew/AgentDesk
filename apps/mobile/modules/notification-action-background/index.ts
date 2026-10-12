import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

// The iOS-only native module in ./ios (component-mobile-app §Notifications).
// It holds a UIApplication background task for each AgentDesk action
// response. Android has no such module and never loads it.

export type NativeWindowState = "running" | "finished" | "expired" | "unavailable";
export type NativeWindow = { id: string; state: NativeWindowState };

export type NotificationActionBackgroundModule = {
  begin(requestId: string, actionId: string, categoryId: string): Promise<NativeWindow | null>;
  finish(id: string): Promise<void>;
  addListener(event: "onExpire", listener: (event: { id: string }) => void): { remove(): void };
};

// The module, or null on Android and in a build that does not contain it.
export function loadNotificationActionBackground(): NotificationActionBackgroundModule | null {
  if (Platform.OS !== "ios") {
    return null;
  }
  return requireOptionalNativeModule<NotificationActionBackgroundModule>(
    "NotificationActionBackground",
  );
}
