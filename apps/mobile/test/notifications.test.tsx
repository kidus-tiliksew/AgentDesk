import { router } from "expo-router";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AppState, type AppStateStatus } from "react-native";
import { FOREGROUND_BEHAVIOR } from "../src/notifications";
import { agent, decision } from "./data";
import {
  account,
  clerkLoadedSignedOut,
  clerkLoading,
  constants,
  deferred,
  device,
  ensureAccount,
  push,
  registerDevice,
  rotateDeviceToken,
  secureStore,
  setQuery,
  signInAs,
  signOutAll,
  tap,
  tapResponse,
} from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Notifications: registration, token changes, failure
// states, foreground presentation, and tap routing (req-mobile-app REQ-4).

const inbox = "No pending decisions.";
const installId = "00000000-0000-4000-8000-000000000001";

function serveScreens() {
  setQuery("decisions/app:get", (args: { decisionId: string }) =>
    decision({ id: args.decisionId, title: `Decision ${args.decisionId}` }),
  );
  setQuery("agents/app:get", (args: { agentSessionId: string }) => ({
    ...agent({ id: args.agentSessionId, display_name: `Agent ${args.agentSessionId}` }),
    history: [],
    pending_decisions: [],
  }));
}

async function openInbox(session = "sess_a", options: { strict?: boolean } = {}) {
  signInAs(session);
  const view = renderApp("/", options);
  await screen.findByText(inbox);
  return view;
}

// Every AppState change listener the app adds, so a test can return the app
// to the foreground.
let appStateListeners: ((state: AppStateStatus) => void)[];

function returnToForeground() {
  act(() => {
    for (const listener of appStateListeners) listener("active");
  });
}

