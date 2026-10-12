import type {
  NativeWindow,
  NativeWindowState,
  NotificationActionBackgroundModule,
} from "../modules/notification-action-background";
import { createActionWindows } from "../src/notification-action-background";
import type { ActionRequest } from "../src/notification-actions";
import { decision } from "./data";
import * as fakes from "./fakes";
import { clerkSingleton, DEFAULT_ACTION, deferred, push, tap, taskManager } from "./fakes";

// component-mobile-app §Notifications: the iOS background window and the
// module-scope wiring that the entry module loads. The native module, the
// Convex HTTP client, and Clerk's singleton are fakes. They check which
// native calls the JavaScript makes and in what order; they do not show that
// iOS grants background time, that the Swift compiles, or that a device
// behaves this way. The operator checks that on a physical iPhone and an
// Android phone before each store release.

// A fake of the native module. `delegateBegan` stands for the Swift delegate,
// which begins a press's window before JavaScript runs.
function fakeNative() {
  const windows = new Map<string, NativeWindow>();
  const listeners: ((event: { id: string }) => void)[] = [];
  let counter = 0;
  const delegateBegan = (
    requestId: string,
    actionId: string,
    state: NativeWindowState = "running",
  ): NativeWindow => {
    counter += 1;
    const window = { id: `w_${counter}`, state };
    windows.set(`${requestId}/${actionId}`, window);
    return window;
  };
  const native = {
    windows,
    delegateBegan,
    begin: jest.fn(
      async (requestId: string, actionId: string, _categoryId: string): Promise<NativeWindow> =>
        windows.get(`${requestId}/${actionId}`) ?? delegateBegan(requestId, actionId),
    ),
    finish: jest.fn(async (id: string) => {
      for (const window of windows.values()) {
        if (window.id === id && window.state === "running") window.state = "finished";
      }
    }),
    addListener: jest.fn((_event: "onExpire", listener: (event: { id: string }) => void) => {
      listeners.push(listener);
      return { remove: () => undefined };
    }),
    expire(id: string) {
      for (const window of windows.values()) {
        if (window.id === id) window.state = "expired";
      }
      for (const listener of listeners) listener({ id });
    },
  };
  return native;
}

const request: ActionRequest = {
  requestId: "n_1",
  categoryId: "decision-approve-reject",
  actionId: "approve",
  decisionId: "d_1",
};

