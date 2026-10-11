import { fireEvent, screen } from "expo-router/testing-library";
import { clerkState, ensureAccount, signInAs, signOut } from "./fakes";
import { renderApp } from "./render";

const inbox = "Your pending decisions and live agents will appear here.";

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
  test("the inbox header links to the settings screens", async () => {
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText(inbox);

    fireEvent.press(screen.getByText("Connections"));
    expect(await screen.findByText("Your connected harnesses will appear here.")).toBeOnTheScreen();
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
