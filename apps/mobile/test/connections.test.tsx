import { getFunctionName } from "convex/server";
import { act, fireEvent, screen } from "expo-router/testing-library";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  type ActionSheetIOSOptions,
  Alert,
  Platform,
} from "react-native";
import { confirmDestructive } from "../src/confirm";
import {
  connectionSpokenSummary,
  connectionSummary,
  formatConnectionDay,
  groupByMachine,
} from "../src/connections/format";
import { haptic } from "../src/haptics";
import { deferred, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens: settings/connections lists the person's
// connected harnesses grouped by machine and revokes one, reached by a swipe,
// a touch and hold, or VoiceOver's Revoke action, after an action sheet
// confirms it (req-accounts-and-connections REQ-4). A signed-in Mac is listed
// and revoked like a harness (req-mac-app AC-2.5).

jest.mock("../src/haptics", () => ({
  haptic: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), selection: jest.fn() },
}));

const list = "identity/connections:listConnections";
const revokeName = "identity/connections:revokeConnection";

// The shared convex/react fake refuses mutations it does not know. This file
// wraps its useMutation, so revokeConnection and Add machine's lookup get local
// mocks and every other mutation, such as ensureAccount, keeps the shared fake.
const mockRevokeConnection = jest.fn<Promise<null>, [{ credentialId: string }]>();
// Add machine binds its lookup as it opens; these tests only open it.
const lookupName = "identity/deviceRequests:lookupDeviceRequest";
const mockLookup = jest.fn();

// Each action sheet the screen opens, with the callback that picks a choice.
const sheets: { options: ActionSheetIOSOptions; pick: (index: number) => void }[] = [];

beforeEach(() => {
  sheets.length = 0;
  jest
    .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation((options, pick) => sheets.push({ options, pick }));
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  jest.mocked(haptic.success).mockClear();
  jest.mocked(haptic.error).mockClear();
  mockRevokeConnection.mockReset().mockResolvedValue(null);
  const convexReact = jest.requireMock<{ useMutation: (reference: unknown) => unknown }>(
    "convex/react",
  );
  const sharedUseMutation = convexReact.useMutation;
  jest
    .spyOn(convexReact, "useMutation")
    .mockImplementation((reference: unknown) =>
      getFunctionName(reference as never) === revokeName
        ? mockRevokeConnection
        : getFunctionName(reference as never) === lookupName
          ? mockLookup
          : sharedUseMutation(reference),
    );
});

