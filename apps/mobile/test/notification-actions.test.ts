import type { Decision } from "@agentdesk/contract";
import {
  ACTION_CATEGORIES,
  type ActionDeps,
  type ActionRequest,
  type ActionWindow,
  FAILED_BODY,
  handleNotificationResponse,
  initializeNotificationActions,
  parseActionResponse,
  ResponseRegistry,
  type SendResult,
  SIGN_IN_BODY,
  type StartupDeps,
} from "../src/notification-actions";
import { decision } from "./data";
import { DEFAULT_ACTION, deferred } from "./fakes";

// component-mobile-app §Notifications, notification actions (req-mobile-app
// AC-4.1): the categories, which responses count as a press, the outcome of
// each answer, and the background window's lifetime. Everything native is
// injected, so no test needs a device or a React tree.

const PAIRS: [string, string][] = [
  ["decision-approve-reject", "approve"],
  ["decision-approve-reject", "reject"],
  ["decision-choice-2", "option-1"],
  ["decision-choice-2", "option-2"],
  ["decision-choice-3", "option-1"],
  ["decision-choice-3", "option-2"],
  ["decision-choice-3", "option-3"],
];

// A notification response as expo-notifications delivers it for an action
// button. `android` puts the push body in `dataString`, as Android's task
// does.
function actionResponse(
  options: {
    requestId?: string;
    categoryId?: string | null;
    actionId?: string;
    data?: unknown;
    android?: boolean;
  } = {},
) {
  const {
    requestId = "n_1",
    categoryId = "decision-approve-reject",
    actionId = "approve",
    data = { kind: "decision.created", eventId: "e_1", decisionId: "d_1" },
    android = false,
  } = options;
  return {
    actionIdentifier: actionId,
    notification: {
      date: 0,
      request: {
        identifier: requestId,
        content: {
          title: "Ship the release?",
          body: "acme · Claude",
          ...(categoryId === null ? {} : { categoryIdentifier: categoryId }),
          ...(android ? { dataString: JSON.stringify(data) } : { data }),
        },
        trigger: { type: "push" },
      },
    },
  };
}

function settled(overrides: Partial<Decision>): Decision {
  return decision({ id: "d_1", ...overrides });
}

const answered = settled({
  state: "answered",
  answer: { kind: "approve" },
  answered_via: "notification",
  answered_at: "2026-10-12T10:00:00.000Z",
});

type FakeWindow = ActionWindow & {
  expire(): void;
  finish: jest.Mock<Promise<void>, []>;
};

function fakeWindow(events: string[]): FakeWindow {
  let expired = false;
  const listeners: (() => void)[] = [];
  return {
    expired: () => expired,
    onExpire: (listener) => {
      listeners.push(listener);
    },
    finish: jest.fn(async () => {
      events.push("finish");
    }),
    expire() {
      expired = true;
      for (const listener of listeners) listener();
    },
  };
}

// Injected dependencies that record every call in order. `result` is what
// the answer sender returns when its send check allows the mutation.
function harness(
  result: SendResult | (() => Promise<SendResult>) = { kind: "answered", decision: answered },
) {
  const events: string[] = [];
  const window = fakeWindow(events);
  const deps = {
    window: jest.fn(async (_request: ActionRequest) => window as ActionWindow),
    send: jest.fn(async (request: ActionRequest, canSend: () => boolean): Promise<SendResult> => {
      const value = typeof result === "function" ? await result() : result;
      if (!canSend()) {
        events.push("send refused");
        return { kind: "failed" };
      }
      events.push(`send ${request.decisionId} ${request.actionId}`);
      return value;
    }),
    dismiss: jest.fn(async (requestId: string) => {
      events.push(`dismiss ${requestId}`);
    }),
    notify: jest.fn(async (body: string, decisionId: string) => {
      events.push(`notify ${decisionId}: ${body}`);
    }),
    warn: jest.fn((_message: string) => undefined),
  } satisfies ActionDeps;
  return { deps, events, window, registry: new ResponseRegistry() };
}

