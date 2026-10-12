import { getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ConvexHttpClient } from "convex/browser";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { loadNotificationActionBackground } from "../modules/notification-action-background";
import { readConfig } from "./config";
import {
  type AnswerClient,
  createAnswerSender,
  type HeadlessClerk,
} from "./notification-action-auth";
import { createActionWindows } from "./notification-action-background";
import {
  type ActionDeps,
  ANDROID_CHANNEL_ID,
  handleNotificationResponse,
  OUTCOME_TITLE,
  ResponseRegistry,
  startNotificationActions,
} from "./notification-actions";

// component-mobile-app §Notifications: the notification action wiring, loaded
// by the entry module before expo-router, so it runs at module scope when the
// app starts in the background and before any React tree mounts.
//
// - Android: expo-notifications runs this notification task for an action
//   button pressed while the app is in the background or not running.
// - iOS: the notification task never receives an action response
//   (expo-notifications 57 runs it only for push receipts), so the response
//   listener installed here and the launch response carry the press, inside
//   the background window the native module began.
//
// Both platforms also take a press through the listener while the app runs.
// One handler and one registry serve every path.

export const ACTION_TASK_NAME = "agentdesk-notification-action";

function warn(message: string) {
  console.warn(`[notification actions] ${message}`);
}

// The Clerk singleton ClerkProvider uses. When the provider already made it,
// it is reused as it is, so its token cache stays the provider's. Otherwise
// it is made with the provider's publishable key and token cache, which
// restores the stored client token.
function clerk(): HeadlessClerk {
  const result = readConfig();
  if (!result.ok) {
    throw new Error("AgentDesk is not configured");
  }
  try {
    return getClerkInstance() as unknown as HeadlessClerk;
  } catch {
    return getClerkInstance({
      publishableKey: result.config.clerkPublishableKey,
      tokenCache,
    }) as unknown as HeadlessClerk;
  }
}

function client(): AnswerClient {
  const result = readConfig();
  if (!result.ok) {
    throw new Error("AgentDesk is not configured");
  }
  return new ConvexHttpClient(result.config.convexUrl);
}

const deps: ActionDeps = {
  window: createActionWindows(loadNotificationActionBackground(), warn),
  send: createAnswerSender({ clerk, client }),
  dismiss: (requestId) => Notifications.dismissNotificationAsync(requestId),
  notify: async (body, decisionId) => {
    await Notifications.scheduleNotificationAsync({
      content: { title: OUTCOME_TITLE, body, data: { kind: "decision.created", decisionId } },
      trigger: Platform.OS === "android" ? { channelId: ANDROID_CHANNEL_ID } : null,
    });
  },
  warn,
};

const registry = new ResponseRegistry();

function handle(response: unknown): Promise<void> {
  return handleNotificationResponse(response, registry, deps);
}

if (Platform.OS === "android") {
  TaskManager.defineTask(ACTION_TASK_NAME, ({ data }) => handle(data));
}

startNotificationActions(() => ({
  platform: Platform.OS,
  setCategory: (id, actions) => Notifications.setNotificationCategoryAsync(id, actions),
  registerTask: async () => {
    if (!(await TaskManager.isTaskRegisteredAsync(ACTION_TASK_NAME))) {
      await Notifications.registerTaskAsync(ACTION_TASK_NAME);
    }
  },
  addResponseListener: (listener) => {
    Notifications.addNotificationResponseReceivedListener(listener);
  },
  lastResponse: () => Notifications.getLastNotificationResponse(),
  handle,
  warn,
}));