afterEach(() => {
  jest.restoreAllMocks();
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FOOTER =
  "Swipe left or touch and hold to revoke. A revoked connection fails its next request.";
const EMPTY =
  "Run the AgentDesk installer on a computer, or open AgentDesk for Mac, then enter the code it shows.";

// Times relative to the real clock: renderRouter installs fake timers that
// start from it, so "2m ago" holds when the screen first renders.
const now = Date.now();
const FIRST = now - 12 * DAY;

const laptop = {
  credentialId: "c_laptop",
  name: "Claude Code",
  machineName: "laptop",
  firstConnectedAt: FIRST + 5 * MINUTE,
  lastUsedAt: now - 2 * MINUTE,
};
const cursor = {
  credentialId: "c_cursor",
  name: "cursor",
  firstConnectedAt: FIRST,
};
const devbox = {
  credentialId: "c_devbox",
  name: "Codex",
  machineName: "devbox",
  firstConnectedAt: FIRST,
  lastUsedAt: now - 3 * DAY,
};
const laptopCodex = {
  credentialId: "c_laptop_codex",
  name: "Codex",
  machineName: "laptop",
  firstConnectedAt: FIRST,
};
// A Mac's API token as listConnections returns it (component-identity
// §Short-code sign-in).
const studioMac = {
  credentialId: "c_studio_mac",
  name: "AgentDesk for Mac",
  machineName: "studio",
  firstConnectedAt: FIRST + 10 * MINUTE,
  lastUsedAt: now - 5 * MINUTE,
};
const laptopMac = {
  credentialId: "c_laptop_mac",
  name: "AgentDesk for Mac",
  machineName: "laptop",
  firstConnectedAt: FIRST,
};

async function openConnections() {
  signInAs("sess_a");
  renderApp("/settings/connections");
}

// Runs a row's Revoke the way VoiceOver does, without the swipe gesture.
function revokeAction(label: string) {
  fireEvent(screen.getByLabelText(label), "accessibilityAction", {
    nativeEvent: { actionName: "Revoke" },
  });
}

// The last action sheet the screen opened.
function lastSheet() {
  const sheet = sheets[sheets.length - 1];
  if (sheet === undefined) {
    throw new Error("No action sheet open");
  }
  return sheet;
}

// Picks `choice` in the last action sheet, letting the call it starts settle.
async function choose(choice: string) {
  const sheet = lastSheet();
  await act(async () => {
    sheet.pick(sheet.options.options.indexOf(choice));
  });
}

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No item ${index}`);
  }
  return item;
}

describe("connections screen", () => {
  // req-accounts-and-connections AC-4.1
  test("groups connections by machine in query order, with each one's name, first connected, and last used", async () => {
    setQuery(list, [laptop, cursor, devbox, laptopCodex]);

    await openConnections();

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: list, args: {} });
    // One section per machine, in the order each first appears; connections
    // with no machine name come last under Other.
    const machines = screen
      .getAllByRole("header", { name: /^(laptop|devbox|Other)$/ })
      .map((element) => element.props.children);
    expect(machines).toEqual(["laptop", "devbox", "Other"]);
    const rows = screen
      .getAllByLabelText(/^(Claude Code on laptop|Codex on laptop|Codex on devbox|cursor)$/)
      .map((element) => element.props.accessibilityLabel);
    expect(rows).toEqual(["Claude Code on laptop", "Codex on laptop", "Codex on devbox", "cursor"]);
    const day = formatConnectionDay(FIRST, now);
    expect(screen.getByText(`Connected ${day} · used 2m ago`)).toBeOnTheScreen();
    expect(screen.getByText(`Connected ${day} · used 3d ago`)).toBeOnTheScreen();
    expect(screen.getAllByText(`Connected ${day} · never used`)).toHaveLength(2);
    expect(screen.getAllByText(FOOTER)).toHaveLength(1);
  });

  test("VoiceOver reads each row with its machine, both times in words, and how to revoke", async () => {
    setQuery(list, [laptop, cursor]);
    await openConnections();

    const row = await screen.findByLabelText("Claude Code on laptop");
    expect(row).toHaveProp("accessibilityValue", {
      text: `Connected ${formatConnectionDay(laptop.firstConnectedAt, now)}, last used 2 minutes ago`,
    });
    expect(row).toHaveProp("accessibilityHint", "Touch and hold to revoke.");
    expect(row).toHaveProp("accessibilityActions", [{ name: "Revoke", label: "Revoke" }]);
    expect(screen.getByLabelText("cursor")).toHaveProp("accessibilityValue", {
      text: `Connected ${formatConnectionDay(FIRST, now)}, never used`,
    });
    // The swipe's revealed button stays out of VoiceOver's reach until open.
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeOnTheScreen();
  });

  test("the header's + opens Add machine", async () => {
    setQuery(list, [laptop]);
    await openConnections();
    await screen.findByText("Claude Code");

    fireEvent.press(screen.getByRole("button", { name: "Add machine" }));

    expect(await screen.findByLabelText("Installer code")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/add-machine");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("shows loading until the query returns, then the list", async () => {
    setQuery(list, loading);

    await openConnections();

    expect(await screen.findByText("Loading connections")).toBeOnTheScreen();
    expect(screen.queryByText("No machines connected")).not.toBeOnTheScreen();

    act(() => setQuery(list, [laptop]));

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
    expect(screen.queryByText("Loading connections")).not.toBeOnTheScreen();
  });

  test("shows an empty state that leads to Add machine when there are no connections", async () => {
    setQuery(list, []);

    await openConnections();

    expect(await screen.findByText("No machines connected")).toBeOnTheScreen();
    expect(screen.getByText(EMPTY)).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeOnTheScreen();
    expect(screen.queryByText(FOOTER)).not.toBeOnTheScreen();

    // The empty state's button comes first; the header's + follows it.
    const buttons = screen.getAllByRole("button", { name: "Add machine" });
    expect(buttons).toHaveLength(2);
    fireEvent.press(nth(buttons, 0));

    expect(await screen.findByLabelText("Installer code")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/add-machine");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("a failed query shows a failure with a retry, never an empty list", async () => {
    setQuery(list, new Error("Network request failed"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await openConnections();

    expect(await screen.findByText("Could not load your connections.")).toBeOnTheScreen();
    expect(screen.queryByText("No machines connected")).not.toBeOnTheScreen();

    setQuery(list, [laptop]);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
  });

  // req-accounts-and-connections AC-4.2
  test("revokes the connection only after the action sheet confirms it, and the row leaves with the query", async () => {
    setQuery(list, [laptop, cursor]);
    await openConnections();
    await screen.findByText("Claude Code");

    revokeAction("Claude Code on laptop");

    expect(lastSheet().options).toEqual({
      title: "Revoke Claude Code on laptop?",
      message: "Its next request will fail.",
      options: ["Revoke", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(mockRevokeConnection).not.toHaveBeenCalled();

    await choose("Revoke");

    expect(mockRevokeConnection).toHaveBeenCalledTimes(1);
    expect(mockRevokeConnection).toHaveBeenCalledWith({ credentialId: "c_laptop" });
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Revoked Claude Code on laptop",
    );
    // The screen keeps the row until the reactive query drops it.
    expect(screen.getByText("Claude Code")).toBeOnTheScreen();

    act(() => setQuery(list, [cursor]));

    expect(screen.queryByText("Claude Code")).not.toBeOnTheScreen();
    expect(screen.getByText("cursor")).toBeOnTheScreen();
  });

  test("a touch and hold on a row opens the same confirmation, so revoking needs no swipe", async () => {
    setQuery(list, [laptop, cursor]);
    await openConnections();
    await screen.findByText("cursor");

    fireEvent(screen.getByLabelText("cursor"), "longPress");

    expect(sheets).toHaveLength(1);
    expect(lastSheet().options.title).toBe("Revoke cursor?");
    expect(mockRevokeConnection).not.toHaveBeenCalled();

    await choose("Revoke");

    expect(mockRevokeConnection).toHaveBeenCalledWith({ credentialId: "c_cursor" });
  });

  test("a cancelled confirmation revokes nothing", async () => {
    setQuery(list, [laptop, cursor]);
    await openConnections();
    await screen.findByText("cursor");

    revokeAction("cursor");
    await choose("Cancel");

    expect(mockRevokeConnection).not.toHaveBeenCalled();
    expect(haptic.success).not.toHaveBeenCalled();
    expect(screen.getByText("cursor")).toBeOnTheScreen();
  });

  test("sends one revocation while it runs, shows it, and opens no other confirmation", async () => {
    const pending = deferred<null>();
    mockRevokeConnection.mockReturnValueOnce(pending.promise);
    setQuery(list, [laptop, cursor]);
    await openConnections();
    await screen.findByText("Claude Code");
    revokeAction("Claude Code on laptop");

    const sheet = lastSheet();
    act(() => {
      sheet.pick(0);
      sheet.pick(0);
    });

    expect(mockRevokeConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Revoking...")).toBeOnTheScreen();
    expect(screen.getByLabelText("Claude Code on laptop")).toHaveProp("accessibilityState", {
      busy: true,
    });
    // Neither VoiceOver's action nor a touch and hold on another row opens a
    // second confirmation while one runs.
    revokeAction("cursor");
    fireEvent(screen.getByLabelText("cursor"), "longPress");
    expect(sheets).toHaveLength(1);

    await act(async () => {
      pending.resolve(null);
    });

    expect(screen.queryByText("Revoking...")).not.toBeOnTheScreen();
    revokeAction("cursor");
    expect(sheets).toHaveLength(2);
    expect(lastSheet().options.title).toBe("Revoke cursor?");
  });

  test("a failed revocation keeps the row, reports the error, and allows another attempt", async () => {
    mockRevokeConnection.mockRejectedValueOnce(new Error("Network request failed"));
    setQuery(list, [laptop]);
    await openConnections();
    await screen.findByText("Claude Code");
    revokeAction("Claude Code on laptop");

    await choose("Revoke");

    const failed = "Could not revoke Claude Code. Try again.";
    expect(screen.getByText(failed)).toBeOnTheScreen();
    expect(screen.getByText("Claude Code")).toBeOnTheScreen();
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(failed);

    revokeAction("Claude Code on laptop");
    // Opening the confirmation again clears the earlier error.
    expect(screen.queryByText(failed)).not.toBeOnTheScreen();
    await choose("Revoke");

    expect(mockRevokeConnection).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(failed)).not.toBeOnTheScreen();
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });
});

describe("connections screen with a Mac", () => {
  // req-mac-app AC-2.5; req-accounts-and-connections AC-4.1
  test("lists a Mac as AgentDesk for Mac under its machine, with both times, among harnesses", async () => {
    setQuery(list, [studioMac, laptop, laptopMac, cursor]);

    await openConnections();

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
    const machines = screen
      .getAllByRole("header", { name: /^(studio|laptop|Other)$/ })
      .map((element) => element.props.children);
    expect(machines).toEqual(["studio", "laptop", "Other"]);
    const rows = screen
      .getAllByLabelText(/^(AgentDesk for Mac on (studio|laptop)|Claude Code on laptop|cursor)$/)
      .map((element) => element.props.accessibilityLabel);
    expect(rows).toEqual([
      "AgentDesk for Mac on studio",
      "Claude Code on laptop",
      "AgentDesk for Mac on laptop",
      "cursor",
    ]);
    expect(screen.getAllByText("AgentDesk for Mac")).toHaveLength(2);
    expect(
      screen.getByText(
        `Connected ${formatConnectionDay(studioMac.firstConnectedAt, now)} · used 5m ago`,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText("AgentDesk for Mac on studio")).toHaveProp("accessibilityValue", {
      text: `Connected ${formatConnectionDay(studioMac.firstConnectedAt, now)}, last used 5 minutes ago`,
    });
    // A Mac not yet used reads as never used.
    expect(screen.getByLabelText("AgentDesk for Mac on laptop")).toHaveProp("accessibilityValue", {
      text: `Connected ${formatConnectionDay(FIRST, now)}, never used`,
    });
    expect(
      screen.getAllByText(`Connected ${formatConnectionDay(FIRST, now)} · never used`),
    ).toHaveLength(2);
    expect(screen.getAllByText(FOOTER)).toHaveLength(1);
  });

  // req-mac-app AC-2.5; req-accounts-and-connections AC-4.2
  test("revokes a Mac only after the action sheet confirms it, and the row leaves with the query", async () => {
    setQuery(list, [studioMac, cursor]);
    await openConnections();
    await screen.findByText("AgentDesk for Mac");

    const row = screen.getByLabelText("AgentDesk for Mac on studio");
    expect(row).toHaveProp("accessibilityActions", [{ name: "Revoke", label: "Revoke" }]);
    revokeAction("AgentDesk for Mac on studio");

    expect(lastSheet().options).toEqual({
      title: "Revoke AgentDesk for Mac on studio?",
      message: "Its next request will fail.",
      options: ["Revoke", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    await choose("Cancel");
    expect(mockRevokeConnection).not.toHaveBeenCalled();

    fireEvent(screen.getByLabelText("AgentDesk for Mac on studio"), "longPress");
    await choose("Revoke");

    expect(mockRevokeConnection).toHaveBeenCalledTimes(1);
    expect(mockRevokeConnection).toHaveBeenCalledWith({ credentialId: "c_studio_mac" });
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Revoked AgentDesk for Mac on studio",
    );
    // The screen keeps the row until the reactive query drops it.
    expect(screen.getByText("AgentDesk for Mac")).toBeOnTheScreen();

    act(() => setQuery(list, [cursor]));

    expect(screen.queryByText("AgentDesk for Mac")).not.toBeOnTheScreen();
    expect(screen.getByText("cursor")).toBeOnTheScreen();
  });

  // req-mac-app AC-2.5; DEC-17(3)
  test("on Android a Mac's revocation asks in a system alert", async () => {
    setQuery(list, [studioMac]);
    await openConnections();
    await screen.findByText("AgentDesk for Mac");
    jest.replaceProperty(Platform, "OS", "android");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    revokeAction("AgentDesk for Mac on studio");

    expect(sheets).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = nth(alert.mock.calls, 0);
    expect(title).toBe("Revoke AgentDesk for Mac on studio?");
    expect(message).toBe("Its next request will fail.");
    expect(buttons?.map(({ text, style }) => ({ text, style }))).toEqual([
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive" },
    ]);
    expect(mockRevokeConnection).not.toHaveBeenCalled();

    await act(async () => {
      nth(buttons ?? [], 1).onPress?.();
    });

    expect(mockRevokeConnection).toHaveBeenCalledTimes(1);
    expect(mockRevokeConnection).toHaveBeenCalledWith({ credentialId: "c_studio_mac" });
  });

  test("a failed Mac revocation keeps the row and reports the error", async () => {
    mockRevokeConnection.mockRejectedValueOnce(new Error("Network request failed"));
    setQuery(list, [studioMac]);
    await openConnections();
    await screen.findByText("AgentDesk for Mac");
    revokeAction("AgentDesk for Mac on studio");

    await choose("Revoke");

    const failed = "Could not revoke AgentDesk for Mac. Try again.";
    expect(screen.getByText(failed)).toBeOnTheScreen();
    expect(screen.getByText("AgentDesk for Mac")).toBeOnTheScreen();
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
  });
});

describe("destructive confirmation", () => {
  test("on Android it is an alert with Cancel and the destructive action", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const onConfirm = jest.fn();

    confirmDestructive({ title: "Revoke cursor?", message: "Gone.", action: "Revoke", onConfirm });

    expect(ActionSheetIOS.showActionSheetWithOptions).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith("Revoke cursor?", "Gone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive", onPress: onConfirm },
    ]);
  });
});

describe("connection formatting", () => {
  const utc = { locale: "en-US", timeZone: "UTC" };
  const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

  test("shows the day of the first connection, with the year only when it is not this one", () => {
    expect(formatConnectionDay(Date.UTC(2026, 9, 12, 23, 30), NOW, utc)).toBe("Oct 12");
    expect(formatConnectionDay(Date.UTC(2025, 11, 31, 9, 0), NOW, utc)).toBe("Dec 31, 2025");
  });

  test("reads the last use as elapsed time, or never used", () => {
    const first = Date.UTC(2026, 9, 12, 9, 0);
    expect(
      connectionSummary({ firstConnectedAt: first, lastUsedAt: NOW - 2 * MINUTE }, NOW, utc),
    ).toBe("Connected Oct 12 · used 2m ago");
    expect(
      connectionSummary({ firstConnectedAt: first, lastUsedAt: NOW - 5 * DAY }, NOW, utc),
    ).toBe("Connected Oct 12 · used 5d ago");
    expect(connectionSummary({ firstConnectedAt: first }, NOW, utc)).toBe(
      "Connected Oct 12 · never used",
    );
  });

  test("speaks the times in whole words for VoiceOver", () => {
    const first = Date.UTC(2026, 9, 12, 9, 0);
    const spoken = (lastUsedAt?: number) =>
      connectionSpokenSummary({ firstConnectedAt: first, lastUsedAt }, NOW, utc);
    expect(spoken(NOW - 1000)).toBe("Connected Oct 12, last used 1 second ago");
    expect(spoken(NOW - 2 * MINUTE)).toBe("Connected Oct 12, last used 2 minutes ago");
    expect(spoken(NOW - 60 * MINUTE)).toBe("Connected Oct 12, last used 1 hour ago");
    expect(spoken(NOW - 5 * DAY)).toBe("Connected Oct 12, last used 5 days ago");
    expect(spoken()).toBe("Connected Oct 12, never used");
  });

  test("groups by machine in first-appearance order with unknown machines last", () => {
    const rows = [
      { id: 1 },
      { id: 2, machineName: "b" },
      { id: 3, machineName: "a" },
      { id: 4, machineName: "b" },
    ];
    expect(groupByMachine(rows)).toEqual([
      { machine: "b", connections: [rows[1], rows[3]] },
      { machine: "a", connections: [rows[2]] },
      { machine: "Other", connections: [rows[0]] },
    ]);
    expect(groupByMachine([])).toEqual([]);
  });
});
