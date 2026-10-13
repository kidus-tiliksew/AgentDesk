import { resetFakes } from "./fakes";

// Clerk and Convex are replaced by the fakes in ./fakes for every test.

jest.mock("@clerk/expo", () => {
  const { useSyncExternalStore } = require("react");
  const fakes = require("./fakes");
  return {
    ClerkProvider: ({ children }: { children: unknown }) => children,
    useAuth: () => ({
      ...useSyncExternalStore(fakes.clerkState.subscribe, fakes.clerkState.get),
      signOut: fakes.signOut,
      // Clerk's token for the active session; its `sid` claim names the
      // session, as Clerk's session tokens do.
      getToken: async () => fakes.tokenFor(fakes.clerkState.get().sessionId),
      sessionClaims: { aud: "convex" },
    }),
    useSignIn: () => ({ signIn: fakes.signIn, errors: {}, fetchStatus: "idle" }),
    useSignUp: () => ({ signUp: fakes.signUp, errors: {}, fetchStatus: "idle" }),
    getClerkInstance: fakes.clerkSingleton.getClerkInstance,
  };
});

jest.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));

// A ConvexHttpClient serves the account deletion fake and records the token
// it was authenticated with, so a test can check which session the
// destructive call carried. Any other function fails the test.
jest.mock("convex/browser", () => {
  const { getFunctionName } = require("convex/server");
  const fakes = require("./fakes");
  return {
    ConvexHttpClient: class {
      private token: string | null = null;
      setAuth(token: string) {
        this.token = token;
      }
      mutation(reference: unknown, args: unknown) {
        const name = getFunctionName(reference);
        if (name === "identity/accountDeletion:deleteAccount") {
          fakes.deletionTokens.push(this.token);
          return fakes.deleteAccount(args);
        }
        throw new Error(`Unexpected HTTP client mutation ${name}`);
      }
    },
  };
});

// useMutation hands out the ensureAccount, answer, device, and account
// deletion fakes and refuses any other function, so a test fails if a screen
// calls Convex for anything else.
// useQuery reads the scripted query results and re-renders when a test
// changes them; "skip" runs no query, as in Convex.
// useConvex returns one client whose `mutation` hands out the first-launch
// time zone fake and refuses any other function the same way.
jest.mock("convex/react", () => {
  const { useSyncExternalStore } = require("react");
  const { getFunctionName } = require("convex/server");
  const fakes = require("./fakes");
  const client = {
    mutation: (reference: unknown, args: unknown) => {
      const name = getFunctionName(reference);
      if (name === "notifications/settings:initializeTimeZone") {
        return fakes.initializeTimeZone(args);
      }
      throw new Error(`Unexpected client mutation ${name}`);
    },
  };
  return {
    ConvexReactClient: class {},
    useConvex: () => client,
    useConvexAuth: () =>
      useSyncExternalStore(fakes.convexAuthState.subscribe, fakes.convexAuthState.get),
    useMutation: (reference: unknown) => {
      const name = getFunctionName(reference);
      if (name === "identity/accounts:ensureAccount") {
        return fakes.ensureAccount;
      }
      if (name === "decisions/app:answer") {
        return fakes.answerDecision;
      }
      if (name === "notifications/devices:registerDevice") {
        return fakes.registerDevice;
      }
      if (name === "notifications/devices:unregisterDevice") {
        return fakes.unregisterDevice;
      }
      if (name === "identity/accountDeletion:deleteAccount") {
        return fakes.deleteAccount;
      }
      throw new Error(`Unexpected mutation ${name}`);
    },
    useQuery: (reference: unknown, args: unknown = {}) => {
      useSyncExternalStore(fakes.queries.subscribe, fakes.queries.get);
      if (args === "skip") {
        return undefined;
      }
      return fakes.readQuery(getFunctionName(reference), args);
    },
    // As in Convex, a failed query's error comes back as its value instead of
    // being thrown. A query no test scripted still throws, so a screen that
    // calls an unexpected query fails the test.
    useQueries: (requests: Record<string, { query: unknown; args: unknown }>) => {
      useSyncExternalStore(fakes.queries.subscribe, fakes.queries.get);
      const results: Record<string, unknown> = {};
      for (const [key, { query, args }] of Object.entries(requests)) {
        const name = getFunctionName(query);
        if (!(name in fakes.queries.get())) {
          throw new Error(`Unexpected query ${name}`);
        }
        try {
          results[key] = fakes.readQuery(name, args);
        } catch (error) {
          results[key] = error;
        }
      }
      return results;
    },
  };
});

