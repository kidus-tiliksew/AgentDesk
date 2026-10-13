import { ConvexError } from "convex/values";
import { router } from "expo-router";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { ActionSheetIOS } from "react-native";
import { decision } from "./data";
import { clerkState, ensureAccount, setQuery, signInAs, signOut } from "./fakes";
import {
  findInbox,
  findLargeTitle,
  pressTab,
  queryLargeTitle,
  renderApp,
  selectedTab,
  tabBarHidden,
  tabItem,
} from "./render";

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

    expect(await findInbox()).toBeOnTheScreen();
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

// Sign out asks for confirmation in a system action sheet; this answers it
// with "Sign Out" as soon as it opens.
function confirmSignOutSheets() {
  return jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation((options, pick) => pick(options.options.indexOf("Sign Out")));
}

describe("navigation", () => {
  test("the tab bar shows Inbox, History, and Settings with SF Symbols", async () => {
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    expect(tabItem("Inbox").props).toMatchObject({
      icon: { sf: "tray" },
      selectedIcon: { sf: "tray.fill" },
    });
    expect(tabItem("History").props).toMatchObject({
      icon: { sf: "clock" },
      selectedIcon: { sf: "clock.fill" },
    });
    expect(tabItem("Settings").props).toMatchObject({
      icon: { sf: "gearshape" },
      selectedIcon: { sf: "gearshape.fill" },
    });
    expect(selectedTab()).toBe("Inbox");
  });

  test("the Settings tab lists and opens the settings screens", async () => {
    setQuery("identity/connections:listConnections", []);
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    pressTab("Settings");
    expect(await findLargeTitle("Settings")).toBeOnTheScreen();
    expect(selectedTab()).toBe("Settings");
    for (const name of ["Notifications", "Rules", "Connections", "Add machine", "Account"]) {
      expect(screen.getByRole("button", { name })).toBeOnTheScreen();
    }

    fireEvent.press(screen.getByRole("button", { name: "Connections" }));
    await waitFor(() => expect(screen).toHavePathname("/settings/connections"));
    // The screen pushes inside the Settings tab, so the tab bar stays.
    expect(selectedTab()).toBe("Settings");
    expect(tabBarHidden()).toBe(false);
  });

  test("a decision opened from the inbox pushes inside the Inbox tab, and back returns", async () => {
    setQuery("decisions/app:listPending", [decision({ id: "d_1", title: "Ship it?" })]);
    setQuery("decisions/app:get", decision({ id: "d_1", title: "Ship it?" }));
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    fireEvent.press(screen.getByRole("button", { name: "Decision: Ship it?" }));
    await waitFor(() => expect(screen).toHavePathname("/decision/d_1"));
    expect(selectedTab()).toBe("Inbox");
    expect(tabBarHidden()).toBe(false);
    expect(queryLargeTitle("Inbox")).not.toBeOnTheScreen();

    act(() => router.back());
    expect(await findInbox()).toBeOnTheScreen();
  });

  test("the Inbox tab's badge counts pending decisions", async () => {
    setQuery("decisions/app:listPending", [decision({ id: "d_1" }), decision({ id: "d_2" })]);
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    // The tab bar item's own badge, which VoiceOver reads with the tab.
    expect(tabItem("Inbox").props.badgeValue).toBe("2");

    act(() => setQuery("decisions/app:listPending", []));
    expect(tabItem("Inbox").props.badgeValue).toBeUndefined();
  });

  test("a failed pending query leaves the tab bar without a badge", async () => {
    setQuery("decisions/app:listPending", new ConvexError({ code: "internal", message: "boom" }));
    signInAs("sess_a");
    renderApp("/");

    expect(await screen.findByText("Could not load your inbox.")).toBeOnTheScreen();
    expect(tabItem("Inbox").props.badgeValue).toBeUndefined();
    expect(tabItem("History")).toBeOnTheScreen();
    expect(tabItem("Settings")).toBeOnTheScreen();
  });

  test("signing out from the account screen returns to sign-in", async () => {
    signInAs("sess_a");
    const sheet = confirmSignOutSheets();
    renderApp("/settings/account");

    fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/sign-in");
    expect(sheet).toHaveBeenCalledTimes(1);
    sheet.mockRestore();
  });

  test("a failed sign-out keeps the account screen and reports the failure", async () => {
    signInAs("sess_a");
    const sheet = confirmSignOutSheets();
    signOut.mockRejectedValueOnce(new Error("offline"));
    renderApp("/settings/account");

    fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Could not sign out. Try again.")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/account");
    sheet.mockRestore();
  });
});
