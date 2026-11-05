import { ConvexError } from "convex/values";
import { router } from "expo-router";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { ActionSheetIOS, type ActionSheetIOSOptions } from "react-native";
import { screenName } from "../src/analytics";
import { DEFAULT_POSTHOG_HOST, readConfig } from "../src/config";
import { agent } from "./data";
import {
  account,
  analytics,
  clerkLoadedSignedOut,
  clerkLoading,
  deferred,
  ensureAccount,
  setQuery,
  signInAs,
  signOutAll,
} from "./fakes";
import { findInbox, renderApp } from "./render";

const env = {
  EXPO_PUBLIC_CONVEX_URL: "https://test.convex.cloud",
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
};

describe("analytics configuration", () => {
  test("is off without a PostHog project token", () => {
    const result = readConfig({ ...env, EXPO_PUBLIC_POSTHOG_KEY: "  " });

    expect(result).toEqual({
      ok: true,
      config: {
        convexUrl: env.EXPO_PUBLIC_CONVEX_URL,
        clerkPublishableKey: env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
        analytics: null,
      },
    });
  });

  test("uses the US cloud host unless one is set", () => {
    const token = { ...env, EXPO_PUBLIC_POSTHOG_KEY: "phc_test" };

    expect(readConfig(token)).toMatchObject({
      config: { analytics: { apiKey: "phc_test", host: DEFAULT_POSTHOG_HOST } },
    });
    expect(
      readConfig({ ...token, EXPO_PUBLIC_POSTHOG_HOST: " https://eu.i.posthog.com " }),
    ).toMatchObject({ config: { analytics: { host: "https://eu.i.posthog.com" } } });
  });
});

describe("analytics", () => {
  test("mounts no PostHog client and records nothing without a token", async () => {
    renderApp("/");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(analytics.provider).toBeNull();
    expect(analytics.screen).not.toHaveBeenCalled();
  });

  test("starts PostHog for identified people only, without location, replay, surveys, or touch capture", async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";

    renderApp("/");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(analytics.provider).toMatchObject({
      apiKey: "phc_test",
      autocapture: { captureScreens: false, captureTouches: false },
      options: {
        host: DEFAULT_POSTHOG_HOST,
        personProfiles: "identified_only",
        disableGeoip: true,
        captureAppLifecycleEvents: true,
        enableSessionReplay: false,
        disableSurveys: true,
        preloadFeatureFlags: false,
      },
    });
    await waitFor(() => expect(analytics.screen).toHaveBeenCalledWith("/sign-in"));
  });

  test("names a screen by its route pattern, never by the id in its URL", async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
    setQuery("agents/app:get", {
      ...agent({ id: "a_secret" }),
      history: [],
      pending_decisions: [],
    });
    signInAs("sess_a");

    renderApp("/agent/a_secret");

    await waitFor(() => expect(analytics.screen).toHaveBeenCalledWith("/agent/[id]"));
    for (const [name] of analytics.screen.mock.calls) {
      expect(name).not.toContain("a_secret");
    }
  });

  test("records the inbox as the root screen", async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
    signInAs("sess_a");

    renderApp("/");

    await findInbox();
    await waitFor(() => expect(analytics.screen).toHaveBeenLastCalledWith("/"));
  });
});

