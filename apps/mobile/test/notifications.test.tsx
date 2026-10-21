import { router } from "expo-router";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AccessibilityInfo, AppState, type AppStateStatus, Platform } from "react-native";
import { startNotificationActions } from "../src/notification-actions";
import { DeviceRegistration, FOREGROUND_BEHAVIOR } from "../src/notifications";
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
  queryCalls,
  registerDevice,
  rotateDeviceToken,
  secureStore,
  setQuery,
  signInAs,
  signOutAll,
  tap,
  tapResponse,
} from "./fakes";
import { findInbox, pressTab, queryLargeTitle, renderApp } from "./render";

// component-mobile-app §Notifications: registration, the push explanation,
// token changes, failure states, foreground presentation, and tap routing
// (req-mobile-app REQ-4).

const installId = "00000000-0000-4000-8000-000000000001";
const INTRO_TITLE = "Get a buzz when an agent needs you";
const GRANTED = { granted: true, canAskAgain: true, status: "granted" };
const DENIED = { granted: false, canAskAgain: false, status: "denied" };

// The push explanation's Continue, which goes on to the system prompt.
async function continueIntro() {
  fireEvent.press(await screen.findByRole("button", { name: "Continue" }));
}

// The install id's writes, apart from the explanation's stored answer.
function installIdWrites() {
  return secureStore.setItemAsync.mock.calls.filter(([key]) => key === "agentdesk.installId")
    .length;
}

