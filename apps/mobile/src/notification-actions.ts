import { type Decision, decisionSchema } from "@agentdesk/contract";
import { formatAnswer } from "./decision-detail";
import { isRecordId } from "./notification-route";

// component-mobile-app §Notifications, notification actions (req-mobile-app
// AC-4.1). This module holds no React state. It is shared by the Android
// notification task, the response listener that the entry module installs,
// and the launch response, so an action button answers the same way however
// it reaches the app.

// The Android channel every push and outcome notification lands in.
// component-notifications sends no channel id, so Android uses the default
// channel the plugin names.
export const ANDROID_CHANNEL_ID = "default";

// The categories the backend sets on `decision.created` pushes
// (component-notifications §Push), with each action's id and button title.
// A choice notification numbers its options in the body; the buttons name the
// numbers.
export const ACTION_CATEGORIES = [
  {
    id: "decision-approve-reject",
    actions: [
      { id: "approve", title: "Approve" },
      { id: "reject", title: "Reject" },
    ],
  },
  {
    id: "decision-choice-2",
    actions: [
      { id: "option-1", title: "Option 1" },
      { id: "option-2", title: "Option 2" },
    ],
  },
  {
    id: "decision-choice-3",
    actions: [
      { id: "option-1", title: "Option 1" },
      { id: "option-2", title: "Option 2" },
      { id: "option-3", title: "Option 3" },
    ],
  },
] as const;

export type ActionId = (typeof ACTION_CATEGORIES)[number]["actions"][number]["id"];

// The options every action button carries. No action opens the app. On iOS a
// locked iPhone asks for Face ID or the passcode before any action runs, for
// Approve and Reject alike; Android has no such option and ignores it.
export const ACTION_OPTIONS = {
  opensAppToForeground: false,
  isAuthenticationRequired: true,
  isDestructive: false,
} as const;

export const OUTCOME_TITLE = "AgentDesk";
export const SIGN_IN_BODY = "Sign in to AgentDesk to answer";
export const FAILED_BODY = "Could not answer. Open AgentDesk to try again.";