describe("categories", () => {
  test("define exactly the seven actions, none of which opens the app", () => {
    const pairs = ACTION_CATEGORIES.flatMap((category) =>
      category.actions.map((action) => [category.id, action.id]),
    );
    expect(pairs).toEqual(PAIRS);
    expect(
      ACTION_CATEGORIES.map((category) => [
        category.id,
        category.actions.map((action) => action.title),
      ]),
    ).toEqual([
      ["decision-approve-reject", ["Approve", "Reject"]],
      ["decision-choice-2", ["Option 1", "Option 2"]],
      ["decision-choice-3", ["Option 1", "Option 2", "Option 3"]],
    ]);
  });
});

describe("startup", () => {
  type StartupOverrides = {
    platform?: string;
    setCategory?: (id: string, actions: unknown[]) => Promise<unknown>;
    registerTask?: () => Promise<void>;
    lastResponse?: () => unknown;
  };

  function startupDeps(overrides: StartupOverrides = {}) {
    const listeners: ((response: unknown) => void)[] = [];
    const deps = {
      platform: overrides.platform ?? "ios",
      setCategory: jest.fn(overrides.setCategory ?? (async (): Promise<unknown> => null)),
      registerTask: jest.fn(overrides.registerTask ?? (async () => undefined)),
      addResponseListener: jest.fn((listener: (response: unknown) => void) => {
        listeners.push(listener);
      }),
      lastResponse: jest.fn(overrides.lastResponse ?? ((): unknown => null)),
      handle: jest.fn(async (_response: unknown) => undefined),
      warn: jest.fn((_message: string) => undefined),
    };
    return { deps: deps satisfies StartupDeps, listeners };
  }

  test("registers each category once with its actions, foreground off and authentication on", async () => {
    const { deps } = startupDeps();
    await initializeNotificationActions(deps);

    expect(deps.setCategory).toHaveBeenCalledTimes(3);
    const options = {
      opensAppToForeground: false,
      isAuthenticationRequired: true,
      isDestructive: false,
    };
    expect(deps.setCategory.mock.calls).toEqual([
      [
        "decision-approve-reject",
        [
          { identifier: "approve", buttonTitle: "Approve", options },
          { identifier: "reject", buttonTitle: "Reject", options },
        ],
      ],
      [
        "decision-choice-2",
        [
          { identifier: "option-1", buttonTitle: "Option 1", options },
          { identifier: "option-2", buttonTitle: "Option 2", options },
        ],
      ],
      [
        "decision-choice-3",
        [
          { identifier: "option-1", buttonTitle: "Option 1", options },
          { identifier: "option-2", buttonTitle: "Option 2", options },
          { identifier: "option-3", buttonTitle: "Option 3", options },
        ],
      ],
    ]);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  test("on iOS installs the response listener and registers no notification task", async () => {
    const { deps, listeners } = startupDeps();
    await initializeNotificationActions(deps);

    expect(deps.registerTask).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(1);
    const press = actionResponse();
    listeners[0]?.(press);
    expect(deps.handle).toHaveBeenCalledWith(press);
  });

  test("on Android also registers the notification task", async () => {
    const { deps, listeners } = startupDeps({ platform: "android" });
    await initializeNotificationActions(deps);

    expect(deps.registerTask).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);
  });

  test("hands the launch response to the handler without clearing it", async () => {
    const launch = actionResponse({ requestId: "n_launch" });
    const { deps } = startupDeps({ lastResponse: jest.fn(() => launch) });
    await initializeNotificationActions(deps);

    expect(deps.handle).toHaveBeenCalledWith(launch);
  });

  test("the listener exists before the categories finish registering", () => {
    const pending = deferred<null>();
    const { deps, listeners } = startupDeps({
      setCategory: jest.fn(() => pending.promise),
    });
    void initializeNotificationActions(deps);

    expect(listeners).toHaveLength(1);
  });

  test("settles only after every category and the task have settled", async () => {
    const category = deferred<null>();
    const task = deferred<undefined>();
    const { deps } = startupDeps({
      platform: "android",
      setCategory: jest.fn(() => category.promise),
      registerTask: jest.fn(() => task.promise),
    });
    let done = false;
    void initializeNotificationActions(deps).then(() => {
      done = true;
    });

    await Promise.resolve();
    category.resolve(null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    task.resolve(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(true);
  });

  test("a failed category or task registration warns and still settles", async () => {
    const { deps } = startupDeps({
      platform: "android",
      setCategory: jest.fn(async (id: string) => {
        if (id === "decision-choice-2") {
          throw new Error("native failure");
        }
        return null;
      }),
      registerTask: jest.fn(async () => {
        throw new Error("task failure");
      }),
    });

    await expect(initializeNotificationActions(deps)).resolves.toBeUndefined();
    expect(deps.setCategory).toHaveBeenCalledTimes(3);
    expect(deps.warn.mock.calls.map(([message]) => message)).toEqual([
      "Could not register notification category decision-choice-2 (Error)",
      "Could not register the notification action task (Error)",
    ]);
  });

  test("concurrent starts share one initialization", async () => {
    await jest.isolateModulesAsync(async () => {
      const actions: typeof import("../src/notification-actions") = require("../src/notification-actions");
      const { deps } = startupDeps({ platform: "android" });
      const factory = jest.fn(() => deps);

      expect(actions.notificationActionsSettled()).toBeInstanceOf(Promise);
      const first = actions.startNotificationActions(factory);
      const second = actions.startNotificationActions(factory);
      expect(second).toBe(first);
      expect(actions.notificationActionsSettled()).toBe(first);
      await first;

      expect(factory).toHaveBeenCalledTimes(1);
      expect(deps.setCategory).toHaveBeenCalledTimes(3);
      expect(deps.registerTask).toHaveBeenCalledTimes(1);
      expect(deps.addResponseListener).toHaveBeenCalledTimes(1);
    });
  });
});

describe("which responses are action presses", () => {
  test.each(PAIRS)("%s / %s is a press", (categoryId, actionId) => {
    expect(parseActionResponse(actionResponse({ categoryId, actionId }))).toEqual({
      requestId: "n_1",
      categoryId,
      actionId,
      decisionId: "d_1",
    });
  });

  test("reads Android's dataString push body", () => {
    expect(parseActionResponse(actionResponse({ android: true, actionId: "reject" }))).toEqual({
      requestId: "n_1",
      categoryId: "decision-approve-reject",
      actionId: "reject",
      decisionId: "d_1",
    });
  });

  test.each([
    ["a body tap", actionResponse({ actionId: DEFAULT_ACTION })],
    ["an unknown action", actionResponse({ actionId: "snooze" })],
    [
      "an action its category does not have",
      actionResponse({ categoryId: "decision-choice-2", actionId: "option-3" }),
    ],
    ["an option on approve-reject", actionResponse({ actionId: "option-1" })],
    ["no category", actionResponse({ categoryId: null })],
    ["an unknown category", actionResponse({ categoryId: "other" })],
    [
      "another event kind",
      actionResponse({ data: { kind: "decision.expired", decisionId: "d_1" } }),
    ],
    ["a missing decision id", actionResponse({ data: { kind: "decision.created" } })],
    [
      "a path as the decision id",
      actionResponse({ data: { kind: "decision.created", decisionId: "../settings" } }),
    ],
    [
      "an over-long decision id",
      actionResponse({ data: { kind: "decision.created", decisionId: "d".repeat(129) } }),
    ],
    [
      "a number as the decision id",
      actionResponse({ data: { kind: "decision.created", decisionId: 7 } }),
    ],
    ["no data", actionResponse({ data: null })],
    ["an empty request id", actionResponse({ requestId: "" })],
    [
      "malformed Android data",
      (() => {
        const response = actionResponse({ android: true });
        (response.notification.request.content as Record<string, unknown>).dataString = "{";
        return response;
      })(),
    ],
    [
      "a receipt",
      { notification: actionResponse().notification, data: { kind: "decision.created" } },
    ],
    ["null", null],
    ["a string", "approve"],
  ])("%s is not a press", (_name, value) => {
    expect(parseActionResponse(value)).toBeNull();
  });
});

describe("answering a press", () => {
  test.each(PAIRS)("%s / %s sends its decision id and action id", async (categoryId, actionId) => {
    const { deps, events, registry } = harness();
    await handleNotificationResponse(actionResponse({ categoryId, actionId }), registry, deps);

    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send.mock.calls[0]?.[0]).toEqual({
      requestId: "n_1",
      categoryId,
      actionId,
      decisionId: "d_1",
    });
    expect(events).toEqual([`send d_1 ${actionId}`, "dismiss n_1", "finish"]);
  });

  test("a success dismisses only the source notification and posts nothing", async () => {
    const { deps, events, registry } = harness();
    await handleNotificationResponse(actionResponse({ requestId: "n_9" }), registry, deps);

    expect(deps.dismiss).toHaveBeenCalledWith("n_9");
    expect(deps.notify).not.toHaveBeenCalled();
    expect(events).toEqual(["send d_1 approve", "dismiss n_9", "finish"]);
  });

  test("a failed dismissal warns, sends nothing more, and still ends the window", async () => {
    const { deps, events, registry, window } = harness();
    deps.dismiss.mockRejectedValueOnce(new Error("gone"));
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith("Could not dismiss the answered notification (Error)");
    expect(window.finish).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["send d_1 approve", "finish"]);
  });

  test.each<[string, SendResult, string]>([
    [
      "answered with approve",
      { kind: "conflict", decision: answered },
      "Already answered: Approve",
    ],
    [
      "answered with reject",
      { kind: "conflict", decision: settled({ ...answered, answer: { kind: "reject" } }) },
      "Already answered: Reject",
    ],
    [
      "answered with an option",
      {
        kind: "conflict",
        decision: settled({
          ...answered,
          input_type: "single_choice",
          options: [
            { id: "o1", label: "Ship it" },
            { id: "o2", label: "Hold the release" },
          ],
          answer: { kind: "option", option_id: "o2" },
        }),
      },
      "Already answered: Hold the release",
    ],
    [
      "expired with its default applied",
      {
        kind: "conflict",
        decision: settled({
          state: "expired",
          answer: { kind: "reject" },
          answered_via: "default",
          applied_by_default: true,
        }),
      },
      "Expired: decided by default: Reject",
    ],
    [
      "expired with no answer",
      { kind: "conflict", decision: settled({ state: "expired" }) },
      "Expired without an answer",
    ],
    [
      "cancelled",
      { kind: "conflict", decision: settled({ state: "cancelled" }) },
      "Cancelled without an answer",
    ],
    ["no session", { kind: "sign-in" }, SIGN_IN_BODY],
    ["a failure", { kind: "failed" }, FAILED_BODY],
    [
      "a malformed result",
      { kind: "answered", decision: { id: "d_1", state: "answered" } },
      FAILED_BODY,
    ],
    [
      "a result that is not answered",
      { kind: "answered", decision: settled({ state: "pending" }) },
      FAILED_BODY,
    ],
    [
      "an answered conflict without an answer",
      { kind: "conflict", decision: settled({ state: "answered" }) },
      FAILED_BODY,
    ],
  ])("%s posts its outcome and dismisses nothing", async (_name, result, body) => {
    const { deps, events, registry } = harness(result);
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(body, "d_1");
    expect(deps.dismiss).not.toHaveBeenCalled();
    expect(events).toEqual(["send d_1 approve", `notify d_1: ${body}`, "finish"]);
  });

  test("a failed local notification warns and never reports success", async () => {
    const { deps, events, registry, window } = harness({ kind: "failed" });
    deps.notify.mockRejectedValueOnce(new Error("denied"));
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(deps.dismiss).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      "Could not post the notification action outcome (Error)",
    );
    expect(window.finish).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["send d_1 approve", "finish"]);
  });

  test("a thrown send posts the generic failure", async () => {
    const { deps, events, registry } = harness();
    deps.send.mockRejectedValueOnce(new TypeError("boom"));
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(deps.warn).toHaveBeenCalledWith("Could not answer from the notification (TypeError)");
    expect(events).toEqual([`notify d_1: ${FAILED_BODY}`, "finish"]);
  });

  test("a failed window end is warned and nothing else changes", async () => {
    const { deps, registry, window } = harness();
    window.finish.mockRejectedValueOnce(new Error("native"));
    await expect(
      handleNotificationResponse(actionResponse(), registry, deps),
    ).resolves.toBeUndefined();

    expect(deps.dismiss).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith(
      "Could not end the notification action background task (Error)",
    );
  });

  test.each([
    ["a body tap", actionResponse({ actionId: DEFAULT_ACTION })],
    ["a receipt", { notification: actionResponse().notification }],
    ["malformed data", actionResponse({ data: { kind: "decision.created", decisionId: "a/b" } })],
    ["an outcome notification", actionResponse({ categoryId: null })],
  ])("%s does nothing at all", async (_name, value) => {
    const { deps, registry } = harness();
    await handleNotificationResponse(value, registry, deps);

    expect(deps.window).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.dismiss).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });
});

