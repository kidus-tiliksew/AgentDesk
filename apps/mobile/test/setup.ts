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

// useMutation hands out the ensureAccount fake and refuses any other
// function, so a test fails if a screen calls Convex for anything else.
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
      if (name !== "identity/accounts:ensureAccount") {
        throw new Error(`Unexpected mutation ${name}`);
      }
      return fakes.ensureAccount;
    },
  };
});

jest.mock("convex/react-clerk", () => ({
  ConvexProviderWithClerk: ({ children }: { children: unknown }) => children,
}));

beforeEach(() => {
  resetFakes();
  process.env.EXPO_PUBLIC_CONVEX_URL = "https://test.convex.cloud";
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_placeholder";
});