// An action button press the app answers.
export type ActionRequest = {
  requestId: string;
  categoryId: string;
  actionId: ActionId;
  decisionId: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// A notification's data. iOS and the response listener give it as `data`;
// Android's task gives the push body as the JSON string `dataString`.
function contentData(content: Record<string, unknown>): Record<string, unknown> | null {
  const data = record(content.data);
  if (data !== null && Object.keys(data).length > 0) {
    return data;
  }
  if (typeof content.dataString === "string") {
    try {
      return record(JSON.parse(content.dataString));
    } catch {
      return null;
    }
  }
  return data;
}

// Reads an action button press from a notification response, as the response
// listener, the launch response, or the Android task delivers it. Only an
// explicit action of a registered category on a `decision.created` push with
// a well-formed `decisionId` counts. A receipt, a body tap, an unknown
// action, and malformed data are null, so they cause no authentication work,
// no mutation, and no local notification.
export function parseActionResponse(value: unknown): ActionRequest | null {
  const response = record(value);
  if (response === null || typeof response.actionIdentifier !== "string") {
    return null;
  }
  const request = record(record(response.notification)?.request);
  const content = record(request?.content);
  if (request === null || content === null || typeof request.identifier !== "string") {
    return null;
  }
  if (request.identifier === "") {
    return null;
  }
  const categoryId = content.categoryIdentifier;
  const category = ACTION_CATEGORIES.find((item) => item.id === categoryId);
  const action = category?.actions.find((item) => item.id === response.actionIdentifier);
  if (category === undefined || action === undefined) {
    return null;
  }
  const data = contentData(content);
  if (data === null || data.kind !== "decision.created" || !isRecordId(data.decisionId)) {
    return null;
  }
  return {
    requestId: request.identifier,
    categoryId: category.id,
    actionId: action.id,
    decisionId: data.decisionId,
  };
}

// What sending the answer came to.
export type SendResult =
  | { kind: "answered"; decision: unknown }
  | { kind: "conflict"; decision: Decision }
  | { kind: "sign-in" }
  | { kind: "failed" };

// The body of the local notification for a result that is not a success, or
// null for a success. A recorded answer is formatted from the stored
// decision, never from the action that was pressed.
export function outcomeBody(result: SendResult): string | null {
  switch (result.kind) {
    case "answered":
      return null;
    case "sign-in":
      return SIGN_IN_BODY;
    case "failed":
      return FAILED_BODY;
    case "conflict":
      return conflictBody(result.decision);
  }
}

function conflictBody(decision: Decision): string {
  switch (decision.state) {
    case "answered":
      return decision.answer === null
        ? FAILED_BODY
        : `Already answered: ${formatAnswer(decision.answer, decision.options)}`;
    case "expired":
      if (decision.answer !== null && decision.applied_by_default) {
        return `Expired: decided by default: ${formatAnswer(decision.answer, decision.options)}`;
      }
      return decision.answer === null ? "Expired without an answer" : FAILED_BODY;
    case "cancelled":
      return "Cancelled without an answer";
    case "pending":
      return FAILED_BODY;
  }
}

// Whether a mutation result is the answered decision. Anything else is a
// malformed outcome and never reported as a success.
export function isAnswered(value: unknown): boolean {
  const parsed = decisionSchema.safeParse(value);
  return parsed.success && parsed.data.state === "answered";
}

// The background time that protects one response's processing. On iOS it is
// the native background task; elsewhere it protects nothing.
export type ActionWindow = {
  // Whether iOS has expired the window.
  expired(): boolean;
  // Calls `listener` once if the window expires.
  onExpire(listener: () => void): void;
  // Ends the background task. Safe to call more than once.
  finish(): Promise<void>;
};

export type ActionDeps = {
  // Adopts the background window for the response, or begins one.
  window(request: ActionRequest): Promise<ActionWindow>;
  // Sends the answer as the signed-in person. `canSend` is checked again
  // immediately before the mutation goes out; when it returns false nothing
  // is sent and the result is `failed`.
  send(request: ActionRequest, canSend: () => boolean): Promise<SendResult>;
  // Dismisses the source notification.
  dismiss(requestId: string): Promise<void>;
  // Posts an immediate local notification with the outcome.
  notify(body: string, decisionId: string): Promise<void>;
  warn(message: string): void;
};

// The responses this process has seen, keyed by request id and action id.
// A repeated delivery, such as the launch response that the live listener
// also delivers, or the Android task and the listener for one press, waits
// on the first and sends nothing. The bound keeps the oldest entries out of
// memory; the backend's settlement still protects a press seen again after
// a restart or on another device.
export class ResponseRegistry {
  private readonly entries = new Map<string, Promise<void>>();

  constructor(private readonly limit = 64) {}

  claim(request: ActionRequest, start: () => Promise<void>): Promise<void> {
    const key = `${request.requestId}\u0000${request.actionId}`;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const processing = start();
    this.entries.set(key, processing);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    return processing;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// Answers one action button press. The owner of the press adopts its
// background window, sends the answer, dismisses the source notification on
// success or posts the outcome otherwise, and ends the window only after all
// of that settles, including a failed dismissal or a failed local
// notification. If iOS expires the window before the mutation goes out, no
// mutation is sent and the generic failure is posted once while JavaScript
// still runs. A mutation already sent is not rolled back or retried; only a
// valid result counts as a success.
export async function answerAction(request: ActionRequest, deps: ActionDeps): Promise<void> {
  let window: ActionWindow | null = null;
  let sent = false;
  let posted = false;
  const post = async (body: string) => {
    if (posted) {
      return;
    }
    posted = true;
    try {
      await deps.notify(body, request.decisionId);
    } catch (error) {
      deps.warn(`Could not post the notification action outcome (${describe(error)})`);
    }
  };
  // The outcome posted when the window expires, awaited before it ends.
  const expiryPosts: Promise<void>[] = [];
  try {
    window = await deps.window(request);
    const current = window;
    current.onExpire(() => {
      if (!sent) {
        expiryPosts.push(post(FAILED_BODY));
      }
    });
    if (current.expired()) {
      await post(FAILED_BODY);
      return;
    }
    const result = await deps.send(request, () => {
      if (current.expired()) {
        return false;
      }
      sent = true;
      return true;
    });
    if (!sent && current.expired()) {
      await post(FAILED_BODY);
      return;
    }
    if (result.kind === "answered" && isAnswered(result.decision)) {
      try {
        await deps.dismiss(request.requestId);
      } catch (error) {
        deps.warn(`Could not dismiss the answered notification (${describe(error)})`);
      }
      return;
    }
    await post(
      outcomeBody(result.kind === "answered" ? { kind: "failed" } : result) ?? FAILED_BODY,
    );
  } catch (error) {
    deps.warn(`Could not answer from the notification (${describe(error)})`);
    await post(FAILED_BODY);
  } finally {
    await Promise.all(expiryPosts);
    if (window !== null) {
      try {
        await window.finish();
      } catch (error) {
        deps.warn(`Could not end the notification action background task (${describe(error)})`);
      }
    }
  }
}

// Handles any notification response. Only an action button press of a
// registered category starts work; a repeated delivery of one press waits on
// the first.
export function handleNotificationResponse(
  value: unknown,
  registry: ResponseRegistry,
  deps: ActionDeps,
): Promise<void> {
  const request = parseActionResponse(value);
  if (request === null) {
    return Promise.resolve();
  }
  return registry.claim(request, () => answerAction(request, deps));
}

// The native calls startup makes, injected so tests need no device.
export type StartupDeps = {
  platform: string;
  setCategory(
    id: string,
    actions: { identifier: string; buttonTitle: string; options: typeof ACTION_OPTIONS }[],
  ): Promise<unknown>;
  // Registers the Android notification task unless the OS already holds it.
  registerTask(): Promise<void>;
  addResponseListener(listener: (response: unknown) => void): void;
  lastResponse(): unknown;
  handle(response: unknown): Promise<void>;
  warn(message: string): void;
};

// Registers the three categories, the Android task, and the response
// listener. The listener and the launch response are read first and
// synchronously, so a press delivered while the categories register is not
// lost; the launch response is not cleared, so the root layout still reads a
// body tap that launched the app. A failed registration warns and leaves the
// app and device registration working. The returned promise never rejects.
export function initializeNotificationActions(deps: StartupDeps): Promise<void> {
  try {
    deps.addResponseListener((response) => {
      void deps.handle(response);
    });
    const launch = deps.lastResponse();
    if (launch !== null && launch !== undefined) {
      void deps.handle(launch);
    }
  } catch (error) {
    deps.warn(`Could not listen for notification actions (${describe(error)})`);
  }
  const categories = ACTION_CATEGORIES.map((category) =>
    deps
      .setCategory(
        category.id,
        category.actions.map((action) => ({
          identifier: action.id,
          buttonTitle: action.title,
          options: ACTION_OPTIONS,
        })),
      )
      .then(
        () => undefined,
        (error: unknown) => {
          deps.warn(`Could not register notification category ${category.id} (${describe(error)})`);
        },
      ),
  );
  const task =
    deps.platform === "android"
      ? deps.registerTask().catch((error: unknown) => {
          deps.warn(`Could not register the notification action task (${describe(error)})`);
        })
      : Promise.resolve();
  return Promise.all([...categories, task]).then(() => undefined);
}

let startup: Promise<void> | null = null;

// Starts notification actions once per process. Later calls share the first
// start, so a remount or a second caller registers nothing more.
export function startNotificationActions(deps: () => StartupDeps): Promise<void> {
  if (startup === null) {
    try {
      startup = initializeNotificationActions(deps());
    } catch {
      startup = Promise.resolve();
    }
  }
  return startup;
}

// Settles once this process's start has registered its categories, or at
// once when nothing started them. Device registration waits for it before it
// requests an Expo push token.
export function notificationActionsSettled(): Promise<void> {
  return startup ?? Promise.resolve();
}