// component-mobile-app §Analytics identity (req-mobile-app AC-8.4 to AC-8.6).
describe("analytics identity", () => {
  const email = { email: account.email };
  const signedInScreen = async () => {
    await findInbox();
    await waitFor(() => expect(analytics.identifies()).toHaveLength(1));
  };

  beforeEach(() => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
  });

  test("identifies with the account's ID and email once the account is ready, and not before", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");

    renderApp("/");

    await screen.findByText("Setting up your account");
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(1));
    expect(analytics.identifies()).toEqual([]);

    await act(async () => pending.resolve(account));

    expect(analytics.identifies()).toEqual([
      expect.objectContaining({ id: account.clerkUserId, properties: email }),
    ]);
  });

  test("resets before identify when the distinct ID differs, and links none of the earlier anonymous ID", async () => {
    signInAs("sess_a");

    renderApp("/");
    await signedInScreen();

    const identity = analytics.calls.filter((entry) => entry.call !== "screen");
    expect(identity).toEqual([
      { call: "reset" },
      {
        call: "identify",
        id: account.clerkUserId,
        properties: email,
        linkedAnonymousId: "anon_1",
      },
    ]);
  });

  test("resets a different account's persisted identity before identify", async () => {
    analytics.persistIdentity("user_other");
    signInAs("sess_a");

    renderApp("/");
    await signedInScreen();

    expect(analytics.calls.filter((entry) => entry.call !== "screen")).toEqual([
      { call: "reset" },
      expect.objectContaining({ call: "identify", id: account.clerkUserId }),
    ]);
  });

  test("only identifies when the distinct ID matches, which carries a changed email", async () => {
    analytics.persistIdentity(account.clerkUserId);
    ensureAccount.mockResolvedValueOnce({ ...account, email: "new@example.com" });
    signInAs("sess_a");

    renderApp("/");
    await signedInScreen();

    expect(analytics.resets()).toEqual([]);
    expect(analytics.identifies()).toEqual([
      {
        call: "identify",
        id: account.clerkUserId,
        properties: { email: "new@example.com" },
        linkedAnonymousId: null,
      },
    ]);
  });

  test("a failed account identifies nobody, and its retry does", async () => {
    ensureAccount.mockRejectedValueOnce(new Error("offline"));
    signInAs("sess_a");

    renderApp("/");

    const retry = await screen.findByRole("button", { name: "Try again" });
    await act(async () => undefined);
    expect(analytics.identifies()).toEqual([]);

    fireEvent.press(retry);
    await signedInScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(2);
  });

  test("a rejected account identifies nobody and clears nothing it never set", async () => {
    ensureAccount.mockRejectedValueOnce(new ConvexError({ code: "unauthenticated" }));
    signInAs("sess_a");

    renderApp("/");

    await screen.findByLabelText("Email address");
    await waitFor(() => expect(analytics.screen).toHaveBeenLastCalledWith("/sign-in"));
    expect(analytics.identifies()).toEqual([]);
    expect(analytics.resets()).toEqual([]);
  });

  test("an account result after sign-out identifies nobody", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    renderApp("/");
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(1));

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    await act(async () => pending.resolve(account));

    expect(analytics.identifies()).toEqual([]);
  });

  test("a superseded session's account result identifies nobody", async () => {
    const first = deferred<typeof account>();
    const second = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    signInAs("sess_a");
    renderApp("/");
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(1));

    act(() => signInAs("sess_b"));
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve({ ...account, clerkUserId: "user_stale" }));
    expect(analytics.identifies()).toEqual([]);

    await act(async () => second.resolve(account));
    expect(analytics.identifies()).toEqual([expect.objectContaining({ id: account.clerkUserId })]);
  });

  test("waits for the SDK before comparing IDs, and a persisted match does not reset", async () => {
    analytics.persistIdentity(account.clerkUserId);
    const release = analytics.holdReady();
    signInAs("sess_a");

    renderApp("/");
    await findInbox();

    expect(analytics.calls).toEqual([]);

    await act(async () => release());

    expect(analytics.resets()).toEqual([]);
    expect(analytics.identifies()).toHaveLength(1);
  });

  test("a sign-out while the SDK starts drops the waiting identify", async () => {
    const release = analytics.holdReady();
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    await act(async () => release());

    expect(analytics.identifies()).toEqual([]);
  });

  test("a screen after identification carries the account", async () => {
    signInAs("sess_a");
    renderApp("/");
    await signedInScreen();

    act(() => router.push("/settings"));

    await waitFor(() => expect(analytics.screen).toHaveBeenLastCalledWith("/settings"));
    expect(analytics.screens().at(-1)).toEqual({
      call: "screen",
      name: "/settings",
      distinctId: account.clerkUserId,
    });
  });

  test("an ended session clears the identity once, and the sign-in screen carries no account", async () => {
    signInAs("sess_a");
    renderApp("/");
    await signedInScreen();
    analytics.calls = [];

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    await waitFor(() => expect(analytics.screen).toHaveBeenLastCalledWith("/sign-in"));

    expect(analytics.calls).toEqual([
      { call: "reset" },
      { call: "screen", name: "/sign-in", distinctId: "anon_2" },
    ]);
  });

  test("a sign-in screen's rerenders never reset an already anonymous client", async () => {
    renderApp("/");
    await screen.findByLabelText("Email address");
    await waitFor(() => expect(analytics.screen).toHaveBeenCalledWith("/sign-in"));

    act(() => clerkLoadedSignedOut());
    act(() => clerkLoadedSignedOut());
    await act(async () => undefined);

    expect(analytics.resets()).toEqual([]);
  });

  test("a launch with no session clears a persisted identity before its first screen", async () => {
    analytics.persistIdentity(account.clerkUserId);
    const release = analytics.holdReady();

    renderApp("/");
    await screen.findByLabelText("Email address");
    expect(analytics.calls).toEqual([]);

    await act(async () => release());

    expect(analytics.calls).toEqual([
      { call: "reset" },
      { call: "screen", name: "/sign-in", distinctId: "anon_1" },
    ]);
  });

  test("does nothing while Clerk loads, so a restored session keeps its identity", async () => {
    analytics.persistIdentity(account.clerkUserId);
    clerkLoading();

    renderApp("/");
    await screen.findByText("Loading");
    await act(async () => undefined);
    expect(analytics.calls).toEqual([]);

    act(() => signInAs("sess_a"));
    await signedInScreen();

    expect(analytics.resets()).toEqual([]);
    await waitFor(() => expect(analytics.screens()).toHaveLength(1));
    expect(analytics.screens()[0]).toEqual({
      call: "screen",
      name: "/",
      distinctId: account.clerkUserId,
    });
  });

  test("a session starting while the SDK starts keeps the queued clear, before its identify", async () => {
    analytics.persistIdentity("user_other");
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    const release = analytics.holdReady();

    renderApp("/");
    await screen.findByLabelText("Email address");
    expect(analytics.calls).toEqual([]);

    act(() => signInAs("sess_a"));
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(1));
    await act(async () => release());

    // The earlier account is gone while this session's account is still pending.
    expect(analytics.calls).toEqual([{ call: "reset" }]);
    expect(analytics.distinctId).not.toBe("user_other");

    await act(async () => pending.resolve(account));
    await waitFor(() => expect(analytics.screens()).toHaveLength(1));

    const calls = analytics.calls.map((entry) => entry.call);
    expect(calls.indexOf("reset")).toBe(0);
    expect(calls.indexOf("identify")).toBeGreaterThan(0);
    expect(analytics.screens()[0]?.distinctId).toBe(account.clerkUserId);
  });

  test("a restored session's first screen waits for identify, not the earlier account on the device", async () => {
    analytics.persistIdentity("user_other");
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");

    renderApp("/");
    await screen.findByText("Setting up your account");
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(analytics.calls).toEqual([]);

    await act(async () => pending.resolve(account));
    await waitFor(() => expect(analytics.screens()).toHaveLength(1));

    expect(analytics.calls).toEqual([
      { call: "reset" },
      expect.objectContaining({ call: "identify", id: account.clerkUserId }),
      { call: "screen", name: "/", distinctId: account.clerkUserId },
    ]);
  });

  test("the first screen after signing in carries the account, not an anonymous ID", async () => {
    renderApp("/");
    await screen.findByLabelText("Email address");
    await waitFor(() => expect(analytics.screen).toHaveBeenCalledWith("/sign-in"));

    act(() => signInAs("sess_a"));
    await findInbox();
    await waitFor(() => expect(analytics.screen).toHaveBeenLastCalledWith("/"));

    expect(analytics.screens()).toEqual([
      { call: "screen", name: "/sign-in", distinctId: "anon_0" },
      { call: "screen", name: "/", distinctId: account.clerkUserId },
    ]);
  });

  test("a failed account records no screen until its retry identifies", async () => {
    ensureAccount.mockRejectedValueOnce(new Error("offline"));
    signInAs("sess_a");

    renderApp("/");

    const retry = await screen.findByRole("button", { name: "Try again" });
    await act(async () => undefined);
    expect(analytics.calls).toEqual([]);

    fireEvent.press(retry);
    await signedInScreen();
    await waitFor(() => expect(analytics.screens()).toHaveLength(1));
    expect(analytics.screens()[0]?.distinctId).toBe(account.clerkUserId);
  });

  test("a new session's screen waits for its own identify", async () => {
    signInAs("sess_a");
    renderApp("/");
    await signedInScreen();
    await waitFor(() => expect(analytics.screens()).toHaveLength(1));

    const second = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(second.promise);
    const other = { ...account, clerkUserId: "user_b" };
    act(() => signInAs("sess_b"));
    await waitFor(() => expect(ensureAccount).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(analytics.screens()).toHaveLength(1);

    await act(async () => second.resolve(other));
    await waitFor(() => expect(analytics.screens()).toHaveLength(2));
    expect(analytics.screens()[1]?.distinctId).toBe("user_b");
  });

  test("makes no SDK call without a key, through account success and sign-out", async () => {
    delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
    analytics.persistIdentity(account.clerkUserId);
    const consoleError = jest.spyOn(console, "error");
    signInAs("sess_a");

    renderApp("/");
    await findInbox();
    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    await act(async () => undefined);

    expect(analytics.provider).toBeNull();
    expect(analytics.calls).toEqual([]);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("usePostHog"));
    consoleError.mockRestore();
  });
});

