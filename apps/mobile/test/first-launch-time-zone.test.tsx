import { ConvexError } from "convex/values";
import { act, screen, waitFor } from "expo-router/testing-library";
import type { NotificationSettings } from "../../../convex/notifications/settings";
import {
  account,
  convexAuthState,
  deferred,
  ensureAccount,
  initializeTimeZone,
  registerDevice,
  signInAs,
  signOutAll,
} from "./fakes";
import { findInbox, queryLargeTitle, renderApp } from "./render";

// component-mobile-app §Notifications, first-launch time zone: once the
// account is ready, the app sends the device's zone to
// `notifications/settings:initializeTimeZone` at most once per Clerk session
// in each app launch (component-notifications §Settings).

// The zone this file's device reports: a zone name, undefined for a runtime
// that reports none, or an error that resolvedOptions throws.
let deviceZone: string | undefined | Error;

const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
const realSetImmediate: (callback: () => void) => void = jest.requireActual("timers").setImmediate;

beforeEach(() => {
  deviceZone = "Europe/Berlin";
  jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    if (deviceZone instanceof Error) {
      throw deviceZone;
    }
    const options = realResolvedOptions.call(this);
    return { ...options, timeZone: deviceZone as string };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function settle() {
  await act(async () => {});
  act(() => jest.advanceTimersByTime(0));
}

async function openInbox(session = "sess_a", options: { strict?: boolean } = {}) {
  signInAs(session);
  const view = renderApp("/", options);
  await findInbox();
  await settle();
  return view;
}

// Collects unhandled promise rejections while `run` executes.
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    // Node reports an unhandled rejection once the microtask queue drains,
    // so wait for a real macrotask; Jest's fake timers replace the global
    // setImmediate but not the one in the timers module.
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    await settle();
  } finally {
    process.off("unhandledRejection", listener);
  }
  return reasons;
}

describe("first-launch time zone", () => {
  test("sends nothing while signed out", async () => {
    renderApp("/");
    await screen.findByLabelText("Email address");
    await settle();

    expect(initializeTimeZone).not.toHaveBeenCalled();
  });

  test("sends nothing until Convex accepts the session and ensureAccount succeeds", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: false }));
    renderApp("/");
    await settle();
    expect(screen.getByText("Setting up your account")).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
    expect(initializeTimeZone).not.toHaveBeenCalled();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    await settle();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(initializeTimeZone).not.toHaveBeenCalled();

    await act(async () => pending.resolve(account));
    await findInbox();
    await settle();

    expect(initializeTimeZone).toHaveBeenCalledTimes(1);
    expect(initializeTimeZone).toHaveBeenCalledWith({ timeZone: "Europe/Berlin" });
  });

  test("a refused ensureAccount sends nothing", async () => {
    ensureAccount.mockRejectedValueOnce(new Error("offline"));
    signInAs("sess_a");
    renderApp("/");

    expect(
      await screen.findByText("Could not set up your account. Check your connection."),
    ).toBeOnTheScreen();
    await settle();
    expect(initializeTimeZone).not.toHaveBeenCalled();
  });

  test("sends once under strict mode's repeated effects", async () => {
    await openInbox("sess_a", { strict: true });

    expect(initializeTimeZone).toHaveBeenCalledTimes(1);
    expect(initializeTimeZone).toHaveBeenCalledWith({ timeZone: "Europe/Berlin" });
  });

  test("a remount of the routes in the same session sends nothing more", async () => {
    await openInbox("sess_a");
    expect(initializeTimeZone).toHaveBeenCalledTimes(1);

    // A Convex reconnect: the account gate unmounts the routes and mounts
    // them again for the same session.
    act(() => convexAuthState.set({ isLoading: true }));
    expect(await screen.findByText("Reconnecting")).toBeOnTheScreen();
    act(() => convexAuthState.set({ isLoading: false }));
    await findInbox();
    await settle();

    expect(initializeTimeZone).toHaveBeenCalledTimes(1);
    // Registration still runs alongside it.
    await waitFor(() => expect(registerDevice).toHaveBeenCalled());
  });

  test("a new session in the same launch sends again", async () => {
    await openInbox("sess_a");
    expect(initializeTimeZone).toHaveBeenCalledTimes(1);

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    act(() => signInAs("sess_b"));
    await findInbox();
    await settle();

    expect(initializeTimeZone).toHaveBeenCalledTimes(2);
    expect(initializeTimeZone).toHaveBeenLastCalledWith({ timeZone: "Europe/Berlin" });
  });

  test("a later app launch sends again, including after a failure", async () => {
    initializeTimeZone.mockRejectedValueOnce(new Error("offline"));
    const first = await openInbox("sess_a");
    expect(initializeTimeZone).toHaveBeenCalledTimes(1);

    // A restart: a fresh root provider for the same Clerk session.
    first.unmount();
    await openInbox("sess_a");

    expect(initializeTimeZone).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["reports no zone", undefined],
    ["reports a zone Intl refuses", "Not/A_Zone"],
    ["throws while reading the zone", new Error("no Intl")],
  ])("a device that %s sends nothing and keeps the inbox", async (_label, zone) => {
    deviceZone = zone;
    await openInbox("sess_a");

    expect(initializeTimeZone).not.toHaveBeenCalled();
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  test.each([
    ["a network failure", new Error("offline")],
    [
      "a refusal of the zone",
      new ConvexError({ code: "invalid", message: "Invalid timeZone", field: "timeZone" }),
    ],
  ])("%s leaves the inbox usable without an unhandled rejection", async (_label, error) => {
    initializeTimeZone.mockRejectedValueOnce(error);

    const reasons = await unhandledDuring(async () => {
      await openInbox("sess_a");
    });

    expect(initializeTimeZone).toHaveBeenCalledTimes(1);
    expect(reasons).toEqual([]);
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    expect(screen.queryByText(/time zone/i)).not.toBeOnTheScreen();
  });

  test("a zone the person already chose is left to the backend and nothing else is sent", async () => {
    const chosen: NotificationSettings = {
      time_zone: "America/New_York",
      time_zone_source: "user",
      quiet_start: null,
      quiet_end: null,
      urgent_override: true,
      digest_time: "09:00",
      stale_threshold_minutes: 30,
    };
    initializeTimeZone.mockResolvedValueOnce(chosen);

    await openInbox("sess_a");

    // The app sends only the first-launch call; the shared useMutation fake
    // would refuse an updateSettings call.
    expect(initializeTimeZone).toHaveBeenCalledTimes(1);
    expect(initializeTimeZone).toHaveBeenCalledWith({ timeZone: "Europe/Berlin" });
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  test("a call that settles after its session ended changes nothing", async () => {
    const pending = deferred<NotificationSettings>();
    initializeTimeZone.mockReturnValueOnce(pending.promise);
    await openInbox("sess_a");
    expect(initializeTimeZone).toHaveBeenCalledTimes(1);

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    await act(async () => pending.reject(new Error("offline")));
    await settle();

    expect(screen.getByLabelText("Email address")).toBeOnTheScreen();
    expect(initializeTimeZone).toHaveBeenCalledTimes(1);
  });
});
