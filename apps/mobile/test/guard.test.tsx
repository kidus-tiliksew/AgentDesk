import { fireEvent, screen } from "expo-router/testing-library";
import { clerkState, ensureAccount, setQuery, signInAs, signOut } from "./fakes";
import { renderApp } from "./render";

const inbox = "No pending decisions.";

describe("route guards", () => {
  test("sends a signed-out person from the inbox to sign-in", async () => {
    renderApp("/");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test("sends a signed-out person from a settings route to sign-in", async () => {
    renderApp("/settings/account");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
  });

  test("sends a signed-out person from history to sign-in", async () => {
    renderApp("/history");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test.each([
    "/settings/rules",
    "/settings/rule/new",
    "/settings/rule/r_1",
    "/settings/notifications",
  ])("sends a signed-out person from %s to sign-in", async (url) => {
    renderApp(url);

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  test("sends a signed-in person from sign-in to the inbox", async () => {
    signInAs("sess_a");

    renderApp("/sign-in");

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    expect(screen).toHavePathname("/");
  });

  test("redirects nowhere until Clerk has loaded", () => {
    clerkState.set({ isLoaded: false });

    renderApp("/");

    expect(screen.getByText("Loading")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Email address")).not.toBeOnTheScreen();
    expect(screen).toHavePathname("/");
  });
});

describe("navigation", () => {
  test("the inbox header shows the history, rules, and settings links", async () => {
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText(inbox);

    expect(screen.getByText("History")).toBeOnTheScreen();
    expect(screen.getByText("Rules")).toBeOnTheScreen();
    expect(screen.getByText("Notifications")).toBeOnTheScreen();
    expect(screen.getByText("Connections")).toBeOnTheScreen();
    expect(screen.getByText("Account")).toBeOnTheScreen();
  });

  test("the inbox header links to the settings screens", async () => {
    setQuery("identity/connections:listConnections", []);
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText(inbox);

    fireEvent.press(screen.getByText("Connections"));
    expect(await screen.findByText("No connected harnesses.")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/connections");
  });

  test("signing out from the account screen returns to sign-in", async () => {
    signInAs("sess_a");
    renderApp("/settings/account");

    fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/sign-in");
  });

  test("a failed sign-out keeps the account screen and reports the failure", async () => {
    signInAs("sess_a");
    signOut.mockRejectedValueOnce(new Error("offline"));
    renderApp("/settings/account");

    fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Could not sign out. Try again.")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/account");
  });
});