// The same observer serves every way an account leaves the device, so these
// drive the two that start from the account screen through its controls.
describe("analytics identity from the account screen", () => {
  const sheets: { options: ActionSheetIOSOptions; pick: (index: number) => void }[] = [];

  function choose(choice: string) {
    const sheet = sheets.at(-1);
    if (sheet === undefined) {
      throw new Error("No action sheet open");
    }
    act(() => sheet.pick(sheet.options.options.indexOf(choice)));
  }

  async function openAccount() {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
    signInAs("sess_a");
    renderApp("/settings/account");
    await waitFor(() => expect(analytics.identifies()).toHaveLength(1));
  }

  async function expectCleared() {
    await screen.findByLabelText("Email address");
    await waitFor(() => expect(analytics.screen).toHaveBeenLastCalledWith("/sign-in"));
    expect(analytics.resets()).toHaveLength(2);
    expect(analytics.screens().at(-1)?.distinctId).not.toBe(account.clerkUserId);
  }

  beforeEach(() => {
    sheets.length = 0;
    jest
      .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
      .mockImplementation((options, pick) => sheets.push({ options, pick }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Sign out clears the identity", async () => {
    await openAccount();

    fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));
    choose("Sign Out");

    await expectCleared();
  });

  test("Delete Account clears the identity", async () => {
    await openAccount();

    fireEvent.press(await screen.findByRole("button", { name: "Delete Account" }));
    choose("Delete Account");

    await expectCleared();
  });
});

describe("screenName", () => {
  test("drops layout groups and keeps dynamic segments as patterns", () => {
    expect(screenName([])).toBe("/");
    expect(screenName(["(auth)", "sign-in"])).toBe("/sign-in");
    expect(screenName(["(app)", "(tabs)", "(inbox,settled)", "agent", "[id]"])).toBe("/agent/[id]");
    expect(screenName(["(app)", "(tabs)", "settings", "rules"])).toBe("/settings/rules");
  });
});