function introShown() {
  return screen.queryByRole("header", { name: INTRO_TITLE }) !== null;
}

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
  await findInbox();
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
  // This file opts into the push explanation: the shared fakes start with
  // it answered.
  secureStore.values.delete("agentdesk.pushIntro");
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
    await continueIntro();

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
    // iOS has no notification channels.
    expect(push.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  test("on Android creates the private, high-importance default channel before asking", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await openInbox();
    await continueIntro();

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    // DEC-17(6): the device's lock-screen setting decides what a locked
    // phone shows.
    expect(push.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(push.setNotificationChannelAsync).toHaveBeenCalledWith("default", {
      name: "Decisions and agents",
      importance: 6,
      lockscreenVisibility: 2,
    });
    // The channel exists before the permission read and the prompt, so
    // Android 13 shows the prompt.
    const channelCall = push.setNotificationChannelAsync.mock.invocationCallOrder[0] ?? 0;
    expect(channelCall).toBeLessThan(push.getPermissionsAsync.mock.invocationCallOrder[0] ?? 0);
    expect(channelCall).toBeLessThan(push.requestPermissionsAsync.mock.invocationCallOrder[0] ?? 0);
    expect(registerDevice.mock.calls[0]?.[0].platform).toBe("android");
  });

  test("falls back to the model name and then the platform for the device name", async () => {
    device.deviceName = null;
    await openInbox();
    await continueIntro();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(registerDevice.mock.calls[0]?.[0].name).toBe("iPhone 17");
  });

  test("keeps one install id across restarts, sign-out, and another sign-in", async () => {
    const first = await openInbox("sess_a");
    await continueIntro();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    // A restart: the app unmounts and mounts again with the same storage.
    first.unmount();
    await openInbox("sess_a");
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(2));

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    act(() => signInAs("sess_b"));
    await findInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(3));

    const ids = registerDevice.mock.calls.map(([args]) => args.deviceId);
    expect(ids).toEqual([installId, installId, installId]);
    expect(installIdWrites()).toBe(1);
  });

  test("runs once under strict mode's repeated effects", async () => {
    await openInbox("sess_a", { strict: true });
    // One explanation, so one Continue button.
    await continueIntro();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(registerDevice).toHaveBeenCalledTimes(1);
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(installIdWrites()).toBe(1);
  });

  test("a denied permission registers nothing and leaves the screens usable", async () => {
    push.requestResult = DENIED;
    serveScreens();
    await openInbox();
    await continueIntro();
    await waitFor(() => expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(registerDevice).not.toHaveBeenCalled();
    expect(push.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(installIdWrites()).toBe(0);

    pressTab("Settings");
    fireEvent.press(await screen.findByRole("button", { name: "Account" }));
    expect(
      await screen.findByText(
        "Notifications are off for this device. Allow them in system settings to get pushes.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeOnTheScreen();
  });

  test("does not explain or prompt again when the permission cannot be asked again", async () => {
    push.permission = DENIED;
    await openInbox();
    await waitFor(() => expect(push.getPermissionsAsync).toHaveBeenCalled());
    await act(async () => {});

    expect(introShown()).toBe(false);
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();
  });

  test("a permission granted earlier registers without the explanation or a prompt", async () => {
    push.permission = GRANTED;
    await openInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    expect(introShown()).toBe(false);
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test("registers when the person allows notifications in settings and returns", async () => {
    push.requestResult = DENIED;
    await openInbox();
    await continueIntro();
    await waitFor(() => expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(registerDevice).not.toHaveBeenCalled();

    push.permission = GRANTED;
    returnToForeground();

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test("a native token change gets a new Expo token and registers again", async () => {
    await openInbox();
    await continueIntro();
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
    await continueIntro();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    returnToForeground();
    await waitFor(() => expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(registerDevice).toHaveBeenCalledTimes(1);
  });

  test("a sign-out removes the token and app-state listeners", async () => {
    await openInbox();
    await continueIntro();
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
    await continueIntro();
    await waitFor(() => expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(1));

    act(() => signInAs("sess_b"));
    await findInbox();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    await act(async () => slowToken.resolve({ type: "expo", data: "ExponentPushToken[old]" }));

    expect(registerDevice).toHaveBeenCalledTimes(1);
    expect(registerDevice.mock.calls[0]?.[0].pushToken).toBe("ExponentPushToken[aaaa]");
  });

  describe("setup failures stay off the screens and offer a retry", () => {
    // These failures come after the permission, so notifications were
    // allowed earlier and no explanation shows.
    beforeEach(() => {
      push.permission = GRANTED;
    });

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
      push.permission = { granted: false, canAskAgain: true, status: "undetermined" };
      await openAccount();

      expect(
        await screen.findByText("Notifications need a physical iPhone or Android phone."),
      ).toBeOnTheScreen();
      expect(introShown()).toBe(false);
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

// Apple HIG Privacy: a permission never asked is explained before the system
// prompt, and the person can decline without being asked.
describe("push explanation", () => {
  test("an undetermined permission explains first, then Continue prompts and registers", async () => {
    const focus = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent");
    await openInbox();

    expect(await screen.findByRole("header", { name: INTRO_TITLE })).toBeOnTheScreen();
    expect(
      screen.getByText(
        "AgentDesk notifies you when an agent asks for a decision or finishes its work, and you can answer right from the notification.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Your rules and quiet hours decide what buzzes.")).toBeOnTheScreen();
    // VoiceOver starts on the title.
    expect(focus).toHaveBeenCalledWith(expect.anything(), "focus");
    await act(async () => {});
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();

    await continueIntro();

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(introShown()).toBe(false);
    expect(secureStore.values.get("agentdesk.pushIntro")).toBe("continue");
  });

  test("a Continue from an earlier launch whose prompt never showed asks directly", async () => {
    secureStore.values.set("agentdesk.pushIntro", "continue");
    await openInbox();

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(introShown()).toBe(false);
  });

  test("Continue then a denial registers nothing and shows the explanation no more", async () => {
    push.requestResult = DENIED;
    await openInbox();
    await continueIntro();
    await waitFor(() => expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1));

    returnToForeground();
    await act(async () => {});

    expect(introShown()).toBe(false);
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(registerDevice).not.toHaveBeenCalled();
  });

  test("Not now asks nothing, and later returns and launches remember it", async () => {
    const first = await openInbox();
    fireEvent.press(await screen.findByRole("button", { name: "Not now" }));
    await act(async () => {});

    expect(introShown()).toBe(false);
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();
    expect(secureStore.values.get("agentdesk.pushIntro")).toBe("not-now");

    // A return to the foreground in the same launch.
    returnToForeground();
    await act(async () => {});
    expect(introShown()).toBe(false);

    // A restart: the app mounts again with the same storage.
    first.unmount();
    const checks = push.getPermissionsAsync.mock.calls.length;
    await openInbox();
    await waitFor(() => expect(push.getPermissionsAsync.mock.calls.length).toBeGreaterThan(checks));
    await act(async () => {});

    expect(introShown()).toBe(false);
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  // The settings screens' "turn push on" buttons call the registration
  // status hook's retry, which is this method.
  test("a retry after Not now prompts directly, without the explanation, and registers", async () => {
    secureStore.values.set("agentdesk.pushIntro", "not-now");
    const registration = new DeviceRegistration();
    const register = jest.fn(async () => null);
    const stop = registration.start("sess_a", register);

    await waitFor(() => expect(registration.getStatus()).toEqual({ kind: "not-asked" }));
    expect(registration.getIntro()).toBe(false);
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();

    registration.retry();

    await waitFor(() => expect(registration.getStatus()).toEqual({ kind: "registered" }));
    expect(registration.getIntro()).toBe(false);
    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({
      deviceId: installId,
      pushToken: "ExponentPushToken[aaaa]",
      platform: "ios",
      name: "Kidus's iPhone",
    });
    stop();
  });
});

describe("foreground presentation", () => {
  test("shows a banner and list entry without sound or badge, and stays on the screen", async () => {
    await openInbox();
    await continueIntro();
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
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
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

    expect(await findInbox()).toBeOnTheScreen();
    expect(screen).toHavePathname("/");
  });

  test("a tap with malformed data opens the inbox", async () => {
    signInAs("sess_a");
    renderApp("/settings/account");
    await screen.findByRole("button", { name: "Sign out" });

    act(() => tap(tapResponse("n_4", { kind: "decision.created", decisionId: "../settings" })));

    expect(await findInbox()).toBeOnTheScreen();
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
    expect(await findInbox()).toBeOnTheScreen();
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
      expect(await findInbox()).toBeOnTheScreen();
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

    expect(await findInbox()).toBeOnTheScreen();
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

// component-notifications §Digests: a digest push carries
// `{ kind: "digest", digestId }` and no eventId.
describe("digest tap routing", () => {
  function digestFor(digestId: string) {
    return {
      id: digestId,
      sent_at: "2026-10-12T09:00:00.000Z",
      events: [],
      pending_decisions: [
        {
          id: "d_1",
          topic: "acme",
          title: `Pending in ${digestId}`,
          priority: "normal",
          deadline: null,
          state: "pending",
          answer: null,
          answered_at: null,
          applied_by_default: false,
          agent_session_id: "a_1",
          agent_name: "Claude on laptop",
          created_at: "2026-10-11T22:00:00.000Z",
        },
      ],
    };
  }

  beforeEach(() => {
    serveScreens();
    setQuery("notifications/digests:get", (args: { digestId: string }) => digestFor(args.digestId));
  });

  test("a digest tap opens the digest", async () => {
    await openInbox();

    act(() => tap(tapResponse("n_d1", { kind: "digest", digestId: "dg_1" })));

    expect(await screen.findByText("Pending in dg_1")).toBeOnTheScreen();
    expect(screen).toHavePathname("/digest/dg_1");
  });

  test("a digest tap with a malformed digest id opens the inbox", async () => {
    signInAs("sess_a");
    renderApp("/settings/account");
    await screen.findByRole("button", { name: "Sign out" });

    act(() => tap(tapResponse("n_d2", { kind: "digest", digestId: "../settings" })));

    expect(await findInbox()).toBeOnTheScreen();
    expect(screen).toHavePathname("/");
  });

  test("a digest tap that launched the app waits through sign-in and account setup, then opens once", async () => {
    const launch = tapResponse("n_d3", { kind: "digest", digestId: "dg_7" });
    push.lastResponse = launch;
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);

    renderApp("/");
    await screen.findByLabelText("Email address");
    expect(push.lastResponse).toBeNull();

    act(() => signInAs("sess_a"));
    await screen.findByText("Setting up your account");
    expect(screen).not.toHavePathname("/digest/dg_7");

    await act(async () => pending.resolve(account));

    expect(await screen.findByText("Pending in dg_7")).toBeOnTheScreen();
    expect(screen).toHavePathname("/digest/dg_7");

    // The live listener delivering the same launch tap opens nothing more.
    act(() => router.back());
    expect(await findInbox()).toBeOnTheScreen();
    act(() => tap(launch));
    await act(async () => {});
    expect(screen).toHavePathname("/");
  });

  test("a digest tap waiting when its session signs out does not open in the next session", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText("Setting up your account");

    act(() => tap(tapResponse("n_d4", { kind: "digest", digestId: "dg_8" })));
    act(() => signOutAll());
    await screen.findByLabelText("Email address");

    act(() => signInAs("sess_b"));

    expect(await findInbox()).toBeOnTheScreen();
    await act(async () => {});
    expect(screen).toHavePathname("/");
    expect(queryCalls.map((call) => call.name)).not.toContain("notifications/digests:get");
  });
});

// component-mobile-app §Notifications, notification actions: a press on an
// action button belongs to the action handler, never to tap routing, and
// device registration waits for this launch's action categories.
describe("notification actions alongside taps and registration", () => {
  beforeEach(() => serveScreens());

  test("an action button press opens no screen", async () => {
    await openInbox();

    act(() => tap(tapResponse("n_a1", { kind: "decision.created", decisionId: "d_1" }, "approve")));
    await act(async () => {});

    expect(screen).toHavePathname("/");
    expect(queryCalls.map((call) => call.name)).not.toContain("decisions/app:get");
  });

  test("an action press that launched the app opens no screen and a later body tap still routes", async () => {
    push.lastResponse = tapResponse(
      "n_a2",
      { kind: "decision.created", decisionId: "d_2" },
      "reject",
    );
    await openInbox();
    await act(async () => {});
    expect(screen).toHavePathname("/");

    act(() => tap(tapResponse("n_a3", { kind: "decision.created", decisionId: "d_3" })));

    expect(await screen.findByText("Decision d_3")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_3");
  });

  // Starting the actions is once per process, so this test starts them last.
  test("registration requests the Expo token only after the action categories settle", async () => {
    const categories = deferred<null>();
    void startNotificationActions(() => ({
      platform: "ios",
      setCategory: () => categories.promise,
      registerTask: async () => undefined,
      addResponseListener: () => undefined,
      lastResponse: () => null,
      handle: async () => undefined,
      warn: () => undefined,
    }));
    await openInbox();
    await continueIntro();
    await act(async () => {});

    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(push.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();

    await act(async () => categories.resolve(null));

    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
    expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  });
});