describe("the window adapter", () => {
  test("without the native module every window protects nothing", async () => {
    const windows = createActionWindows(null, jest.fn());
    const window = await windows(request);

    expect(window.expired()).toBe(false);
    await expect(window.finish()).resolves.toBeUndefined();
  });

  test("adopts the delegate's window and ends it once", async () => {
    const native = fakeNative();
    const began = native.delegateBegan("n_1", "approve");
    const windows = createActionWindows(native, jest.fn());

    const window = await windows(request);
    expect(native.begin).toHaveBeenCalledWith("n_1", "approve", "decision-approve-reject");
    expect(native.windows.size).toBe(1);
    expect(window.expired()).toBe(false);

    await window.finish();
    await window.finish();
    expect(native.finish).toHaveBeenCalledTimes(1);
    expect(native.finish).toHaveBeenCalledWith(began.id);
  });

  test("an expiry from iOS reaches the window and its listeners", async () => {
    const native = fakeNative();
    const began = native.delegateBegan("n_1", "approve");
    const windows = createActionWindows(native, jest.fn());
    const window = await windows(request);
    const listener = jest.fn();
    window.onExpire(listener);

    native.expire(began.id);
    expect(window.expired()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a window that expired before adoption is expired", async () => {
    const native = fakeNative();
    native.delegateBegan("n_1", "approve", "expired");
    const window = await createActionWindows(native, jest.fn())(request);

    expect(window.expired()).toBe(true);
  });

  test.each<[NativeWindowState | "null" | "rejected", boolean]>([
    ["unavailable", true],
    ["finished", false],
    ["null", false],
    ["rejected", true],
  ])("a %s begin protects nothing", async (state, warns) => {
    const native = fakeNative();
    if (state === "null") {
      native.begin.mockResolvedValueOnce(null as unknown as NativeWindow);
    } else if (state === "rejected") {
      native.begin.mockRejectedValueOnce(new Error("bridge"));
    } else {
      native.delegateBegan("n_1", "approve", state);
    }
    const warn = jest.fn();
    const window = await createActionWindows(native, warn)(request);

    expect(window.expired()).toBe(false);
    await window.finish();
    expect(native.finish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });
});

// --- The module-scope wiring the entry module loads ---

type ClientCall = { url: string; name: string; args: unknown; auth: string | null };
const mockConvex = {
  calls: [] as ClientCall[],
  result: async (): Promise<unknown> =>
    decision({ id: "d_1", state: "answered", answer: { kind: "approve" } }),
};
jest.mock("convex/browser", () => {
  const { getFunctionName } = require("convex/server");
  return {
    ConvexHttpClient: class {
      private auth: string | null = null;
      private readonly address: string;
      constructor(address: string) {
        this.address = address;
      }
      setAuth(token: string) {
        this.auth = token;
      }
      async mutation(reference: unknown, args: unknown) {
        mockConvex.calls.push({
          url: this.address,
          name: getFunctionName(reference),
          args,
          auth: this.auth,
        });
        return mockConvex.result();
      }
    },
  };
});

const mockNativeModule = { current: null as NotificationActionBackgroundModule | null };
const mockRequireOptionalNativeModule = jest.fn((_name: string) => mockNativeModule.current);
jest.mock("expo", () => ({
  ...jest.requireActual("expo"),
  requireOptionalNativeModule: (name: string) => mockRequireOptionalNativeModule(name),
}));

function actionResponse(
  options: { requestId?: string; actionId?: string; android?: boolean } = {},
) {
  const { requestId = "n_1", actionId = "approve", android = false } = options;
  const data = { kind: "decision.created", eventId: "e_1", decisionId: "d_1" };
  return {
    actionIdentifier: actionId,
    notification: {
      date: 0,
      request: {
        identifier: requestId,
        content: {
          title: "Ship the release?",
          body: "acme · Claude",
          categoryIdentifier: "decision-approve-reject",
          ...(android ? { dataString: JSON.stringify(data) } : { data }),
        },
        trigger: { type: "push" },
      },
    },
  };
}

function coldClerk(sessionId: string | null) {
  const clerk = {
    loaded: false,
    session: undefined as { id: string; getToken: () => Promise<string> } | null | undefined,
    load: jest.fn(async () => {
      clerk.loaded = true;
      clerk.session =
        sessionId === null ? null : { id: sessionId, getToken: async () => `jwt-${sessionId}` };
    }),
  };
  return clerk;
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Loads the entry module's wiring in a fresh module registry, as a new app
// process does, on the given platform. The fresh registry shares this file's
// fakes, so the test drives and reads the same ones.
async function startApp(platform: "ios" | "android", run: () => Promise<void>) {
  await jest.isolateModulesAsync(async () => {
    jest.doMock("./fakes", () => fakes);
    const { Platform } = require("react-native");
    const original = Platform.OS;
    Platform.OS = platform;
    try {
      require("../src/notification-action-task");
      await run();
    } finally {
      Platform.OS = original;
    }
  });
}

const TASK = "agentdesk-notification-action";

beforeEach(() => {
  mockConvex.calls = [];
  mockConvex.result = async () =>
    decision({ id: "d_1", state: "answered", answer: { kind: "approve" } });
  mockNativeModule.current = null;
  mockRequireOptionalNativeModule.mockClear();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("on iOS", () => {
  test("registers the categories and the listener at load, and no notification task", async () => {
    await startApp("ios", async () => {
      await settle();
      expect(push.setNotificationCategoryAsync.mock.calls.map(([id]) => id)).toEqual([
        "decision-approve-reject",
        "decision-choice-2",
        "decision-choice-3",
      ]);
      expect(push.responseListeners.size).toBe(1);
      expect(taskManager.defineTask).not.toHaveBeenCalled();
      expect(push.registerTaskAsync).not.toHaveBeenCalled();
    });
  });

  test("a press through the live listener adopts the native window and ends it after the dismissal", async () => {
    const native = fakeNative();
    mockNativeModule.current = native;
    clerkSingleton.created = coldClerk("sess_a");
    await startApp("ios", async () => {
      const began = native.delegateBegan("n_1", "approve");
      tap(actionResponse());
      await settle();

      expect(mockRequireOptionalNativeModule).toHaveBeenCalledWith("NotificationActionBackground");
      expect(native.begin).toHaveBeenCalledWith("n_1", "approve", "decision-approve-reject");
      expect(clerkSingleton.getClerkInstance).toHaveBeenLastCalledWith({
        publishableKey: "pk_test_placeholder",
        tokenCache: {},
      });
      expect(mockConvex.calls).toEqual([
        {
          url: "https://test.convex.cloud",
          name: "decisions/app:answerFromNotification",
          args: { decisionId: "d_1", action: "approve" },
          auth: "jwt-sess_a",
        },
      ]);
      expect(push.dismissNotificationAsync).toHaveBeenCalledWith("n_1");
      expect(push.scheduleNotificationAsync).not.toHaveBeenCalled();
      expect(native.finish).toHaveBeenCalledWith(began.id);
      expect(native.finish.mock.invocationCallOrder[0]).toBeGreaterThan(
        push.dismissNotificationAsync.mock.invocationCallOrder[0] ?? Infinity,
      );
    });
  });

  test("a press that launched the app is answered once, and the launch response stays for the body-tap path", async () => {
    const native = fakeNative();
    mockNativeModule.current = native;
    clerkSingleton.created = coldClerk("sess_a");
    const launch = actionResponse();
    push.lastResponse = launch;
    native.delegateBegan("n_1", "approve");
    await startApp("ios", async () => {
      // The live listener delivers the same press too.
      tap(launch);
      await settle();

      expect(mockConvex.calls).toHaveLength(1);
      expect(native.begin).toHaveBeenCalledTimes(1);
      expect(native.finish).toHaveBeenCalledTimes(1);
      expect(push.lastResponse).toBe(launch);
    });
  });

  test("reuses the Clerk instance ClerkProvider made, without replacing its token cache", async () => {
    const provided = coldClerk("sess_a");
    clerkSingleton.instance = provided;
    await startApp("ios", async () => {
      tap(actionResponse());
      await settle();

      expect(clerkSingleton.getClerkInstance).toHaveBeenCalledWith();
      expect(clerkSingleton.getClerkInstance).not.toHaveBeenCalledWith(
        expect.objectContaining({ tokenCache: expect.anything() }),
      );
      expect(provided.load).toHaveBeenCalledTimes(1);
      expect(mockConvex.calls).toHaveLength(1);
    });
  });

  test("a body tap begins no window and sends nothing", async () => {
    const native = fakeNative();
    mockNativeModule.current = native;
    clerkSingleton.created = coldClerk("sess_a");
    await startApp("ios", async () => {
      tap(actionResponse({ actionId: DEFAULT_ACTION }));
      await settle();

      expect(native.begin).not.toHaveBeenCalled();
      expect(clerkSingleton.getClerkInstance).not.toHaveBeenCalled();
      expect(mockConvex.calls).toEqual([]);
      expect(push.scheduleNotificationAsync).not.toHaveBeenCalled();
    });
  });

  test("a window that expires while Clerk loads posts the generic failure and never sends", async () => {
    const native = fakeNative();
    mockNativeModule.current = native;
    const clerk = coldClerk("sess_a");
    const loading = deferred<undefined>();
    clerk.load.mockImplementationOnce(async () => {
      await loading.promise;
      clerk.loaded = true;
      clerk.session = { id: "sess_a", getToken: async () => "jwt-sess_a" };
    });
    clerkSingleton.created = clerk;
    await startApp("ios", async () => {
      const began = native.delegateBegan("n_1", "approve");
      tap(actionResponse());
      await settle();

      native.expire(began.id);
      await settle();
      expect(push.scheduleNotificationAsync).toHaveBeenCalledWith({
        content: {
          title: "AgentDesk",
          body: "Could not answer. Open AgentDesk to try again.",
          data: { kind: "decision.created", decisionId: "d_1" },
        },
        trigger: null,
      });

      loading.resolve(undefined);
      await settle();
      expect(mockConvex.calls).toEqual([]);
      expect(push.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(push.dismissNotificationAsync).not.toHaveBeenCalled();
    });
  });

  test("a conflict posts the recorded outcome and ends the window", async () => {
    const native = fakeNative();
    mockNativeModule.current = native;
    clerkSingleton.created = coldClerk("sess_a");
    mockConvex.result = async () => {
      // Required while the app's fresh registry is active, so the app's
      // error check recognizes the class.
      const { ConvexError } = require("convex/values");
      throw new ConvexError({
        code: "conflict",
        message: "Decision is already answered",
        decision: decision({ id: "d_1", state: "answered", answer: { kind: "reject" } }),
      });
    };
    await startApp("ios", async () => {
      tap(actionResponse());
      await settle();

      expect(push.scheduleNotificationAsync).toHaveBeenCalledWith({
        content: {
          title: "AgentDesk",
          body: "Already answered: Reject",
          data: { kind: "decision.created", decisionId: "d_1" },
        },
        trigger: null,
      });
      expect(native.finish).toHaveBeenCalledTimes(1);
    });
  });

  test("after sign-out, a press on a delivered notification posts the sign-in message and sends nothing", async () => {
    clerkSingleton.created = coldClerk(null);
    await startApp("ios", async () => {
      tap(actionResponse());
      await settle();

      expect(mockConvex.calls).toEqual([]);
      expect(push.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({ body: "Sign in to AgentDesk to answer" }),
        }),
      );
    });
  });

  test("a build without the native module still answers, unprotected", async () => {
    clerkSingleton.created = coldClerk("sess_a");
    await startApp("ios", async () => {
      tap(actionResponse());
      await settle();

      expect(mockConvex.calls).toHaveLength(1);
      expect(push.dismissNotificationAsync).toHaveBeenCalledWith("n_1");
    });
  });
});

describe("on Android", () => {
  test("defines and registers the notification task and never loads the iOS module", async () => {
    await startApp("android", async () => {
      await settle();

      expect(mockRequireOptionalNativeModule).not.toHaveBeenCalledWith(
        "NotificationActionBackground",
      );
      expect(taskManager.defineTask).toHaveBeenCalledWith(TASK, expect.any(Function));
      expect(push.registerTaskAsync).toHaveBeenCalledTimes(1);
      expect(push.registerTaskAsync).toHaveBeenCalledWith(TASK);
      expect(push.setNotificationCategoryAsync).toHaveBeenCalledTimes(3);
    });
  });

  test("a task the OS already holds is not registered again on a later launch", async () => {
    taskManager.registered.add(TASK);
    await startApp("android", async () => {
      await settle();
      expect(push.registerTaskAsync).not.toHaveBeenCalled();
    });
  });

  test("the task answers a press with no React tree mounted", async () => {
    clerkSingleton.created = coldClerk("sess_a");
    await startApp("android", async () => {
      const task = taskManager.defined.get(TASK);
      await task?.({
        data: actionResponse({ actionId: "reject", android: true }),
        error: null,
        executionInfo: { taskName: TASK },
      });

      expect(mockConvex.calls).toEqual([
        expect.objectContaining({ args: { decisionId: "d_1", action: "reject" } }),
      ]);
      expect(push.dismissNotificationAsync).toHaveBeenCalledWith("n_1");
    });
  });

  test("a receipt through the task does nothing", async () => {
    await startApp("android", async () => {
      const task = taskManager.defined.get(TASK);
      await task?.({
        data: { notification: null, data: { kind: "decision.created", decisionId: "d_1" } },
        error: null,
        executionInfo: { taskName: TASK },
      });

      expect(clerkSingleton.getClerkInstance).not.toHaveBeenCalled();
      expect(mockConvex.calls).toEqual([]);
      expect(push.scheduleNotificationAsync).not.toHaveBeenCalled();
    });
  });

  test("the task and the listener delivering one press send once", async () => {
    clerkSingleton.created = coldClerk("sess_a");
    await startApp("android", async () => {
      const task = taskManager.defined.get(TASK);
      const response = actionResponse({ android: true });
      tap(response);
      await task?.({ data: response, error: null, executionInfo: { taskName: TASK } });
      await settle();

      expect(mockConvex.calls).toHaveLength(1);
    });
  });

  test("an outcome notification uses the default channel", async () => {
    clerkSingleton.created = coldClerk(null);
    await startApp("android", async () => {
      const task = taskManager.defined.get(TASK);
      await task?.({
        data: actionResponse({ android: true }),
        error: null,
        executionInfo: { taskName: TASK },
      });

      expect(push.scheduleNotificationAsync).toHaveBeenCalledWith({
        content: {
          title: "AgentDesk",
          body: "Sign in to AgentDesk to answer",
          data: { kind: "decision.created", decisionId: "d_1" },
        },
        trigger: { channelId: "default" },
      });
    });
  });
});
