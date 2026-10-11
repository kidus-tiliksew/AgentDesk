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
      getToken: async () => "token",
    }),
    useSignIn: () => ({ signIn: fakes.signIn, errors: {}, fetchStatus: "idle" }),
    useSignUp: () => ({ signUp: fakes.signUp, errors: {}, fetchStatus: "idle" }),
  };
});

jest.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));

// useMutation hands out the ensureAccount, answer, and device fakes and
// refuses any other function, so a test fails if a screen calls Convex for
// anything else.
// useQuery reads the scripted query results and re-renders when a test
// changes them; "skip" runs no query, as in Convex.
jest.mock("convex/react", () => {
  const { useSyncExternalStore } = require("react");
  const { getFunctionName } = require("convex/server");
  const fakes = require("./fakes");
  return {
    ConvexReactClient: class {},
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
      throw new Error(`Unexpected mutation ${name}`);
    },
    useQuery: (reference: unknown, args: unknown = {}) => {
      useSyncExternalStore(fakes.queries.subscribe, fakes.queries.get);
      if (args === "skip") {
        return undefined;
      }
      return fakes.readQuery(getFunctionName(reference), args);
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
