import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import {
  clerkState,
  deferred,
  push,
  registerDevice,
  rotateDeviceToken,
  secureStore,
  signInAs,
  signOut,
  unregisterDevice,
} from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Notifications: sign-out on settings/account
// unregisters this install before it ends the Clerk session
// (req-mobile-app AC-4.2).

const installId = "00000000-0000-4000-8000-000000000001";
const unregisterFailed =
  "Could not stop notifications on this device. Check your connection and try again.";

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

describe("account sign-out", () => {
  test("unregisters the install before ending the exact Clerk session, and keeps the id", async () => {
    fireEvent.press(await openRegisteredAccount());

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

    fireEvent.press(button);

    expect(await screen.findByText(unregisterFailed)).toBeOnTheScreen();
    expect(signOut).not.toHaveBeenCalled();
    expect(clerkState.get()).toMatchObject({ isSignedIn: true, sessionId: "sess_a" });
    expect(screen).toHavePathname("/settings/account");
    const retry = screen.getByRole("button", { name: "Sign out" });
    expect(retry).toBeEnabled();
    expect(secureStore.values.get("agentdesk.installId")).toBe(installId);

    fireEvent.press(retry);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(unregisterDevice).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("a secure storage failure at sign-out counts as an unregister failure", async () => {
    const button = await openRegisteredAccount();
    secureStore.failReads = true;

    fireEvent.press(button);

    expect(await screen.findByText(unregisterFailed)).toBeOnTheScreen();
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  test("unregisters an id a previous launch stored even when this launch did not register", async () => {
    secureStore.values.set("agentdesk.installId", "earlier-install");
    push.requestResult = { granted: false, canAskAgain: false, status: "denied" };
    const button = await openAccount();
    await screen.findByText(
      "Notifications are off for this device. Allow them in system settings to get pushes.",
    );

    fireEvent.press(button);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(registerDevice).not.toHaveBeenCalled();
    expect(unregisterDevice).toHaveBeenCalledWith({ deviceId: "earlier-install" });
  });

  test("an install with no stored id signs out without unregistering", async () => {
    push.requestResult = { granted: false, canAskAgain: false, status: "denied" };
    const button = await openAccount();
    await screen.findByText(
      "Notifications are off for this device. Allow them in system settings to get pushes.",
    );

    fireEvent.press(button);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(unregisterDevice).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
  });

  test("waits for a registration in flight before unregistering", async () => {
    const registration = deferred<null>();
    registerDevice.mockReturnValueOnce(registration.promise);
    const button = await openAccount();
    await waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1));

    fireEvent.press(button);
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

    fireEvent.press(button);
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();

    await act(async () => token.resolve({ type: "expo", data: "ExponentPushToken[late]" }));

    expect(registerDevice).not.toHaveBeenCalled();
    expect(unregisterDevice).toHaveBeenCalledWith({ deviceId: installId });
  });

  test("a Clerk sign-out failure after unregistering reports it and registers nothing again", async () => {
    signOut.mockRejectedValueOnce(new Error("offline"));
    const button = await openRegisteredAccount();

    fireEvent.press(button);

    expect(await screen.findByText("Could not sign out. Try again.")).toBeOnTheScreen();
    expect(screen.queryByText(unregisterFailed)).not.toBeOnTheScreen();
    expect(unregisterDevice).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/settings/account");

    // A token change while sign-out is pending does not register the device.
    push.expoToken = "ExponentPushToken[bbbb]";
    act(() => rotateDeviceToken("apns-rotated"));
    await act(async () => {});
    expect(registerDevice).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(registerDevice).toHaveBeenCalledTimes(1);
  });

  test("disables the button while sign-out runs", async () => {
    const unregistering = deferred<null>();
    unregisterDevice.mockReturnValueOnce(unregistering.promise);
    const button = await openRegisteredAccount();

    fireEvent.press(button);
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    expect(unregisterDevice).toHaveBeenCalledTimes(1);

    await act(async () => unregistering.resolve(null));
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
  });
});