describe("one owner per press", () => {
  test("a repeated delivery waits for the first and sends once", async () => {
    const gate = deferred<SendResult>();
    const { deps, events, registry, window } = harness(() => gate.promise);
    const launch = actionResponse();
    const live = actionResponse();

    const first = handleNotificationResponse(launch, registry, deps);
    const second = handleNotificationResponse(live, registry, deps);
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(window.finish).not.toHaveBeenCalled();
    expect(secondDone).toBe(false);

    gate.resolve({ kind: "answered", decision: answered });
    await Promise.all([first, second]);

    expect(deps.window).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(window.finish).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["send d_1 approve", "dismiss n_1", "finish"]);
  });

  test("a delivery after the first finished sends nothing more", async () => {
    const { deps, registry } = harness();
    await handleNotificationResponse(actionResponse(), registry, deps);
    await handleNotificationResponse(actionResponse({ android: true }), registry, deps);

    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  test("another notification or another action is its own press", async () => {
    const { deps, registry } = harness();
    await handleNotificationResponse(actionResponse({ requestId: "n_1" }), registry, deps);
    await handleNotificationResponse(actionResponse({ requestId: "n_2" }), registry, deps);
    await handleNotificationResponse(
      actionResponse({ requestId: "n_1", actionId: "reject" }),
      registry,
      deps,
    );

    expect(deps.send).toHaveBeenCalledTimes(3);
  });

  test("the registry keeps a bounded number of presses", async () => {
    const { deps } = harness();
    const registry = new ResponseRegistry(2);
    for (const requestId of ["n_1", "n_2", "n_3"]) {
      await handleNotificationResponse(actionResponse({ requestId }), registry, deps);
    }
    await handleNotificationResponse(actionResponse({ requestId: "n_3" }), registry, deps);
    expect(deps.send).toHaveBeenCalledTimes(3);
    await handleNotificationResponse(actionResponse({ requestId: "n_1" }), registry, deps);
    expect(deps.send).toHaveBeenCalledTimes(4);
  });
});

describe("the background window", () => {
  test("expiring before the mutation posts the generic failure at once and sends nothing", async () => {
    const gate = deferred<SendResult>();
    const { deps, events, registry, window } = harness(() => gate.promise);
    const processing = handleNotificationResponse(actionResponse(), registry, deps);
    await new Promise((resolve) => setImmediate(resolve));

    window.expire();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.notify).toHaveBeenCalledWith(FAILED_BODY, "d_1");

    // The Clerk work finishes after expiry: the mutation is not started.
    gate.resolve({ kind: "answered", decision: answered });
    await processing;

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.dismiss).not.toHaveBeenCalled();
    expect(events).toEqual([`notify d_1: ${FAILED_BODY}`, "send refused", "finish"]);
  });

  test("a window that expired before adoption sends nothing", async () => {
    const { deps, events, registry, window } = harness();
    window.expire();
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(deps.send).not.toHaveBeenCalled();
    expect(events).toEqual([`notify d_1: ${FAILED_BODY}`, "finish"]);
  });

  test("expiring after the mutation went out waits for its valid result", async () => {
    const { deps, events, registry, window } = harness();
    deps.send.mockImplementationOnce(async (_request, canSend) => {
      expect(canSend()).toBe(true);
      window.expire();
      return { kind: "answered", decision: answered };
    });
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(events).toEqual(["dismiss n_1", "finish"]);
  });

  test("expiring after the mutation went out reports a failed result once", async () => {
    const { deps, events, registry, window } = harness();
    deps.send.mockImplementationOnce(async (_request, canSend) => {
      canSend();
      window.expire();
      return { kind: "failed" };
    });
    await handleNotificationResponse(actionResponse(), registry, deps);

    expect(events).toEqual([`notify d_1: ${FAILED_BODY}`, "finish"]);
  });

  test("ends the window only after the outcome notification settles", async () => {
    const posting = deferred<undefined>();
    const { deps, events, registry, window } = harness({ kind: "sign-in" });
    deps.notify.mockImplementationOnce(async (body) => {
      await posting.promise;
      events.push(`notify ${body}`);
    });
    const processing = handleNotificationResponse(actionResponse(), registry, deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(window.finish).not.toHaveBeenCalled();

    posting.resolve(undefined);
    await processing;
    expect(events).toEqual(["send d_1 approve", `notify ${SIGN_IN_BODY}`, "finish"]);
  });
});