jest.mock("convex/react-clerk", () => ({
  ConvexProviderWithClerk: ({ children }: { children: unknown }) => children,
}));

// Notifications, secure storage, the install id's UUID, the device, and the
// EAS project id read the fakes in ./fakes, so no test needs a physical
// device, push credentials, or a keychain.
jest.mock("expo-notifications", () => {
  const fakes = require("./fakes");
  const { push } = fakes;
  return {
    __esModule: true,
    DEFAULT_ACTION_IDENTIFIER: fakes.DEFAULT_ACTION,
    AndroidImportance: { HIGH: 6 },
    getPermissionsAsync: push.getPermissionsAsync,
    requestPermissionsAsync: push.requestPermissionsAsync,
    getExpoPushTokenAsync: push.getExpoPushTokenAsync,
    setNotificationChannelAsync: push.setNotificationChannelAsync,
    scheduleNotificationAsync: push.scheduleNotificationAsync,
    setBadgeCountAsync: push.setBadgeCountAsync,
    setNotificationCategoryAsync: push.setNotificationCategoryAsync,
    registerTaskAsync: push.registerTaskAsync,
    dismissNotificationAsync: push.dismissNotificationAsync,
    setNotificationHandler: (handler: unknown) => {
      push.handler = handler;
    },
    addPushTokenListener: (listener: unknown) => {
      push.tokenListeners.add(listener);
      return { remove: () => push.tokenListeners.delete(listener) };
    },
    addNotificationResponseReceivedListener: (listener: unknown) => {
      push.responseListeners.add(listener);
      return { remove: () => push.responseListeners.delete(listener) };
    },
    getLastNotificationResponse: () => push.lastResponse,
    clearLastNotificationResponse: () => {
      push.lastResponse = null;
    },
  };
});

// The notification action task's definition and registration state.
jest.mock("expo-task-manager", () => {
  const { taskManager } = require("./fakes");
  return {
    __esModule: true,
    defineTask: taskManager.defineTask,
    isTaskRegisteredAsync: taskManager.isTaskRegisteredAsync,
  };
});

jest.mock("expo-secure-store", () => {
  const { secureStore } = require("./fakes");
  return {
    __esModule: true,
    getItemAsync: secureStore.getItemAsync,
    setItemAsync: secureStore.setItemAsync,
  };
});

jest.mock("expo-crypto", () => ({
  __esModule: true,
  randomUUID: () => require("./fakes").nextUuid(),
}));

jest.mock("expo-device", () => {
  const { device } = require("./fakes");
  return {
    __esModule: true,
    get isDevice() {
      return device.isDevice;
    },
    get deviceName() {
      return device.deviceName;
    },
    get modelName() {
      return device.modelName;
    },
  };
});

jest.mock("expo-constants", () => {
  const { constants } = require("./fakes");
  return {
    __esModule: true,
    default: {
      get expoConfig() {
        return constants.projectId === null
          ? { extra: {} }
          : { extra: { eas: { projectId: constants.projectId } } };
      },
      easConfig: null,
    },
  };
});

beforeEach(() => {
  resetFakes();
  process.env.EXPO_PUBLIC_CONVEX_URL = "https://test.convex.cloud";
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_placeholder";
});
