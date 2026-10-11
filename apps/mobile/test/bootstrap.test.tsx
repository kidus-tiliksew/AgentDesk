import { ConvexError } from "convex/values";
import { act, fireEvent, screen } from "expo-router/testing-library";
import {
  account,
  clerkState,
  convexAuthState,
  deferred,
  ensureAccount,
  signInAs,
  signOut,
} from "./fakes";
import { renderApp } from "./render";

const inbox = "Your pending decisions and live agents will appear here.";
const settingUp = "Setting up your account";

describe("account bootstrap", () => {
  test("calls ensureAccount once and mounts the inbox only after it succeeds", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");

    renderApp("/", { strict: true });

    expect(screen.getByText(settingUp)).toBeOnTheScreen();
    expect(screen.queryByText(inbox)).not.toBeOnTheScreen();
    // A re-render while the call runs does not repeat it.
    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(ensureAccount).toHaveBeenCalledWith({});

    await act(async () => pending.resolve(account));

    expect(screen.getByText(inbox)).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
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

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
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
    expect(screen.queryByText(inbox)).not.toBeOnTheScreen();

    await act(async () => second.resolve(account));
    expect(screen.getByText(inbox)).toBeOnTheScreen();
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

    expect(screen.getByText(inbox)).toBeOnTheScreen();
  });

  test("a session change hides the app until the new session's account is ready", async () => {
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText(inbox);

    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    act(() => signInAs("sess_b"));

    expect(screen.getByText(settingUp)).toBeOnTheScreen();
    expect(screen.queryByText(inbox)).not.toBeOnTheScreen();

    await act(async () => pending.resolve(account));
    expect(screen.getByText(inbox)).toBeOnTheScreen();
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
    expect(screen.queryByText(inbox)).not.toBeOnTheScreen();
  });

  test("a transient failure offers a retry that calls ensureAccount again", async () => {
    ensureAccount.mockRejectedValueOnce(new Error("Network request failed"));
    signInAs("sess_a");
    renderApp("/");

    fireEvent.press(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    expect(ensureAccount).toHaveBeenCalledTimes(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  test("a session the backend refuses offers sign-out and calls nothing", async () => {
    signInAs("sess_a");
    convexAuthState.set({ isLoading: false, isAuthenticated: false });
    renderApp("/");

    expect(
      screen.getByText("The AgentDesk backend did not accept this sign-in."),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test("hides the app when Convex loses authentication after the account is ready", async () => {
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText(inbox);

    act(() => convexAuthState.set({ isLoading: true, isAuthenticated: false }));
    expect(screen.queryByText(inbox)).not.toBeOnTheScreen();
    expect(screen.getByText("Reconnecting")).toBeOnTheScreen();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: false }));
    expect(screen.queryByText(inbox)).not.toBeOnTheScreen();
    expect(
      screen.getByText("The AgentDesk backend did not accept this sign-in."),
    ).toBeOnTheScreen();

    act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
    expect(screen.getByText(inbox)).toBeOnTheScreen();
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
      expect(await screen.findByText(inbox)).toBeOnTheScreen();
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
      expect(screen.queryByText(inbox)).not.toBeOnTheScreen();

      act(() => convexAuthState.set({ isLoading: false, isAuthenticated: true }));
      expect(screen.queryByText(inbox)).not.toBeOnTheScreen();
      expect(ensureAccount).toHaveBeenCalledTimes(2);

      await act(async () => second.resolve(account));
      expect(screen.getByText(inbox)).toBeOnTheScreen();
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
