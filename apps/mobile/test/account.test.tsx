import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AccessibilityInfo, ActionSheetIOS, type ActionSheetIOSOptions } from "react-native";
import {
  clerkState,
  convexAuthState,
  DELETION_RESULT,
  deferred,
  deleteAccount,
  deletionTokens,
  fakeJwt,
  push,
  registerDevice,
  rotateDeviceToken,
  secureStore,
  signInAs,
  signOut,
  signOutAll,
  tokenFor,
  unregisterDevice,
} from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Notifications: settings/account shows this device's
// push status, and sign-out there, once confirmed in an action sheet,
// unregisters this install before it ends the Clerk session (req-mobile-app
// AC-4.2).

const installId = "00000000-0000-4000-8000-000000000001";
const unregisterFailed =
  "Could not stop notifications on this device. Check your connection and try again.";

// Each action sheet the screen opens, with the callback that picks a choice.
const sheets: { options: ActionSheetIOSOptions; pick: (index: number) => void }[] = [];

beforeEach(() => {
  // This device already answered the permission prompt, so the push
  // explanation never covers the screen; notifications.test covers it.
  push.permission = { granted: true, canAskAgain: true, status: "granted" };
  sheets.length = 0;
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation((options, pick) => sheets.push({ options, pick }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Picks `choice` in the last action sheet the screen opened.
function choose(choice: string) {
  const sheet = sheets[sheets.length - 1];
  if (sheet === undefined) {
    throw new Error("No action sheet open");
  }
  act(() => sheet.pick(sheet.options.options.indexOf(choice)));
}

// Presses Sign out and confirms it in the action sheet.
function signOutConfirmed(button: ReturnType<typeof screen.getByRole>) {
  fireEvent.press(button);
  choose("Sign Out");
}

async function openAccount() {
  signInAs("sess_a");
  renderApp("/settings/account");
  return screen.findByRole("button", { name: "Sign out" });
}

async function openRegisteredAccount() {
  const button = await openAccount();
  await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));
  return button;
}

describe("account screen", () => {
  test("shows this device's name and push status, and Sign out", async () => {
    await openRegisteredAccount();

    expect(screen.getByRole("header", { name: "This device" })).toBeOnTheScreen();
    expect(screen.getByText("Kidus's iPhone")).toBeOnTheScreen();
    expect(await screen.findByText("Push on")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete Account" })).toBeEnabled();
  });

  test("VoiceOver reads the device row as one element with its push status and reason", async () => {
    push.permission = { granted: false, canAskAgain: false, status: "denied" };
    await openAccount();

    expect(
      await screen.findByLabelText(
        "Kidus's iPhone, Push off, Notifications are off for this device. Allow them in system settings to get pushes.",
      ),
    ).toBeOnTheScreen();
  });

  test("a denied permission reads as push off and points to system settings", async () => {
    push.permission = { granted: false, canAskAgain: false, status: "denied" };
    await openAccount();

    expect(
      await screen.findByText(
        "Notifications are off for this device. Allow them in system settings to get pushes.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Push off")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Try notifications again" })).not.toBeOnTheScreen();
  });
});

describe("account sign-out", () => {
  test("asks for confirmation in an action sheet before signing out", async () => {
    const button = await openRegisteredAccount();

    fireEvent.press(button);

    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.options).toEqual({
      title: "Sign out of AgentDesk?",
      message: "This device stops getting notifications until you sign in again.",
      options: ["Sign Out", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  test("a cancelled confirmation keeps the session signed in", async () => {
    const button = await openRegisteredAccount();

    fireEvent.press(button);
    choose("Cancel");
    await act(async () => {});

    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings/account");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  test("unregisters the install before ending the exact Clerk session, and keeps the id", async () => {
    signOutConfirmed(await openRegisteredAccount());

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(unregisterDevice).toHaveBeenCalledTimes(1);
    expect(unregisterDevice).toHaveBeenCalledWith({ deviceId: installId });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
    expect(unregisterDevice.mock.invocationCallOrder[0]).toBeLessThan(
      signOut.mock.invocationCallOrder[0] ?? 0,
    );
    expect(secureStore.values.get("agentdesk.installId")).toBe(installId);
  });

  test("an unregister failure keeps the session signed in and offers another attempt", async () => {
    unregisterDevice.mockRejectedValueOnce(new Error("Network request failed"));
    const button = await openRegisteredAccount();

    signOutConfirmed(button);

    expect(await screen.findByText(unregisterFailed)).toBeOnTheScreen();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(unregisterFailed);
    expect(signOut).not.toHaveBeenCalled();
    expect(clerkState.get()).toMatchObject({ isSignedIn: true, sessionId: "sess_a" });
    expect(screen).toHavePathname("/settings/account");
    const retry = screen.getByRole("button", { name: "Sign out" });
    expect(retry).toBeEnabled();
    expect(secureStore.values.get("agentdesk.installId")).toBe(installId);

    signOutConfirmed(retry);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(unregisterDevice).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("a secure storage failure at sign-out counts as an unregister failure", async () => {
    const button = await openRegisteredAccount();
    secureStore.failReads = true;

    signOutConfirmed(button);

    expect(await screen.findByText(unregisterFailed)).toBeOnTheScreen();
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  test("unregisters an id a previous launch stored even when this launch did not register", async () => {
    secureStore.values.set("agentdesk.installId", "earlier-install");
    push.permission = { granted: false, canAskAgain: false, status: "denied" };
    const button = await openAccount();
    await screen.findByText(
      "Notifications are off for this device. Allow them in system settings to get pushes.",
    );

    signOutConfirmed(button);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(registerDevice).not.toHaveBeenCalled();
    expect(unregisterDevice).toHaveBeenCalledWith({ deviceId: "earlier-install" });
  });

  test("an install with no stored id signs out without unregistering", async () => {
    push.permission = { granted: false, canAskAgain: false, status: "denied" };
    const button = await openAccount();
    await screen.findByText(
      "Notifications are off for this device. Allow them in system settings to get pushes.",
    );

    signOutConfirmed(button);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
  });

  test("waits for a registration in flight before unregistering", async () => {
    const registration = deferred<null>();
    registerDevice.mockReturnValueOnce(registration.promise);
    const button = await openAccount();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    signOutConfirmed(button);
    await act(async () => {});
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();

    await act(async () => registration.resolve(null));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(registerDevice.mock.invocationCallOrder[0]).toBeLessThan(
      unregisterDevice.mock.invocationCallOrder[0] ?? 0,
    );
    expect(unregisterDevice.mock.invocationCallOrder[0]).toBeLessThan(
      signOut.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("a token that arrives after sign-out started registers nothing", async () => {
    const token = deferred<{ type: string; data: string }>();
    push.getExpoPushTokenAsync.mockReturnValueOnce(token.promise);
    const button = await openAccount();
    await waitFor(() => expect(push.getExpoPushTokenAsync).toHaveBeenCalledTimes(1));

    signOutConfirmed(button);
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();

    await act(async () => token.resolve({ type: "expo", data: "ExponentPushToken[late]" }));

    expect(registerDevice).not.toHaveBeenCalled();
    expect(unregisterDevice).toHaveBeenCalledWith({ deviceId: installId });
  });

  test("a Clerk sign-out failure after unregistering reports it and registers nothing again", async () => {
    signOut.mockRejectedValueOnce(new Error("offline"));
    const button = await openRegisteredAccount();

    signOutConfirmed(button);

    expect(await screen.findByText("Could not sign out. Try again.")).toBeOnTheScreen();
    expect(screen.queryByText(unregisterFailed)).not.toBeOnTheScreen();
    expect(unregisterDevice).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/settings/account");

    // A token change while sign-out is pending does not register the device.
    push.expoToken = "ExponentPushToken[bbbb]";
    act(() => rotateDeviceToken("apns-rotated"));
    await act(async () => {});
    expect(registerDevice).toHaveBeenCalledTimes(1);

    signOutConfirmed(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(registerDevice).toHaveBeenCalledTimes(1);
  });

  test("disables the button while sign-out runs", async () => {
    const unregistering = deferred<null>();
    unregisterDevice.mockReturnValueOnce(unregistering.promise);
    const button = await openRegisteredAccount();

    signOutConfirmed(button);
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    // The disabled row opens no second confirmation.
    expect(sheets).toHaveLength(1);
    expect(unregisterDevice).toHaveBeenCalledTimes(1);

    await act(async () => unregistering.resolve(null));
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
  });
});

const deleteFailed = "Could not delete your account. Check your connection and try again.";
const signOutFailedAfterDelete =
  "Your account is being deleted, but this device could not sign out. Try again.";
const deletingNotice = /^Your account is being deleted\. Its data will be removed by .+\.$/;

// Presses Delete Account and confirms it in the action sheet.
function deleteConfirmed() {
  fireEvent.press(screen.getByRole("button", { name: "Delete Account" }));
  choose("Delete Account");
}

describe("account deletion", () => {
  test("Delete Account sits below Sign out and asks in an action sheet that says what goes and when", async () => {
    await openRegisteredAccount();

    const rows = screen.getAllByRole("button").map((row) => row.props.accessibilityLabel);
    expect(rows.indexOf("Delete Account")).toBeGreaterThan(rows.indexOf("Sign out"));
    fireEvent.press(screen.getByRole("button", { name: "Delete Account" }));

    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.options).toEqual({
      title: "Delete your AgentDesk account?",
      message:
        "This permanently deletes your account. Every connected machine and device is disconnected now, and your decisions, agents, rules, and notification settings are removed within 24 hours. This cannot be undone.",
      options: ["Delete Account", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  test("a cancelled confirmation deletes nothing and keeps the session", async () => {
    await openRegisteredAccount();

    fireEvent.press(screen.getByRole("button", { name: "Delete Account" }));
    choose("Cancel");
    await act(async () => {});

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings/account");
    expect(screen.getByRole("button", { name: "Delete Account" })).toBeEnabled();
  });

  test("deletes the account, ends the exact session, and sign-in says the account is being deleted", async () => {
    await openRegisteredAccount();

    deleteConfirmed();

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(screen.getByLabelText("Email address")).toBeOnTheScreen();
    expect(screen.getByText(deletingNotice).props.children).toContain(
      new Date(DELETION_RESULT.completeBy).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledWith({});
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
    expect(deleteAccount.mock.invocationCallOrder[0]).toBeLessThan(
      signOut.mock.invocationCallOrder[0] ?? 0,
    );
    // The backend removed this install with the account, so no separate
    // unregistration is sent; the install id stays stored.
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(secureStore.values.get("agentdesk.installId")).toBe(installId);
  });

  test("the notice goes away when another session signs in", async () => {
    await openRegisteredAccount();
    deleteConfirmed();
    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();

    act(() => signInAs("sess_b"));
    await act(async () => {});
    act(() => signOutAll());

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen.queryByText(deletingNotice)).not.toBeOnTheScreen();
  });

  test("shows progress and refuses a second press while the deletion runs", async () => {
    const deleting = deferred<typeof DELETION_RESULT>();
    deleteAccount.mockReturnValueOnce(deleting.promise);
    await openRegisteredAccount();

    deleteConfirmed();
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Deleting Account..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
    fireEvent.press(screen.getByRole("button", { name: "Deleting Account..." }));
    expect(sheets).toHaveLength(1);

    await act(async () => deleting.resolve(DELETION_RESULT));
    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(deleteAccount).toHaveBeenCalledTimes(1);
  });

  test("waits for a registration in flight, and a late token registers nothing", async () => {
    const registration = deferred<null>();
    registerDevice.mockReturnValueOnce(registration.promise);
    await openAccount();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    deleteConfirmed();
    await act(async () => {});
    expect(deleteAccount).not.toHaveBeenCalled();

    // A token change while the deletion waits registers nothing more.
    push.expoToken = "ExponentPushToken[bbbb]";
    act(() => rotateDeviceToken("apns-rotated"));
    await act(async () => registration.resolve(null));

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(registerDevice).toHaveBeenCalledTimes(1);
    expect(registerDevice.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAccount.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("a failed deletion keeps the session signed in and Try Again deletes it", async () => {
    deleteAccount.mockRejectedValueOnce(new Error("Network request failed"));
    await openRegisteredAccount();

    deleteConfirmed();

    expect(await screen.findByText(deleteFailed)).toBeOnTheScreen();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(deleteFailed);
    expect(signOut).not.toHaveBeenCalled();
    expect(clerkState.get()).toMatchObject({ isSignedIn: true, sessionId: "sess_a" });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();

    fireEvent.press(screen.getByRole("button", { name: "Try Again" }));

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(deleteAccount).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
  });

  test("a failed sign-out after the deletion retries only the sign-out", async () => {
    signOut.mockRejectedValueOnce(new Error("offline"));
    await openRegisteredAccount();

    deleteConfirmed();

    expect(await screen.findByText(signOutFailedAfterDelete)).toBeOnTheScreen();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      signOutFailedAfterDelete,
    );
    expect(deleteAccount).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByRole("button", { name: "Try Again" }));

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  test("finishes the sign-out after the account screen unmounts", async () => {
    const deleting = deferred<typeof DELETION_RESULT>();
    deleteAccount.mockReturnValueOnce(deleting.promise);
    await openRegisteredAccount();
    deleteConfirmed();
    await act(async () => {});

    // The account gate takes the routes down while Convex reconnects.
    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: true }));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeOnTheScreen();
    await act(async () => deleting.resolve(DELETION_RESULT));

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
  });

  test("a deletion that completes after another session signed in never signs that session out", async () => {
    const deleting = deferred<typeof DELETION_RESULT>();
    deleteAccount.mockReturnValueOnce(deleting.promise);
    await openRegisteredAccount();
    deleteConfirmed();
    await act(async () => {});

    act(() => signInAs("sess_b"));
    await act(async () => deleting.resolve(DELETION_RESULT));
    await act(async () => {});

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
    expect(clerkState.get()).toMatchObject({ isSignedIn: true, sessionId: "sess_b" });

    act(() => signOutAll());
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen.queryByText(deletingNotice)).not.toBeOnTheScreen();
  });

  // Review round 1, finding 1: the destructive call is bound to the session
  // that confirmed it.
  test("a deletion queued behind a registration never runs once another session is active", async () => {
    const registration = deferred<null>();
    registerDevice.mockReturnValueOnce(registration.promise);
    await openAccount();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    deleteConfirmed();
    await act(async () => {});
    expect(deleteAccount).not.toHaveBeenCalled();

    // Session B becomes active before the device queue drains.
    act(() => signInAs("sess_b"));
    await act(async () => registration.resolve(null));
    await act(async () => {});

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(clerkState.get()).toMatchObject({ isSignedIn: true, sessionId: "sess_b" });
    // Session B's own registration goes ahead on the same queue.
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(deletingNotice)).not.toBeOnTheScreen();
  });

  test("the deletion call carries the confirming session's own token", async () => {
    await openRegisteredAccount();

    deleteConfirmed();

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(deletionTokens).toEqual([fakeJwt("sess_a")]);
  });

  test("a token issued for another session is refused before any deletion", async () => {
    tokenFor.mockResolvedValueOnce(fakeJwt("sess_b"));
    await openRegisteredAccount();

    deleteConfirmed();

    expect(await screen.findByText(deleteFailed)).toBeOnTheScreen();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  // Review round 1, finding 3: the sign-out retry survives the account gate
  // taking the routes down.
  test("a failed sign-out after the account gate unmounted the screen still offers Try Again", async () => {
    const deleting = deferred<typeof DELETION_RESULT>();
    deleteAccount.mockReturnValueOnce(deleting.promise);
    signOut.mockRejectedValueOnce(new Error("offline"));
    await openRegisteredAccount();
    deleteConfirmed();
    await act(async () => {});

    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: true }));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeOnTheScreen();
    await act(async () => deleting.resolve(DELETION_RESULT));

    expect(await screen.findByText(signOutFailedAfterDelete)).toBeOnTheScreen();
    expect(screen.getByText(/removed by/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Try Again" }));

    expect(await screen.findByText(deletingNotice)).toBeOnTheScreen();
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenLastCalledWith({ sessionId: "sess_a" });
    expect(unregisterDevice).not.toHaveBeenCalled();
  });
});
