import { ConvexError } from "convex/values";
import { act, screen } from "expo-router/testing-library";
import { StyleSheet } from "react-native";
import { AUTH_WAIT_MS } from "../src/account-bootstrap";
import {
  account,
  clerkState,
  convexAuthState,
  deferred,
  ensureAccount,
  loading,
  setQuery,
  signInAs,
  signOut,
} from "./fakes";
import { renderApp } from "./render";

// Expo Router's root gives every route zero insets under Jest, so this file
// reports the insets of a phone with a status bar, a camera cutout, and a home
// indicator. The navigation stack's header reads the same insets.
const mockInsets = { top: 59, right: 0, bottom: 34, left: 0 };

jest.mock("react-native-safe-area-context", () => ({
  ...jest.requireActual("react-native-safe-area-context"),
  useSafeAreaInsets: () => mockInsets,
}));

const padding = 24;
const inset = {
  paddingTop: padding + mockInsets.top,
  paddingRight: padding + mockInsets.right,
  paddingBottom: padding + mockInsets.bottom,
  paddingLeft: padding + mockInsets.left,
};

type Element = ReturnType<typeof screen.getByText>;

// The nearest host view above an element that sets the screen padding.
function screenOf(element: Element) {
  let node: Element | null = element.parent;
  while (node !== null) {
    if (typeof node.type === "string") {
      const style = StyleSheet.flatten(node.props.style) ?? {};
      if (style.padding !== undefined || style.paddingTop !== undefined) {
        return style;
      }
    }
    node = node.parent;
  }
  throw new Error("No screen container above the element");
}

describe("safe areas on screens without a header", () => {
  test("sign-in clears the status bar and the home indicator", async () => {
    renderApp("/sign-in");

    const title = await screen.findByRole("header", { name: "AgentDesk" });

    expect(screenOf(title)).toMatchObject(inset);
  });

  test("the configuration screen is inset", () => {
    delete process.env.EXPO_PUBLIC_CONVEX_URL;

    renderApp("/");

    expect(screenOf(screen.getByText("AgentDesk is not configured"))).toMatchObject(inset);
  });

  test("the sign-in guard's loading state is inset", () => {
    clerkState.set({ isLoaded: false });

    renderApp("/sign-in");

    expect(screenOf(screen.getByText("Loading"))).toMatchObject(inset);
  });

  test("the app guard's loading state is inset", () => {
    clerkState.set({ isLoaded: false });

    renderApp("/");

    expect(screenOf(screen.getByText("Loading"))).toMatchObject(inset);
  });

  test("the account gate's setup and reconnecting states are inset", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    renderApp("/");

    expect(screenOf(screen.getByText("Setting up your account"))).toMatchObject(inset);

    await act(async () => pending.resolve(account));
    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: false }));

    expect(screenOf(screen.getByText("Reconnecting"))).toMatchObject(inset);
  });

  test("the account gate's failure state is inset", async () => {
    ensureAccount.mockRejectedValueOnce(new Error("offline"));
    signInAs("sess_a");
    renderApp("/");

    const message = await screen.findByText(
      "Could not set up your account. Check your connection.",
    );

    expect(screenOf(message)).toMatchObject(inset);
  });

  test("the account gate's signing-out state is inset", async () => {
    ensureAccount.mockRejectedValueOnce(
      new ConvexError({ code: "unauthenticated", message: "Account is being deleted" }),
    );
    signOut.mockReturnValueOnce(deferred<void>().promise);
    signInAs("sess_a");
    renderApp("/");

    expect(screenOf(await screen.findByText("Signing out"))).toMatchObject(inset);
  });

  test("the backend-rejected state is inset", () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });

    renderApp("/");
    // A new session reaches the rejection once its wait for Convex runs out.
    act(() => jest.advanceTimersByTime(AUTH_WAIT_MS));

    const message = screen.getByText("The AgentDesk backend did not accept this sign-in.");
    expect(screenOf(message)).toMatchObject(inset);
  });
});

describe("screens under a stack header", () => {
  test("keep their padding without the insets", async () => {
    setQuery("agents/app:get", loading);
    signInAs("sess_a");
    renderApp("/agent/as_1");

    const style = screenOf(await screen.findByText("Loading agent"));

    expect(style.padding).toBe(padding);
    expect(style.paddingTop).toBeUndefined();
    expect(style.paddingBottom).toBeUndefined();
  });
});
