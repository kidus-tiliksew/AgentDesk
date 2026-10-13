import type { NotificationSettings } from "../../../convex/notifications/settings";

// In-memory stand-ins for Clerk and the Convex client. Tests drive them
// directly: they set the Clerk session, script the sign-in and sign-up
// results, and control when ensureAccount settles. No test reaches Clerk or a
// Convex deployment.

type Listener = () => void;
type Result = { error: unknown };

const ok: Result = { error: null };

function store<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(next: T) {
      state = next;
    },
  };
}

// Clerk reports isSignedIn and sessionId as undefined until it has loaded,
// then false and null when signed out.
export const clerkState = store({
  isLoaded: true,
  isSignedIn: false as boolean | undefined,
  sessionId: null as string | null | undefined,
});

// Clerk before it has loaded, as on a cold start.
export function clerkLoading() {
  clerkState.set({ isLoaded: false, isSignedIn: undefined, sessionId: undefined });
}

// Clerk finishing its load with no session.
export function clerkLoadedSignedOut() {
  clerkState.set({ isLoaded: true, isSignedIn: false, sessionId: null });
}

export const convexAuthState = store({ isLoading: false, isAuthenticated: false });

// Signs a session in on both sides, as ConvexProviderWithClerk reports once
// the backend accepts the session's token.
export function signInAs(sessionId: string) {
  clerkState.set({ isLoaded: true, isSignedIn: true, sessionId });
  convexAuthState.set({ isLoading: false, isAuthenticated: true });
}

export function signOutAll() {
  clerkState.set({ isSignedIn: false, sessionId: null });
  convexAuthState.set({ isLoading: false, isAuthenticated: false });
}

export const signOut = jest.fn<Promise<void>, [{ sessionId?: string }?]>();

export const signIn = {
  status: "needs_identifier",
  emailCode: {
    sendCode: jest.fn<Promise<Result>, [{ emailAddress: string }?]>(),
    verifyCode: jest.fn<Promise<Result>, [{ code: string }]>(),
  },
  finalize: jest.fn<Promise<Result>, []>(),
};

export const signUp = {
  status: "missing_requirements",
  create: jest.fn<Promise<Result>, [{ emailAddress: string }]>(),
  verifications: {
    sendEmailCode: jest.fn<Promise<Result>, []>(),
    verifyEmailCode: jest.fn<Promise<Result>, [{ code: string }]>(),
  },
  finalize: jest.fn<Promise<Result>, []>(),
};

export const account = {
  _id: "users_1",
  _creationTime: 0,
  clerkUserId: "user_a",
  email: "a@example.com",
};

export const ensureAccount = jest.fn<Promise<typeof account>, [Record<string, never>]>();

// decisions/app:answer. Each test scripts its result; an unscripted call
// fails the test.
export type AnswerArgs = { decisionId: string; answer: unknown; note?: string };
export const answerDecision = jest.fn<Promise<unknown>, [AnswerArgs]>();

// notifications/devices:registerDevice and unregisterDevice. Both resolve by
// default.
export type RegisterArgs = {
  deviceId: string;
  pushToken: string;
  platform: "ios" | "android";
  name: string;
};
export const registerDevice = jest.fn<Promise<null>, [RegisterArgs]>();
export const unregisterDevice = jest.fn<Promise<null>, [{ deviceId: string }]>();

// identity/accountDeletion:deleteAccount. By default it resolves with a
// deletion that started at DELETION_STARTED and finishes 24 hours later.
export const DELETION_STARTED = Date.UTC(2026, 9, 13, 12, 0, 0);
export const DELETION_RESULT = {
  deletingAt: DELETION_STARTED,
  completeBy: DELETION_STARTED + 24 * 60 * 60_000,
};
// The token each account deletion call was authenticated with.
export const deletionTokens: (string | null)[] = [];

