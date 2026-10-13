import { ConvexError } from "convex/values";
import { act, fireEvent, screen } from "expo-router/testing-library";
import { AUTH_WAIT_MS } from "../src/account-bootstrap";
import {
  account,
  clerkState,
  convexAuthState,
  deferred,
  ensureAccount,
  queryCalls,
  signInAs,
  signOut,
  signOutAll,
} from "./fakes";
import { findInbox, queryLargeTitle, renderApp } from "./render";

const settingUp = "Setting up your account";
const rejected = "The AgentDesk backend did not accept this sign-in.";

// Clerk signs a session in without changing what Convex reports. After a
// sign-out, ConvexProviderWithAuth keeps reporting {isLoading: false,
// isAuthenticated: false} until the backend answers for the new token.
function clerkSignsIn(sessionId: string) {
  act(() => clerkState.set({ isLoaded: true, isSignedIn: true, sessionId }));
}

function advance(ms: number) {
  act(() => jest.advanceTimersByTime(ms));
}

function expectSettingUp() {
  expect(screen.getByText(settingUp)).toBeOnTheScreen();
  expect(screen.queryByText(rejected)).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeOnTheScreen();
}

describe("a new session while Convex confirms its token", () => {
  test("shows setup, never the rejection, until Convex accepts the session", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    renderApp("/");
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();

    clerkSignsIn("sess_a");
    expectSettingUp();
    advance(3000);
    expectSettingUp();
    expect(ensureAccount).not.toHaveBeenCalled();
    expect(queryCalls).toEqual([]);

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expectSettingUp();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();

    await act(async () => pending.resolve(account));
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    expect(screen.queryByText(rejected)).not.toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
  });

  test("the same sequence under strict mode calls ensureAccount once", async () => {
    renderApp("/", { strict: true });
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();

    clerkSignsIn("sess_a");
    advance(AUTH_WAIT_MS - 1);
    expectSettingUp();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expect(await findInbox()).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
  });

  test("strict mode does not extend the wait", () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });
    renderApp("/", { strict: true });

    advance(AUTH_WAIT_MS - 1);
    expectSettingUp();
    advance(1);
    expect(screen.getByText(rejected)).toBeOnTheScreen();
  });

  test("a session that stays loading reaches the rejection at the deadline", () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: true, isAuthenticated: false });
    renderApp("/");

    advance(AUTH_WAIT_MS - 1);
    expectSettingUp();
    advance(1);
    expect(screen.getByText(rejected)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
    expect(queryCalls).toEqual([]);
  });

  test("a refusal reached from loading waits from the session's start", () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: true, isAuthenticated: false });
    renderApp("/");

    advance(5000);
    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: false }));
    expectSettingUp();
    // Loading changes do not restart the deadline.
    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: false }));
    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: false }));
    advance(AUTH_WAIT_MS - 5000 - 1);
    expectSettingUp();
    advance(1);
    expect(screen.getByText(rejected)).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
    expect(queryCalls).toEqual([]);
  });

  test("acceptance before the deadline cancels the rejection", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });
    renderApp("/");

    advance(AUTH_WAIT_MS - 1);
    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    advance(AUTH_WAIT_MS);
    expectSettingUp();
    expect(ensureAccount).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(account));
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    advance(AUTH_WAIT_MS);
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    expect(screen.queryByText(rejected)).not.toBeOnTheScreen();
  });

  test("acceptance after the deadline still sets up the account", async () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });
    renderApp("/");
    advance(AUTH_WAIT_MS);
    expect(screen.getByText(rejected)).toBeOnTheScreen();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));

    expect(await findInbox()).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(rejected)).not.toBeOnTheScreen();
  });

  test("a replacement session gets its own full wait", () => {
    renderApp("/");
    clerkSignsIn("sess_a");
    advance(6000);

    clerkSignsIn("sess_b");
    expectSettingUp();
    // sess_a's deadline passes.
    advance(4000);
    expectSettingUp();
    advance(AUTH_WAIT_MS - 4000 - 1);
    expectSettingUp();
    advance(1);
    expect(screen.getByText(rejected)).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test("a session after a timed-out one starts waiting again", () => {
    renderApp("/");
    clerkSignsIn("sess_a");
    advance(AUTH_WAIT_MS);
    expect(screen.getByText(rejected)).toBeOnTheScreen();

    clerkSignsIn("sess_b");
    expectSettingUp();
    advance(AUTH_WAIT_MS - 1);
    expectSettingUp();
  });

  test.each([
    ["success", (first: ReturnType<typeof deferred<typeof account>>) => first.resolve(account)],
    [
      "failure",
      (first: ReturnType<typeof deferred<typeof account>>) =>
        first.reject(new Error("Network request failed")),
    ],
    [
      "refusal",
      (first: ReturnType<typeof deferred<typeof account>>) =>
        first.reject(
          new ConvexError({ code: "unauthenticated", message: "Account is being deleted" }),
        ),
    ],
  ])("an earlier session's %s does not settle a waiting replacement", async (_, settle) => {
    const first = deferred<typeof account>();
    const second = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    signInAs("sess_a");
    renderApp("/");
    expect(ensureAccount).toHaveBeenCalledTimes(1);

    act(() => {
      clerkState.set({ sessionId: "sess_b" });
      convexAuthState.set({ isLoading: false, isAuthenticated: false });
    });
    await act(async () => settle(first));

    expectSettingUp();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();
    expect(signOut).not.toHaveBeenCalled();
    advance(AUTH_WAIT_MS - 1);
    expectSettingUp();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expect(ensureAccount).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(account));
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  // The route tree also schedules zero-delay timers, so each check first runs
  // those and then counts what is left: the wait's deadline or nothing.
  test("sign-out disposes of the wait", async () => {
    renderApp("/");
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    clerkSignsIn("sess_a");
    advance(0);
    expect(jest.getTimerCount()).toBe(1);

    act(() => signOutAll());

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    advance(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("unmounting disposes of the wait", () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });
    renderApp("/");
    advance(0);
    expect(jest.getTimerCount()).toBe(1);

    screen.unmount();

    jest.advanceTimersByTime(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("account bootstrap", () => {
  test("calls ensureAccount once and mounts the inbox only after it succeeds", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");

    renderApp("/", { strict: true });

    expect(screen.getByText(settingUp)).toBeOnTheScreen();
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();
    // A re-render while the call runs does not repeat it.
    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(ensureAccount).toHaveBeenCalledWith({});
    expect(queryCalls).toEqual([]);

    await act(async () => pending.resolve(account));

    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(queryCalls.map((call) => call.name)).toContain("decisions/app:listPending");
  });

  test("holds a directly opened settings route until the account exists", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");

    renderApp("/settings/account");

    expect(screen.getByText(settingUp)).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeOnTheScreen();

    await act(async () => pending.resolve(account));

    expect(screen.getByRole("button", { name: "Sign out" })).toBeOnTheScreen();
  });

  test("waits for Convex to accept the session before calling", async () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: true, isAuthenticated: false });

    renderApp("/");

    expect(screen.getByText(settingUp)).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));

    expect(await findInbox()).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
  });

  test("a late result for a previous session does not unlock the new session", async () => {
    const first = deferred<typeof account>();
    const second = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    signInAs("sess_a");
    renderApp("/");

    act(() => signInAs("sess_b"));
    expect(ensureAccount).toHaveBeenCalledTimes(2);

    await act(async () => first.resolve(account));
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();

    await act(async () => second.resolve(account));
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  test("a previous session's result arriving after the new session's keeps the app open", async () => {
    const first = deferred<typeof account>();
    const second = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    signInAs("sess_a");
    renderApp("/");
    act(() => signInAs("sess_b"));

    await act(async () => second.resolve(account));
    await act(async () => first.resolve(account));

    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  test("a session change hides the app until the new session's account is ready", async () => {
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    act(() => signInAs("sess_b"));

    expect(screen.getByText(settingUp)).toBeOnTheScreen();
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();

    await act(async () => pending.resolve(account));
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
  });

  test("an account being deleted ends the Clerk session and returns to sign-in", async () => {
    ensureAccount.mockRejectedValueOnce(
      new ConvexError({ code: "unauthenticated", message: "Account is being deleted" }),
    );
    signInAs("sess_a");

    renderApp("/");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ sessionId: "sess_a" });
    expect(screen).toHavePathname("/sign-in");
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();
  });

  test("a transient failure offers a retry that calls ensureAccount again", async () => {
    ensureAccount.mockRejectedValueOnce(new Error("Network request failed"));
    signInAs("sess_a");
    renderApp("/");

    fireEvent.press(await screen.findByRole("button", { name: "Try again" }));

    expect(await findInbox()).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  test("a session the backend refuses offers sign-out after the wait and calls nothing", async () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });
    renderApp("/");

    expectSettingUp();
    advance(AUTH_WAIT_MS - 1);
    expectSettingUp();
    advance(1);
    expect(screen.getByText(rejected)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test("hides the app when Convex loses authentication after the account is ready", async () => {
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: false }));
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();
    expect(screen.getByText("Reconnecting")).toBeOnTheScreen();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: false }));
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();
    expect(
      screen.getByText("The AgentDesk backend did not accept this sign-in."),
    ).toBeOnTheScreen();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
  });

  describe("while a new session waits for Convex", () => {
    function switchToWaitingSession() {
      act(() => {
        clerkState.set({ sessionId: "sess_b" });
        convexAuthState.set({ isLoading: true, isAuthenticated: false });
      });
    }

    test("an earlier session's refusal signs nothing out", async () => {
      const first = deferred<typeof account>();
      ensureAccount.mockReturnValueOnce(first.promise);
      signInAs("sess_a");
      renderApp("/");
      switchToWaitingSession();

      await act(async () =>
        first.reject(
          new ConvexError({ code: "unauthenticated", message: "Account is being deleted" }),
        ),
      );

      expect(signOut).not.toHaveBeenCalled();
      expect(clerkState.get()).toMatchObject({ isSignedIn: true, sessionId: "sess_b" });
      expect(screen.getByText(settingUp)).toBeOnTheScreen();

      act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
      expect(await findInbox()).toBeOnTheScreen();
      expect(ensureAccount).toHaveBeenCalledTimes(2);
    });

    test("an earlier session's success does not unlock the app", async () => {
      const first = deferred<typeof account>();
      const second = deferred<typeof account>();
      ensureAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      signInAs("sess_a");
      renderApp("/");
      switchToWaitingSession();

      await act(async () => first.resolve(account));
      expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();

      act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
      expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();
      expect(ensureAccount).toHaveBeenCalledTimes(2);

      await act(async () => second.resolve(account));
      expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    });

    test("an earlier session's failure offers no retry", async () => {
      const first = deferred<typeof account>();
      ensureAccount.mockReturnValueOnce(first.promise);
      signInAs("sess_a");
      renderApp("/");
      switchToWaitingSession();

      await act(async () => first.reject(new Error("Network request failed")));

      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
      expect(screen.getByText(settingUp)).toBeOnTheScreen();
    });
  });
});