beforeEach(() => {
  appStateListeners = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListeners.push(listener as (state: AppStateStatus) => void);
    return {
      remove: () => {
        appStateListeners = appStateListeners.filter((item) => item !== listener);
      },
    };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("device registration", () => {
  test("registers the install after the account is ready, not before", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    renderApp("/");

    await act(async () => {});
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();

    await act(async () => pending.resolve(account));

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(push.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "eas-project-1" });
    expect(registerDevice).toHaveBeenCalledWith({
      deviceId: installId,
      pushToken: "ExponentPushToken[aaaa]",
      platform: "ios",
      name: "Kidus's iPhone",
    });
    expect(secureStore.values.get("agentdesk.installId")).toBe(installId);
  });

  test("falls back to the model name and then the platform for the device name", async () => {
    device.deviceName = null;
    await openInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(registerDevice.mock.calls[0]?.[0].name).toBe("iPhone 17");
  });

  test("keeps one install id across restarts, sign-out, and another sign-in", async () => {
    const first = await openInbox("sess_a");
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    // A restart: the app unmounts and mounts again with the same storage.
    first.unmount();
    await openInbox("sess_a");
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(2));

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    act(() => signInAs("sess_b"));
    await screen.findByText(inbox);
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(3));

    const ids = registerDevice.mock.calls.map(([args]) => args.deviceId);
    expect(ids).toEqual([installId, installId, installId]);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  test("runs once under strict mode's repeated effects", async () => {
    await openInbox("sess_a", { strict: true });
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(registerDevice).toHaveBeenCalledTimes(1);
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  test("a denied permission registers nothing and leaves the screens usable", async () => {
    push.requestResult = { granted: false, canAskAgain: false, status: "denied" };
    serveScreens();
    await openInbox();
    await waitFor(() => expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(registerDevice).not.toHaveBeenCalled();
    expect(push.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText("Account"));
    expect(
      await screen.findByText(
        "Notifications are off for this device. Allow them in system settings to get pushes.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeOnTheScreen();
  });

  test("does not prompt again when the permission cannot be asked again", async () => {
    push.permission = { granted: false, canAskAgain: false, status: "denied" };
    await openInbox();
    await waitFor(() => expect(push.getPermissionsAsync).toHaveBeenCalled());
    await act(async () => {});

    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();
  });

  test("registers when the person allows notifications in settings and returns", async () => {
    push.requestResult = { granted: false, canAskAgain: false, status: "denied" };
    await openInbox();
    await waitFor(() => expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(registerDevice).not.toHaveBeenCalled();

    push.permission = { granted: true, canAskAgain: true, status: "granted" };
    returnToForeground();

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test("a native token change gets a new Expo token and registers again", async () => {
    await openInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    push.expoToken = "ExponentPushToken[bbbb]";
    act(() => rotateDeviceToken("apns-rotated"));

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(2));
    expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(2);
    expect(registerDevice).toHaveBeenLastCalledWith({
      deviceId: installId,
      pushToken: "ExponentPushToken[bbbb]",
      platform: "ios",
      name: "Kidus's iPhone",
    });
    // The raw native token never reaches the backend.
    const tokens = registerDevice.mock.calls.map(([args]) => args.pushToken);
    expect(tokens).not.toContain("apns-rotated");
  });

  test("a return to the foreground with an unchanged token sends nothing more", async () => {
    await openInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    returnToForeground();
    await waitFor(() => expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(registerDevice).toHaveBeenCalledTimes(1);
  });

  test("a sign-out removes the token and app-state listeners", async () => {
    await openInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.tokenListeners.size).toBe(1);

    act(() => signOutAll());
    await screen.findByLabelText("Email address");

    expect(push.tokenListeners.size).toBe(0);
    expect(appStateListeners).toEqual([]);
    act(() => rotateDeviceToken("apns-rotated"));
    await act(async () => {});
    expect(registerDevice).toHaveBeenCalledTimes(1);
  });

  test("an earlier session's token arriving after a session change is not registered", async () => {
    const slowToken = deferred<{ type: string; data: string }>();
    push.getExpoPushTokenAsync.mockReturnValueOnce(slowToken.promise);
    await openInbox("sess_a");
    await waitFor(() => expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(1));

    act(() => signInAs("sess_b"));
    await screen.findByText(inbox);
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    await act(async () => slowToken.resolve({ type: "expo", data: "ExponentPushToken[old]" }));

    expect(registerDevice).toHaveBeenCalledTimes(1);
    expect(registerDevice.mock.calls[0]?.[0].pushToken).toBe("ExponentPushToken[aaaa]");
  });

  describe("setup failures stay off the screens and offer a retry", () => {
    async function openAccount() {
      signInAs("sess_a");
      renderApp("/settings/account");
      await screen.findByRole("button", { name: "Sign out" });
    }

    test("a missing EAS project id", async () => {
      constants.projectId = null;
      await openAccount();

      expect(
        await screen.findByText("Notifications are not configured for this build."),
      ).toBeOnTheScreen();
      expect(push.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(registerDevice).not.toHaveBeenCalled();

      constants.projectId = "eas-project-1";
      fireEvent.press(screen.getByRole("button", { name: "Try notifications again" }));

      await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
      expect(
        screen.queryByText("Notifications are not configured for this build."),
      ).not.toBeOnTheScreen();
    });

    test("an unsupported runtime such as a simulator", async () => {
      device.isDevice = false;
      await openAccount();

      expect(
        await screen.findByText("Notifications need a physical iPhone or Android phone."),
      ).toBeOnTheScreen();
      expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(registerDevice).not.toHaveBeenCalled();
    });

    test("a token request failure", async () => {
      push.getExpoPushTokenAsync.mockRejectedValueOnce(new Error("offline"));
      await openAccount();

      expect(
        await screen.findByText("Could not get a push token for this device."),
      ).toBeOnTheScreen();
      expect(registerDevice).not.toHaveBeenCalled();

      fireEvent.press(screen.getByRole("button", { name: "Try notifications again" }));
      await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    });

    test("a registration failure", async () => {
      registerDevice.mockRejectedValueOnce(new Error("offline"));
      await openAccount();

      expect(
        await screen.findByText("Could not register this device for notifications."),
      ).toBeOnTheScreen();

      fireEvent.press(screen.getByRole("button", { name: "Try notifications again" }));
      await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.queryByText("Could not register this device for notifications."),
        ).not.toBeOnTheScreen(),
      );
    });

    test("a secure storage failure registers no ephemeral id", async () => {
      secureStore.failReads = true;
      await openAccount();

      expect(
        await screen.findByText("Could not read this device's id for notifications."),
      ).toBeOnTheScreen();
      expect(registerDevice).not.toHaveBeenCalled();
      expect(push.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    test("a failure returns to a working setup on the next foreground return", async () => {
      push.getExpoPushTokenAsync.mockRejectedValueOnce(new Error("offline"));
      await openAccount();
      await screen.findByText("Could not get a push token for this device.");

      returnToForeground();

      await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    });
  });
});

describe("foreground presentation", () => {
  test("shows a banner and list entry without sound or badge, and stays on the screen", async () => {
    await openInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.handler).not.toBeNull();

    const behavior = await act(() =>
      push.handler?.handleNotification(
        tapResponse("n_1", { kind: "decision.created", decisionId: "d_1" }).notification,
      ),
    );

    expect(behavior).toEqual(FOREGROUND_BEHAVIOR);
    expect(behavior).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    expect(screen).toHavePathname("/");
    expect(screen.getByText(inbox)).toBeOnTheScreen();
    expect(push.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(push.setBadgeCountAsync).not.toHaveBeenCalled();
  });
});

describe("tap routing", () => {
  beforeEach(() => serveScreens());

  test("a decision tap opens the decision", async () => {
    await openInbox();

    act(() => tap(tapResponse("n_1", { kind: "decision.created", decisionId: "d_1" })));

    expect(await screen.findByText("Decision d_1")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_1");
  });

  test("an agent tap opens the agent", async () => {
    await openInbox();

    act(() => tap(tapResponse("n_2", { kind: "agent.stale", agentSessionId: "a_1" })));

    expect(await screen.findByText("Running the test suite")).toBeOnTheScreen();
    expect(screen).toHavePathname("/agent/a_1");
  });

  test("a done agent tap opens the agent", async () => {
    await openInbox();

    act(() => tap(tapResponse("n_5", { kind: "agent.done", agentSessionId: "a_1" })));

    expect(await screen.findByText("Running the test suite")).toBeOnTheScreen();
    expect(screen).toHavePathname("/agent/a_1");
  });

  test("a tap with unknown data opens the inbox", async () => {
    signInAs("sess_a");
    renderApp("/settings/account");
    await screen.findByRole("button", { name: "Sign out" });

    act(() => tap(tapResponse("n_3", { kind: "decision.answered", decisionId: "d_1" })));

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    expect(screen).toHavePathname("/");
  });

  test("a tap with malformed data opens the inbox", async () => {
    signInAs("sess_a");
    renderApp("/settings/account");
    await screen.findByRole("button", { name: "Sign out" });

    act(() => tap(tapResponse("n_4", { kind: "decision.created", decisionId: "../settings" })));

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    expect(screen).toHavePathname("/");
  });

  test("a tap that launched the app waits through sign-in and account setup, then opens once", async () => {
    const launch = tapResponse("n_5", { kind: "decision.created", decisionId: "d_7" });
    push.lastResponse = launch;
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);

    renderApp("/");
    await screen.findByLabelText("Email address");
    // The launch response is consumed, so a later mount cannot read it.
    expect(push.lastResponse).toBeNull();

    act(() => signInAs("sess_a"));
    await screen.findByText("Setting up your account");
    expect(screen).not.toHavePathname("/decision/d_7");

    await act(async () => pending.resolve(account));

    expect(await screen.findByText("Decision d_7")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_7");

    // The live listener delivering the same launch tap opens nothing more.
    act(() => router.back());
    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    act(() => tap(launch));
    await act(async () => {});
    expect(screen).toHavePathname("/");
  });

  describe("a tap that launched the app while Clerk was still loading", () => {
    const launch = tapResponse("n_9", { kind: "decision.created", decisionId: "d_9" });

    function coldStart() {
      push.lastResponse = launch;
      clerkLoading();
      renderApp("/");
      expect(screen.getByText("Loading")).toBeOnTheScreen();
      expect(push.lastResponse).toBeNull();
    }

    // After the launch tap opened its screen, the same response from the live
    // listener opens nothing more.
    async function expectOpenedOnce() {
      expect(await screen.findByText("Decision d_9")).toBeOnTheScreen();
      expect(screen).toHavePathname("/decision/d_9");
      act(() => router.back());
      expect(await screen.findByText(inbox)).toBeOnTheScreen();
      act(() => tap(launch));
      await act(async () => {});
      expect(screen).toHavePathname("/");
    }

    test("opens once after Clerk loads signed out and the person signs in", async () => {
      const pending = deferred<typeof account>();
      ensureAccount.mockReturnValueOnce(pending.promise);
      coldStart();

      act(() => clerkLoadedSignedOut());
      await screen.findByLabelText("Email address");
      act(() => signInAs("sess_a"));
      await screen.findByText("Setting up your account");
      expect(screen).not.toHavePathname("/decision/d_9");

      await act(async () => pending.resolve(account));

      await expectOpenedOnce();
    });

    test("opens once after Clerk loads directly signed in", async () => {
      const pending = deferred<typeof account>();
      ensureAccount.mockReturnValueOnce(pending.promise);
      coldStart();

      act(() => signInAs("sess_a"));
      await screen.findByText("Setting up your account");
      expect(screen).not.toHavePathname("/decision/d_9");

      await act(async () => pending.resolve(account));

      await expectOpenedOnce();
    });
  });

  test("a tap waiting when its session signs out does not open in the next session", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText("Setting up your account");

    act(() => tap(tapResponse("n_6", { kind: "decision.created", decisionId: "d_8" })));
    act(() => signOutAll());
    await screen.findByLabelText("Email address");

    act(() => signInAs("sess_b"));

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    await act(async () => {});
    expect(screen).toHavePathname("/");
  });

  test("receiving a push without a tap navigates nowhere", async () => {
    await openInbox();

    await act(() =>
      push.handler?.handleNotification(
        tapResponse("n_7", { kind: "decision.created", decisionId: "d_1" }).notification,
      ),
    );

    expect(screen).toHavePathname("/");
  });
});