// A Clerk session token whose payload carries `sid`, the session it belongs
// to. Only the payload matters to the app.
export function fakeJwt(sessionId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ sid: sessionId, aud: "convex" })}.signature`;
}

// Clerk's getToken for the active session. Tests may script another token.
export const tokenFor = jest.fn<Promise<string | null>, [string | null | undefined]>();

export const deleteAccount = jest.fn<Promise<typeof DELETION_RESULT>, [Record<string, never>]>();

// notifications/settings:initializeTimeZone through the Convex client. By
// default it resolves with the settings the backend returns after recording a
// device zone.
export function deviceZoneSettings(timeZone: string): NotificationSettings {
  return {
    time_zone: timeZone,
    time_zone_source: "device",
    quiet_start: null,
    quiet_end: null,
    urgent_override: true,
    digest_time: "09:00",
    stale_threshold_minutes: 30,
  };
}
export const initializeTimeZone = jest.fn<Promise<NotificationSettings>, [{ timeZone: string }]>();

// expo-secure-store as an in-memory map that survives a simulated restart:
// only resetFakes clears it. `failReads` and `failWrites` make the calls
// reject.
type SecureStoreFake = {
  values: Map<string, string>;
  failReads: boolean;
  failWrites: boolean;
  getItemAsync: jest.Mock<Promise<string | null>, [string]>;
  setItemAsync: jest.Mock<Promise<void>, [string, string]>;
};
export const secureStore: SecureStoreFake = {
  values: new Map<string, string>(),
  failReads: false,
  failWrites: false,
  getItemAsync: jest.fn(async (key: string): Promise<string | null> => {
    if (secureStore.failReads) {
      throw new Error("Keychain unavailable");
    }
    return secureStore.values.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string): Promise<void> => {
    if (secureStore.failWrites) {
      throw new Error("Keychain unavailable");
    }
    secureStore.values.set(key, value);
  }),
};

// expo-crypto's randomUUID, numbered so a test can tell ids apart.
export const crypto = { next: 0 };
export function nextUuid() {
  crypto.next += 1;
  return `00000000-0000-4000-8000-${String(crypto.next).padStart(12, "0")}`;
}

// expo-device and expo-constants values the notification code reads.
export const device = {
  isDevice: true,
  deviceName: "Kidus's iPhone" as string | null,
  modelName: "iPhone 17" as string | null,
};
export const constants = { projectId: "eas-project-1" as string | null };

type PermissionStatus = { granted: boolean; canAskAgain: boolean; status: string };
type TokenListener = (token: { type: string; data: string }) => void;
type ResponseListener = (response: unknown) => void;

// expo-notifications. A test sets the permission it reports, what a request
// returns, and the Expo token; fires native token changes and taps; and reads
// the foreground handler the app installed.
type PushFake = {
  permission: PermissionStatus;
  requestResult: PermissionStatus;
  expoToken: string;
  tokenListeners: Set<TokenListener>;
  responseListeners: Set<ResponseListener>;
  lastResponse: unknown;
  handler: null | { handleNotification: (notification: unknown) => Promise<unknown> };
  getPermissionsAsync: jest.Mock<Promise<PermissionStatus>, []>;
  requestPermissionsAsync: jest.Mock<Promise<PermissionStatus>, []>;
  getExpoPushTokenAsync: jest.Mock<
    Promise<{ type: string; data: string }>,
    [{ projectId?: string }?]
  >;
  setNotificationChannelAsync: jest.Mock<Promise<null>, unknown[]>;
  scheduleNotificationAsync: jest.Mock<Promise<string>, unknown[]>;
  setBadgeCountAsync: jest.Mock<Promise<boolean>, unknown[]>;
  // Notification actions: category registration, the notification task, and
  // dismissal of an answered notification. Each resolves by default.
  setNotificationCategoryAsync: jest.Mock<Promise<unknown>, [string, unknown[], unknown?]>;
  registerTaskAsync: jest.Mock<Promise<null>, [string]>;
  dismissNotificationAsync: jest.Mock<Promise<void>, [string]>;
};
export const push: PushFake = {
  permission: { granted: false, canAskAgain: true, status: "undetermined" } as PermissionStatus,
  requestResult: { granted: true, canAskAgain: true, status: "granted" } as PermissionStatus,
  expoToken: "ExponentPushToken[aaaa]",
  tokenListeners: new Set<TokenListener>(),
  responseListeners: new Set<ResponseListener>(),
  lastResponse: null as unknown,
  handler: null as null | { handleNotification: (notification: unknown) => Promise<unknown> },
  getPermissionsAsync: jest.fn(async (): Promise<PermissionStatus> => push.permission),
  requestPermissionsAsync: jest.fn(async (): Promise<PermissionStatus> => {
    push.permission = push.requestResult;
    return push.requestResult;
  }),
  getExpoPushTokenAsync: jest.fn(async (_options?: { projectId?: string }) => ({
    type: "expo",
    data: push.expoToken,
  })),
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => "local"),
  setBadgeCountAsync: jest.fn(async () => true),
  setNotificationCategoryAsync: jest.fn(async (identifier: string, actions: unknown[]) => ({
    identifier,
    actions,
  })),
  registerTaskAsync: jest.fn(async (name: string) => {
    taskManager.registered.add(name);
    return null;
  }),
  dismissNotificationAsync: jest.fn(async (_identifier: string): Promise<void> => undefined),
};

// expo-task-manager: the tasks defined by name and the names the OS holds as
// registered. registerTaskAsync above adds a name here.
type TaskExecutor = (body: { data: unknown; error: unknown; executionInfo: unknown }) => unknown;
type TaskManagerFake = {
  defined: Map<string, TaskExecutor>;
  registered: Set<string>;
  defineTask: jest.Mock<void, [string, TaskExecutor]>;
  isTaskRegisteredAsync: jest.Mock<Promise<boolean>, [string]>;
};
export const taskManager: TaskManagerFake = {
  defined: new Map<string, TaskExecutor>(),
  registered: new Set<string>(),
  defineTask: jest.fn((name: string, executor: TaskExecutor) => {
    taskManager.defined.set(name, executor);
  }),
  isTaskRegisteredAsync: jest.fn(async (name: string) => taskManager.registered.has(name)),
};

// The Clerk singleton that getClerkInstance returns outside React.
// `instance` is the one ClerkProvider or an earlier call made; `created` is
// the one a call with options makes when there is none. Without options and
// without an instance, getClerkInstance throws, as Clerk does.
type ClerkSingletonFake = {
  instance: unknown;
  created: unknown;
  getClerkInstance: jest.Mock<unknown, [unknown?]>;
};
export const clerkSingleton: ClerkSingletonFake = {
  instance: null,
  created: null,
  getClerkInstance: jest.fn((options?: unknown): unknown => {
    if (clerkSingleton.instance === null && options !== undefined) {
      clerkSingleton.instance = clerkSingleton.created;
    }
    if (clerkSingleton.instance === null) {
      throw new Error("Clerk has not been initialized");
    }
    return clerkSingleton.instance;
  }),
};

// Fires a native push token change, as the OS reports a rotated APNs or FCM
// token.
export function rotateDeviceToken(data: string) {
  for (const listener of [...push.tokenListeners]) {
    listener({ type: "ios", data });
  }
}

export const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

// A notification response as expo-notifications delivers it for a tap.
export function tapResponse(identifier: string, data: unknown, actionIdentifier = DEFAULT_ACTION) {
  return {
    actionIdentifier,
    notification: {
      date: 0,
      request: {
        identifier,
        content: { title: "AgentDesk", body: null, data },
        trigger: null,
      },
    },
  };
}

// Delivers a tap to the app's live response listener.
export function tap(response: unknown) {
  for (const listener of [...push.responseListeners]) {
    listener(response);
  }
}

// A promise a test settles when it chooses.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A Clerk API failure as the sign-in and sign-up methods return it.
export function clerkApiError(code: string, message: string) {
  return { errors: [{ code, message, longMessage: message }] };
}

// Convex query results by function name, as useQuery returns them. A test sets
// a value, `loading`, an error that useQuery throws, or a function of the
// query's arguments. Setting a result re-renders every subscribed screen, as
// a Convex reactive query does when its data changes.
export const loading = Symbol("loading");
export const queries = store<Record<string, unknown>>({});
// One connected harness by default, so an empty inbox shows "All caught up"
// rather than the first-machine guide.
const defaultQueries: Record<string, unknown> = {
  "decisions/app:listPending": [],
  "agents/app:liveAgents": [],
  "identity/connections:listConnections": [
    {
      credentialId: "c_default",
      name: "Claude Code",
      machineName: "laptop",
      firstConnectedAt: 0,
    },
  ],
};

// Every useQuery call in render order, so a test can check which queries ran.
export const queryCalls: { name: string; args: unknown }[] = [];

export function setQuery(name: string, result: unknown) {
  queries.set({ [name]: result });
}

export function readQuery(name: string, args: unknown): unknown {
  queryCalls.push({ name, args });
  const results = queries.get();
  if (!(name in results)) {
    throw new Error(`Unexpected query ${name}`);
  }
  const result = results[name];
  const value = typeof result === "function" ? result(args) : result;
  if (value === loading) {
    return undefined;
  }
  if (value instanceof Error) {
    throw value;
  }
  return value;
}

// Restores the signed-out state and each fake's default behavior: every Clerk
// step succeeds, finalizing signs a session in, and ensureAccount resolves at
// once. Notification permission is undetermined and a request grants it, the
// device registers and unregisters, the first-launch time zone call
// resolves, and secure storage holds only an earlier Continue on the push
// explanation, so the system prompt shows without it (a test of the
// explanation deletes that answer). Each screen query returns an empty
// list. The answer mutation fails until a test scripts it.
export function resetFakes() {
  clerkState.reset({ isLoaded: true, isSignedIn: false, sessionId: null });
  convexAuthState.reset({ isLoading: false, isAuthenticated: false });
  signIn.status = "needs_identifier";
  signUp.status = "missing_requirements";
  // Clerk's signOut({ sessionId }) ends only that session.
  signOut.mockReset().mockImplementation(async (options) => {
    if (options?.sessionId === undefined || options.sessionId === clerkState.get().sessionId) {
      signOutAll();
    }
  });
  signIn.emailCode.sendCode.mockReset().mockResolvedValue(ok);
  signIn.emailCode.verifyCode.mockReset().mockImplementation(async () => {
    signIn.status = "complete";
    return ok;
  });
  signIn.finalize.mockReset().mockImplementation(async () => {
    signInAs("sess_signed_in");
    return ok;
  });
  signUp.create.mockReset().mockResolvedValue(ok);
  signUp.verifications.sendEmailCode.mockReset().mockResolvedValue(ok);
  signUp.verifications.verifyEmailCode.mockReset().mockImplementation(async () => {
    signUp.status = "complete";
    return ok;
  });
  signUp.finalize.mockReset().mockImplementation(async () => {
    signInAs("sess_signed_up");
    return ok;
  });
  ensureAccount.mockReset().mockResolvedValue(account);
  registerDevice.mockReset().mockResolvedValue(null);
  unregisterDevice.mockReset().mockResolvedValue(null);
  deleteAccount.mockReset().mockResolvedValue(DELETION_RESULT);
  deletionTokens.length = 0;
  tokenFor
    .mockReset()
    .mockImplementation(async (sessionId) => (sessionId ? fakeJwt(sessionId) : null));
  initializeTimeZone
    .mockReset()
    .mockImplementation(async ({ timeZone }) => deviceZoneSettings(timeZone));
  secureStore.values.clear();
  secureStore.values.set("agentdesk.pushIntro", "continue");
  secureStore.failReads = false;
  secureStore.failWrites = false;
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockClear();
  crypto.next = 0;
  device.isDevice = true;
  device.deviceName = "Kidus's iPhone";
  device.modelName = "iPhone 17";
  constants.projectId = "eas-project-1";
  push.permission = { granted: false, canAskAgain: true, status: "undetermined" };
  push.requestResult = { granted: true, canAskAgain: true, status: "granted" };
  push.expoToken = "ExponentPushToken[aaaa]";
  push.tokenListeners.clear();
  push.responseListeners.clear();
  push.lastResponse = null;
  push.handler = null;
  push.getPermissionsAsync.mockClear();
  push.requestPermissionsAsync.mockClear();
  push.getExpoPushTokenAsync.mockClear();
  push.setNotificationChannelAsync.mockClear();
  push.scheduleNotificationAsync.mockClear();
  push.setBadgeCountAsync.mockClear();
  push.setNotificationCategoryAsync.mockReset().mockImplementation(async (identifier, actions) => ({
    identifier,
    actions,
  }));
  push.registerTaskAsync.mockReset().mockImplementation(async (name) => {
    taskManager.registered.add(name);
    return null;
  });
  push.dismissNotificationAsync.mockReset().mockResolvedValue(undefined);
  taskManager.defined.clear();
  taskManager.registered.clear();
  taskManager.defineTask.mockClear();
  taskManager.isTaskRegisteredAsync.mockClear();
  clerkSingleton.instance = null;
  clerkSingleton.created = null;
  clerkSingleton.getClerkInstance.mockClear();
  answerDecision.mockReset().mockImplementation(async () => {
    throw new Error("Unexpected answer mutation");
  });
  queries.reset({ ...defaultQueries });
  queryCalls.length = 0;
}
