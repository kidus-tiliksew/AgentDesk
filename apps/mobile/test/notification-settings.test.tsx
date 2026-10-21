import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { router } from "expo-router";
import { act, fireEvent, screen } from "expo-router/testing-library";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  Keyboard,
  Linking,
  Platform,
  StyleSheet,
} from "react-native";
import type { NotificationSettings } from "../../../convex/notifications/settings";
import { haptic } from "../src/haptics";
import {
  type Draft,
  dateAsTime,
  deviceTimeZone,
  draftOf,
  EQUAL_TIMES,
  FALLBACK_TIME_ZONES,
  filterZones,
  MISSING_END,
  MISSING_START,
  overnightLabel,
  parseThreshold,
  parseTime,
  refusalMessage,
  supportedTimeZones,
  THRESHOLD_RULE,
  TIME_RULE,
  timeAsDate,
  type UpdateArgs,
  validateDraft,
  ZONE_RULE,
  zoneChoices,
  zoneName,
} from "../src/notification-settings";
import {
  deferred,
  loading,
  push,
  queryCalls,
  secureStore,
  setQuery,
  signInAs,
  signOutAll,
} from "./fakes";
import { findInbox, renderApp } from "./render";

// component-mobile-app §Screens, notification settings: settings/notifications
// shows and saves quiet hours, urgent override, digest time, time zone, and
// stale threshold (req-mobile-app REQ-5; req-notification-rules REQ-5, REQ-6;
// req-agent-status AC-3.1), under this device's push status.

// The native time picker as a plain view that keeps its props, so a test
// reads the picker's `value` and fires its `valueChange` as a person turning
// the wheel would.
jest.mock("@react-native-community/datetimepicker", () => {
  const { createElement } = require("react");
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: (props: object) => createElement(View, props),
    DateTimePickerAndroid: { open: jest.fn() },
  };
});

const getName = "notifications/settings:getSettings";
const updateName = "notifications/settings:updateSettings";
const url = "/settings/notifications";

const SAVE_FAILED = "Could not save your settings. Check your connection and try again.";
const REFUSED = "AgentDesk refused these settings. Check the fields and save again.";
const SAVED = "Settings saved.";
const LOAD_FAILED = "Could not load your notification settings.";
const FALLBACK_NOTE = "No time zone has been recorded from this device yet, so AgentDesk uses UTC.";
const URGENT_ON = "Urgent decisions still push during quiet hours.";
const URGENT_OFF = "Urgent decisions go to the digest during quiet hours, like everything else.";

const DEFAULTS: NotificationSettings = {
  time_zone: "UTC",
  time_zone_source: "default",
  quiet_start: null,
  quiet_end: null,
  urgent_override: true,
  digest_time: "09:00",
  stale_threshold_minutes: 30,
};

const STORED: NotificationSettings = {
  time_zone: "Europe/Berlin",
  time_zone_source: "user",
  quiet_start: "22:00",
  quiet_end: "07:00",
  urgent_override: false,
  digest_time: "18:30",
  stale_threshold_minutes: 45,
};

// The shared convex/react fake refuses mutations it does not know. This file
// wraps its useMutation, so updateSettings gets a local mock and every other
// mutation keeps the shared fake. `binds` counts renders that bound it.
const mockUpdate = jest.fn<Promise<NotificationSettings>, [UpdateArgs]>();
let binds = 0;
// The settings the scripted backend holds; the default update applies its
// arguments here and to the reactive query, as the backend does.
let stored: NotificationSettings;

function applyUpdate(current: NotificationSettings, args: UpdateArgs): NotificationSettings {
  return {
    time_zone: args.timeZone ?? current.time_zone,
    time_zone_source: args.timeZone === undefined ? current.time_zone_source : "user",
    quiet_start: args.quietStart,
    quiet_end: args.quietEnd,
    urgent_override: args.urgentOverride,
    digest_time: args.digestTime,
    stale_threshold_minutes: args.staleThresholdMinutes,
  };
}

function serve(settings: NotificationSettings) {
  stored = settings;
  setQuery(getName, settings);
}

// The system action sheet, which asks before unsaved edits are discarded.
// `chooseInSheet` picks one of its options as the person would.
let sheet: jest.SpyInstance;
let announce: jest.SpyInstance;

function chooseInSheet(option: string) {
  const [options, callback] = sheet.mock.lastCall as [
    { options: string[] },
    (index: number) => void,
  ];
  act(() => callback(options.options.indexOf(option)));
}

// The zone this file's device reports.
let deviceZone: string | undefined;
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

beforeEach(() => {
  binds = 0;
  sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
  announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  deviceZone = "Africa/Addis_Ababa";
  jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...realResolvedOptions.call(this), timeZone: deviceZone as string };
  });
  mockUpdate.mockReset().mockImplementation(async (args) => {
    const next = applyUpdate(stored, args);
    serve(next);
    return next;
  });
  const convexReact = jest.requireMock<{ useMutation: (reference: unknown) => unknown }>(
    "convex/react",
  );
  const sharedUseMutation = convexReact.useMutation;
  jest.spyOn(convexReact, "useMutation").mockImplementation((reference: unknown) => {
    if (getFunctionName(reference as never) === updateName) {
      binds += 1;
      return mockUpdate;
    }
    return sharedUseMutation(reference);
  });
  serve(DEFAULTS);
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function settle() {
  await act(async () => {});
  act(() => jest.advanceTimersByTime(0));
}

async function open(path = url, session = "sess_a") {
  signInAs(session);
  renderApp(path);
  await settle();
}

function input(label: string) {
  return screen.getByLabelText(label);
}

function type(label: string, text: string) {
  fireEvent.changeText(input(label), text);
}

// The `HH:MM` a time picker shows.
function timeOf(label: string) {
  return dateAsTime(input(label).props.value as Date);
}

// Sets a time picker to `HH:MM`.
function pickTime(label: string, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  fireEvent(input(label), "valueChange", { nativeEvent: { timestamp: date.getTime() } }, date);
}

function isOn(label: string) {
  return input(label).props.value === true;
}

async function toggle(label: string, value: boolean) {
  await act(async () => {
    fireEvent(input(label), "valueChange", value);
  });
}

// The time zone row reads "Time zone, <IANA name>".
function zoneRow() {
  return screen.getByRole("button", { name: /^Time zone, / });
}

function selectedZone() {
  return zoneRow().props.accessibilityLabel.replace(/^Time zone, /, "");
}

function openZones() {
  fireEvent.press(zoneRow());
}

function choice(name: string) {
  return screen.getByRole("button", { name });
}

function isSelected(name: string) {
  return choice(name).props.accessibilityState?.selected === true;
}

function saveButton() {
  return screen.getByRole("button", { name: /^(Save settings|Saving\.\.\.|Retry)$/ });
}

async function press(element: ReturnType<typeof screen.getByRole>) {
  await act(async () => {
    fireEvent.press(element);
  });
  act(() => jest.advanceTimersByTime(0));
}

async function pressSave() {
  await press(saveButton());
}

describe("opening the screen", () => {
  test("the settings tab opens it, and it binds the update hook only with the loaded form", async () => {
    setQuery(getName, loading);
    await open("/settings");

    fireEvent.press(screen.getByRole("button", { name: "Notifications" }));
    await settle();
    expect(screen).toHavePathname(url);
    expect(screen.getByText("Loading notification settings")).toBeOnTheScreen();
    expect(binds).toBe(0);

    act(() => serve(DEFAULTS));
    await settle();
    expect(timeOf("Digest time")).toBe("09:00");
    expect(binds).toBeGreaterThan(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("reads getSettings with no arguments", async () => {
    await open();
    const names = queryCalls.map((call) => call.name);
    expect(names).toContain(getName);
    expect(queryCalls.find((call) => call.name === getName)?.args).toEqual({});
  });

  test("a failed query shows a failure with Try again, not an empty form", async () => {
    setQuery(getName, new Error("offline"));
    await open();

    expect(screen.getByText(LOAD_FAILED)).toBeOnTheScreen();
    expect(screen.queryByLabelText("Digest time")).not.toBeOnTheScreen();
    expect(binds).toBe(0);

    setQuery(getName, DEFAULTS);
    await press(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText(LOAD_FAILED)).not.toBeOnTheScreen();
    expect(timeOf("Digest time")).toBe("09:00");
  });

  test("shows the backend defaults for every field", async () => {
    await open();

    expect(isOn("Quiet hours")).toBe(false);
    // Off quiet hours hide their From and To pickers.
    expect(screen.queryByLabelText("Quiet hours start")).not.toBeOnTheScreen();
    expect(screen.queryByLabelText("Quiet hours end")).not.toBeOnTheScreen();
    expect(isOn("Urgent decisions still push")).toBe(true);
    expect(screen.getByText(URGENT_ON)).toBeOnTheScreen();
    expect(timeOf("Digest time")).toBe("09:00");
    expect(selectedZone()).toBe("UTC");
    expect(screen.getByText(FALLBACK_NOTE)).toBeOnTheScreen();
    expect(input("Stale threshold in minutes").props.value).toBe("30");
  });

  test("shows stored values, and a window past midnight ends the next day", async () => {
    serve(STORED);
    await open();

    expect(isOn("Quiet hours")).toBe(true);
    expect(timeOf("Quiet hours start")).toBe("22:00");
    expect(timeOf("Quiet hours end")).toBe("07:00");
    expect(
      screen.getByText("Quiet hours run overnight: from 22:00 until 07:00 the next day."),
    ).toBeOnTheScreen();
    expect(isOn("Urgent decisions still push")).toBe(false);
    expect(screen.getByText(URGENT_OFF)).toBeOnTheScreen();
    expect(timeOf("Digest time")).toBe("18:30");
    expect(selectedZone()).toBe("Europe/Berlin");
    expect(screen.getByText("Berlin")).toBeOnTheScreen();
    expect(screen.queryByText(FALLBACK_NOTE)).not.toBeOnTheScreen();
    expect(input("Stale threshold in minutes").props.value).toBe("45");
  });

  test("a window inside one day has no next-day note", async () => {
    serve({ ...STORED, quiet_start: "12:00", quiet_end: "13:30" });
    await open();

    expect(screen.queryByText(/the next day/)).not.toBeOnTheScreen();
  });
});

describe("push status", () => {
  test("says push is on once this device is registered", async () => {
    await open();

    expect(await screen.findByText("Push is on for this device")).toBeOnTheScreen();
  });

  test("a denied permission reads as push off and opens the system settings", async () => {
    push.requestResult = { granted: false, canAskAgain: false, status: "denied" };
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    await open();

    expect(await screen.findByText("Push is off for this device")).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test("a failed setup names the failure and offers another attempt", async () => {
    push.getExpoPushTokenAsync.mockRejectedValueOnce(new Error("no token"));
    await open();

    expect(
      await screen.findByText("Could not get a push token for this device."),
    ).toBeOnTheScreen();
    await press(screen.getByRole("button", { name: "Set up push again" }));
    expect(await screen.findByText("Push is on for this device")).toBeOnTheScreen();
  });

  test("Not now on the push explanation reads as push off and offers to turn push on", async () => {
    secureStore.values.set("agentdesk.pushIntro", "not-now");
    await open();

    expect(await screen.findByText("Push is off for this device")).toBeOnTheScreen();
    expect(push.requestPermissionsAsync).not.toHaveBeenCalled();

    await press(screen.getByRole("button", { name: "Turn on push" }));

    expect(push.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Push is on for this device")).toBeOnTheScreen();
  });
});

describe("saving", () => {
  test("sends every field with the arguments updateSettings takes", async () => {
    await open();

    await toggle("Quiet hours", true);
    pickTime("Quiet hours start", "23:15");
    pickTime("Quiet hours end", "06:45");
    expect(
      screen.getByText("Quiet hours run overnight: from 23:15 until 06:45 the next day."),
    ).toBeOnTheScreen();
    await toggle("Urgent decisions still push", false);
    expect(screen.getByText(URGENT_OFF)).toBeOnTheScreen();
    pickTime("Digest time", "08:15");
    openZones();
    type("Search time zones", "tokyo");
    await press(choice("Time zone: Asia/Tokyo"));
    type("Stale threshold in minutes", "60");
    await pressSave();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({
      timeZone: "Asia/Tokyo",
      quietStart: "23:15",
      quietEnd: "06:45",
      urgentOverride: false,
      digestTime: "08:15",
      staleThresholdMinutes: 60,
    });
    expect(screen.getByText(SAVED)).toBeOnTheScreen();
    expect(selectedZone()).toBe("Asia/Tokyo");
    expect(timeOf("Digest time")).toBe("08:15");
    expect(screen.queryByText(FALLBACK_NOTE)).not.toBeOnTheScreen();
  });

  test("turning quiet hours on with no saved window starts from 22:00 to 07:00", async () => {
    await open();

    await toggle("Quiet hours", true);
    expect(timeOf("Quiet hours start")).toBe("22:00");
    expect(timeOf("Quiet hours end")).toBe("07:00");
    await pressSave();

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({ quietStart: "22:00", quietEnd: "07:00" });
  });

  test("an unchosen time zone is not sent, so the saved zone keeps its source", async () => {
    await open();

    pickTime("Digest time", "07:30");
    await pressSave();

    expect(mockUpdate).toHaveBeenCalledWith({
      quietStart: null,
      quietEnd: null,
      urgentOverride: true,
      digestTime: "07:30",
      staleThresholdMinutes: 30,
    });
  });

  test("the zone sheet suggests the device zone and UTC, and marks the selected zone", async () => {
    await open();
    openZones();

    const zones = screen
      .getAllByRole("button", { name: /^Time zone: / })
      .map((button) => button.props.accessibilityLabel);
    expect(zones[0]).toBe("Time zone: Africa/Addis_Ababa (this device)");
    expect(zones[1]).toBe("Time zone: UTC");
    expect(new Set(zones).size).toBe(zones.length);
    expect(isSelected("Time zone: UTC")).toBe(true);
    expect(isSelected("Time zone: Africa/Addis_Ababa (this device)")).toBe(false);
    expect(
      screen.getByText(/^Showing 50 of \d+ time zones\. Search to narrow the list\.$/),
    ).toBeOnTheScreen();

    await press(choice("Time zone: Africa/Addis_Ababa (this device)"));
    // Choosing closes the sheet.
    expect(screen.queryByLabelText("Search time zones")).not.toBeOnTheScreen();
    expect(selectedZone()).toBe("Africa/Addis_Ababa");
    expect(screen.getByText("Addis Ababa")).toBeOnTheScreen();
    await pressSave();
    expect(mockUpdate.mock.calls[0]?.[0].timeZone).toBe("Africa/Addis_Ababa");
  });

  test("choosing the zone already saved sends it as the person's choice", async () => {
    await open();

    openZones();
    await press(choice("Time zone: UTC"));
    await pressSave();

    expect(mockUpdate.mock.calls[0]?.[0].timeZone).toBe("UTC");
  });

  test("Cancel closes the zone sheet without choosing", async () => {
    await open();

    openZones();
    await press(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Search time zones")).not.toBeOnTheScreen();
    await pressSave();

    expect(mockUpdate.mock.calls[0]?.[0].timeZone).toBeUndefined();
  });

  test("turning quiet hours off clears both ends", async () => {
    serve(STORED);
    await open();

    await toggle("Quiet hours", false);
    expect(screen.queryByLabelText("Quiet hours start")).not.toBeOnTheScreen();
    expect(screen.queryByText(/the next day/)).not.toBeOnTheScreen();
    await pressSave();

    expect(mockUpdate).toHaveBeenCalledWith({
      quietStart: null,
      quietEnd: null,
      urgentOverride: false,
      digestTime: "18:30",
      staleThresholdMinutes: 45,
    });
    expect(isOn("Quiet hours")).toBe(false);
  });

  test("a zone outside the list can be entered and is checked with Intl", async () => {
    await open();
    openZones();

    type("Other time zone", "Mars/Olympus_Mons");
    await press(choice("Use time zone"));
    expect(screen.getByText(ZONE_RULE)).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(ZONE_RULE);
    expect(selectedZone()).toBe("UTC");

    type("Other time zone", "America/Bogota");
    expect(screen.queryByText(ZONE_RULE)).not.toBeOnTheScreen();
    await press(choice("Use time zone"));
    expect(selectedZone()).toBe("America/Bogota");
    await pressSave();

    expect(mockUpdate.mock.calls[0]?.[0].timeZone).toBe("America/Bogota");
  });

  test("the search narrows the zones and reports when nothing matches", async () => {
    await open();
    openZones();

    type("Search time zones", "new york");
    expect(choice("Time zone: America/New_York")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Time zone: UTC" })).not.toBeOnTheScreen();

    // A zone that only the runtime's own list holds.
    type("Search time zones", "honolulu");
    expect(choice("Time zone: Pacific/Honolulu")).toBeOnTheScreen();

    // A search finds the device zone too, still marked.
    type("Search time zones", "addis");
    expect(choice("Time zone: Africa/Addis_Ababa (this device)")).toBeOnTheScreen();

    type("Search time zones", "zzzz");
    expect(screen.getByText("No matching time zones.")).toBeOnTheScreen();
  });

  test.each([
    ["5", 5],
    ["240", 240],
    [" 90 ", 90],
  ])("the stale threshold %p is sent as %p", async (text, minutes) => {
    await open();

    type("Stale threshold in minutes", text);
    await pressSave();

    expect(mockUpdate.mock.calls[0]?.[0].staleThresholdMinutes).toBe(minutes);
  });
});

describe("checks before saving", () => {
  test.each(["", "4", "241", "30.5", "1e2", "0x1f", "-5", "+30", "thirty"])(
    "the stale threshold %p is refused before any call",
    async (text) => {
      await open();

      type("Stale threshold in minutes", text);
      await pressSave();

      expect(screen.getByText(THRESHOLD_RULE)).toBeOnTheScreen();
      expect(mockUpdate).not.toHaveBeenCalled();
    },
  );

  test("quiet hours that start and end at the same time are refused", async () => {
    serve(STORED);
    await open();

    pickTime("Quiet hours end", "22:00");
    await pressSave();

    expect(screen.getByText(EQUAL_TIMES)).toBeOnTheScreen();
    expect(mockUpdate).not.toHaveBeenCalled();

    pickTime("Quiet hours end", "06:00");
    expect(screen.queryByText(EQUAL_TIMES)).not.toBeOnTheScreen();
  });

  test("editing a field clears its message and keeps the others", async () => {
    serve(STORED);
    await open();
    pickTime("Quiet hours end", "22:00");
    type("Stale threshold in minutes", "4");
    await pressSave();
    expect(screen.getByText(EQUAL_TIMES)).toBeOnTheScreen();
    expect(screen.getByText(THRESHOLD_RULE)).toBeOnTheScreen();
    expect(announce).toHaveBeenLastCalledWith(`${EQUAL_TIMES} ${THRESHOLD_RULE}`);

    pickTime("Quiet hours start", "21:00");
    expect(screen.queryByText(EQUAL_TIMES)).not.toBeOnTheScreen();
    expect(screen.getByText(THRESHOLD_RULE)).toBeOnTheScreen();
  });
});

describe("refusals and failures", () => {
  const invalid = (field?: string) =>
    new ConvexError({
      code: "invalid",
      message: "Invalid",
      ...(field === undefined ? {} : { field }),
    });

  test.each(["timeZone", "quietStart", "quietEnd", "digestTime", "staleThresholdMinutes"] as const)(
    "an invalid refusal naming %s shows on that field and keeps the draft",
    async (field) => {
      serve(STORED);
      mockUpdate.mockRejectedValueOnce(invalid(field));
      await open();

      pickTime("Digest time", "06:00");
      await pressSave();

      expect(screen.getByText(refusalMessage(field))).toBeOnTheScreen();
      expect(timeOf("Digest time")).toBe("06:00");
      expect(screen.queryByText(SAVED)).not.toBeOnTheScreen();
      expect(screen.queryByText(REFUSED)).not.toBeOnTheScreen();
    },
  );

  test("an invalid refusal without a known field shows on the form", async () => {
    mockUpdate.mockRejectedValueOnce(invalid("somethingElse"));
    await open();

    await pressSave();

    expect(screen.getByText(REFUSED)).toBeOnTheScreen();
    expect(screen.queryByText(SAVED)).not.toBeOnTheScreen();
  });

  test("a failed save keeps the edits, shows no success, and Retry sends the same call", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("offline"));
    await open();

    pickTime("Digest time", "07:00");
    type("Stale threshold in minutes", "15");
    await pressSave();

    expect(screen.getByText(SAVE_FAILED)).toBeOnTheScreen();
    expect(announce).toHaveBeenLastCalledWith(SAVE_FAILED);
    expect(screen.queryByText(SAVED)).not.toBeOnTheScreen();
    expect(timeOf("Digest time")).toBe("07:00");
    expect(input("Stale threshold in minutes").props.value).toBe("15");
    expect(saveButton()).toHaveTextContent("Retry");

    await pressSave();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls[1]?.[0]).toEqual(mockUpdate.mock.calls[0]?.[0]);
    expect(screen.getByText(SAVED)).toBeOnTheScreen();
    expect(announce).toHaveBeenLastCalledWith(SAVED);
    expect(screen.queryByText(SAVE_FAILED)).not.toBeOnTheScreen();
  });

  test("an edit after a failed save is checked again before a new save", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("offline"));
    await open();

    await pressSave();
    expect(saveButton()).toHaveTextContent("Retry");

    type("Stale threshold in minutes", "4");
    expect(saveButton()).toHaveTextContent("Save settings");
    await pressSave();

    expect(screen.getByText(THRESHOLD_RULE)).toBeOnTheScreen();
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    type("Stale threshold in minutes", "5");
    await pressSave();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls[1]?.[0].staleThresholdMinutes).toBe(5);
  });
});

describe("one call at a time", () => {
  test("repeated Save presses send one call and the controls are disabled while it runs", async () => {
    const pending = deferred<NotificationSettings>();
    mockUpdate.mockReturnValueOnce(pending.promise);
    serve(STORED);
    await open();
    openZones();

    await act(async () => {
      fireEvent.press(saveButton());
      fireEvent.press(saveButton());
    });
    await press(saveButton());

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(saveButton()).toHaveTextContent("Saving...");
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    expect(input("Quiet hours").props.disabled).toBe(true);
    expect(input("Urgent decisions still push").props.disabled).toBe(true);
    expect(input("Quiet hours start").props.disabled).toBe(true);
    expect(input("Digest time").props.disabled).toBe(true);
    expect(input("Stale threshold in minutes").props.editable).toBe(false);
    expect(zoneRow()).toBeDisabled();
    expect(input("Search time zones").props.editable).toBe(false);
    expect(input("Other time zone").props.editable).toBe(false);
    expect(choice("Time zone: UTC")).toBeDisabled();
    expect(choice("Use time zone")).toBeDisabled();

    await act(async () => pending.resolve(STORED));
    await settle();
    expect(saveButton()).toHaveTextContent("Save settings");
    expect(screen.getByText(SAVED)).toBeOnTheScreen();
  });

  test("competing Retry presses after a failure send one call", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("offline"));
    const pending = deferred<NotificationSettings>();
    mockUpdate.mockReturnValueOnce(pending.promise);
    await open();
    await pressSave();
    expect(saveButton()).toHaveTextContent("Retry");

    await act(async () => {
      fireEvent.press(saveButton());
      fireEvent.press(saveButton());
    });
    expect(mockUpdate).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve(DEFAULTS));
    await settle();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("feedback", () => {
  test("a save plays the success haptic and a failure the error haptic", async () => {
    const success = jest.spyOn(haptic, "success");
    const error = jest.spyOn(haptic, "error");
    mockUpdate.mockRejectedValueOnce(new Error("offline"));
    await open();

    await pressSave();
    expect(error).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();

    await pressSave();
    expect(success).toHaveBeenCalledTimes(1);
  });

  test("a refusal is read out to VoiceOver", async () => {
    mockUpdate.mockRejectedValueOnce(
      new ConvexError({ code: "invalid", message: "Invalid", field: "digestTime" }),
    );
    await open();

    await pressSave();

    expect(announce).toHaveBeenCalledWith(refusalMessage("digestTime"));
  });

  test("the stale threshold's number pad has a Done button that closes the keyboard", async () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    await open();

    const toolbar = input("Stale threshold in minutes").props.inputAccessoryViewID;
    expect(toolbar).toEqual(expect.any(String));
    fireEvent.press(screen.getByRole("button", { name: "Done" }));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("leaving with unsaved edits", () => {
  async function openFromSettings() {
    await open("/settings");
    fireEvent.press(screen.getByRole("button", { name: "Notifications" }));
    await settle();
    expect(screen).toHavePathname(url);
  }

  test("an unchanged form leaves without asking", async () => {
    await openFromSettings();

    act(() => router.back());
    await settle();

    expect(sheet).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings");
  });

  test("an edit asks first; Keep Editing stays and Discard Changes leaves", async () => {
    await openFromSettings();
    pickTime("Digest time", "06:00");

    act(() => router.back());
    await settle();

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.lastCall?.[0]).toMatchObject({
      options: ["Discard Changes", "Keep Editing"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    chooseInSheet("Keep Editing");
    await settle();
    expect(screen).toHavePathname(url);
    expect(timeOf("Digest time")).toBe("06:00");

    act(() => router.back());
    await settle();
    chooseInSheet("Discard Changes");
    await settle();

    expect(screen).toHavePathname("/settings");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("a saved edit leaves without asking", async () => {
    await openFromSettings();
    pickTime("Digest time", "06:00");
    await pressSave();

    act(() => router.back());
    await settle();

    expect(sheet).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings");
  });
});

describe("live changes and late results", () => {
  test("a live change replaces an unedited form", async () => {
    await open();

    act(() => serve({ ...DEFAULTS, time_zone: "Europe/Paris", time_zone_source: "device" }));
    await settle();

    expect(selectedZone()).toBe("Europe/Paris");
    expect(screen.queryByText(FALLBACK_NOTE)).not.toBeOnTheScreen();
  });

  test("a live change never erases an edit", async () => {
    await open();
    pickTime("Digest time", "10:00");

    act(() => serve({ ...DEFAULTS, stale_threshold_minutes: 90, digest_time: "11:00" }));
    await settle();

    expect(timeOf("Digest time")).toBe("10:00");
    expect(input("Stale threshold in minutes").props.value).toBe("30");
  });

  test("a live change keeps the draft of a failed save", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("offline"));
    await open();
    await pressSave();
    expect(screen.getByText(SAVE_FAILED)).toBeOnTheScreen();

    act(() => serve({ ...DEFAULTS, digest_time: "11:00" }));
    await settle();

    expect(timeOf("Digest time")).toBe("09:00");
    expect(screen.getByText(SAVE_FAILED)).toBeOnTheScreen();
  });

  test("a save that settles after the screen closed changes nothing", async () => {
    const pending = deferred<NotificationSettings>();
    mockUpdate.mockReturnValueOnce(pending.promise);
    await open("/");
    await findInbox();
    act(() => router.push(url));
    await settle();
    await pressSave();

    act(() => router.back());
    await settle();
    expect(screen).toHavePathname("/");

    await act(async () => pending.resolve({ ...DEFAULTS, digest_time: "05:00" }));
    await settle();
    expect(await findInbox()).toBeOnTheScreen();
  });

  test("a save from an ended session does not update the next session's form", async () => {
    const pending = deferred<NotificationSettings>();
    mockUpdate.mockReturnValueOnce(pending.promise);
    await open();
    pickTime("Digest time", "05:00");
    await pressSave();
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    act(() => signOutAll());
    await screen.findByLabelText("Email address");
    serve(STORED);
    act(() => signInAs("sess_b"));
    await findInbox();
    act(() => router.push(url));
    await settle();
    expect(timeOf("Digest time")).toBe("18:30");

    await act(async () => pending.resolve({ ...DEFAULTS, digest_time: "05:00" }));
    await settle();

    expect(timeOf("Digest time")).toBe("18:30");
    expect(screen.queryByText(SAVED)).not.toBeOnTheScreen();
  });
});

describe("form helpers", () => {
  const base: Draft = draftOf(DEFAULTS);

  test("parseTime accepts 00:00 to 23:59 only", () => {
    expect(parseTime("00:00")).toBe(0);
    expect(parseTime("23:59")).toBe(23 * 60 + 59);
    for (const value of ["24:00", "23:60", "9:00", "09:0", " 09:00", "0900", ""]) {
      expect(parseTime(value)).toBeNull();
    }
  });

  test("timeAsDate and dateAsTime carry HH:MM through the native picker's Date", () => {
    for (const time of ["00:00", "07:05", "12:30", "23:59"]) {
      expect(dateAsTime(timeAsDate(time, "09:00"))).toBe(time);
    }
    expect(dateAsTime(timeAsDate("", "22:00"))).toBe("22:00");
    expect(dateAsTime(timeAsDate("bad", "bad"))).toBe("00:00");
  });

  test("zoneName shows a zone's city, or the whole name without a region", () => {
    expect(zoneName("Africa/Addis_Ababa")).toBe("Addis Ababa");
    expect(zoneName("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneName("UTC")).toBe("UTC");
  });

  test("parseThreshold accepts whole numbers from 5 to 240", () => {
    expect(parseThreshold("4")).toBeNull();
    expect(parseThreshold("5")).toBe(5);
    expect(parseThreshold("240")).toBe(240);
    expect(parseThreshold("241")).toBeNull();
    for (const value of ["", " ", "30.0", "30.5", "1e2", "0x1f", "-30", "+30", "3 0"]) {
      expect(parseThreshold(value)).toBeNull();
    }
  });

  // The pickers only produce valid times; the checks still guard the draft
  // the form sends.
  test.each(["", "9:00", "24:00", "12:60", "1200", "ab:cd", "09:00:00"])(
    "validateDraft refuses the digest time %p",
    (digestTime) => {
      expect(validateDraft({ ...base, digestTime })).toEqual({
        ok: false,
        errors: { digestTime: TIME_RULE },
      });
    },
  );

  test("validateDraft refuses malformed, missing, and equal quiet hours", () => {
    const quiet = { ...base, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00" };
    expect(validateDraft({ ...quiet, quietStart: "7:00" })).toMatchObject({
      ok: false,
      errors: { quietStart: TIME_RULE },
    });
    expect(validateDraft({ ...quiet, quietEnd: "23:61" })).toMatchObject({
      ok: false,
      errors: { quietEnd: TIME_RULE },
    });
    expect(validateDraft({ ...quiet, quietStart: "" })).toMatchObject({
      ok: false,
      errors: { quietStart: MISSING_START },
    });
    expect(validateDraft({ ...quiet, quietEnd: " " })).toMatchObject({
      ok: false,
      errors: { quietEnd: MISSING_END },
    });
    expect(validateDraft({ ...quiet, quietEnd: "22:00" })).toMatchObject({
      ok: false,
      errors: { quietEnd: EQUAL_TIMES },
    });
  });

  test("validateDraft checks a chosen zone with Intl and maps disabled quiet hours to null", () => {
    expect(validateDraft({ ...base, timeZone: "Not/A_Zone", timeZoneChosen: true })).toEqual({
      ok: false,
      errors: { timeZone: ZONE_RULE },
    });
    expect(validateDraft({ ...base, timeZone: "Asia/Kathmandu", timeZoneChosen: true })).toEqual({
      ok: true,
      args: {
        timeZone: "Asia/Kathmandu",
        quietStart: null,
        quietEnd: null,
        urgentOverride: true,
        digestTime: "09:00",
        staleThresholdMinutes: 30,
      },
    });
    // Typed ends are kept in the draft but not sent while quiet hours are off.
    expect(
      validateDraft({ ...base, quietEnabled: false, quietStart: "22:00", quietEnd: "bad" }),
    ).toMatchObject({ ok: true, args: { quietStart: null, quietEnd: null } });
  });

  test("overnightLabel marks only a window that ends before it starts", () => {
    expect(overnightLabel("22:00", "07:00")).toBe(
      "Quiet hours run overnight: from 22:00 until 07:00 the next day.",
    );
    expect(overnightLabel("07:00", "22:00")).toBeNull();
    expect(overnightLabel("22:00", "7")).toBeNull();
  });

  test("zoneChoices puts the device zone first, then the selected one, each once", () => {
    expect(
      zoneChoices({
        selected: "UTC",
        device: "Europe/Berlin",
        supported: ["UTC", "Europe/Berlin"],
      }),
    ).toEqual(["Europe/Berlin", "UTC"]);
    expect(zoneChoices({ selected: "Custom/Zone", device: null, supported: ["UTC"] })).toEqual([
      "Custom/Zone",
      "UTC",
    ]);
  });

  test("filterZones ignores case and treats spaces as underscores", () => {
    expect(filterZones(["America/New_York", "UTC"], "NEW york")).toEqual(["America/New_York"]);
    expect(filterZones(["America/New_York", "UTC"], "  ")).toEqual(["America/New_York", "UTC"]);
  });

  test("supportedTimeZones uses Intl.supportedValuesOf when the runtime has it", () => {
    const zones = supportedTimeZones();
    expect(zones).toContain("UTC");
    expect(zones).toContain("Pacific/Honolulu");
    expect(FALLBACK_TIME_ZONES).not.toContain("Pacific/Honolulu");
    expect(zones.length).toBeGreaterThan(FALLBACK_TIME_ZONES.length);
  });

  test("supportedTimeZones falls back to the explicit list without Intl.supportedValuesOf", () => {
    const intl = Intl as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    try {
      intl.supportedValuesOf = undefined;
      expect(supportedTimeZones()).toEqual([...FALLBACK_TIME_ZONES]);
      intl.supportedValuesOf = () => {
        throw new RangeError("unsupported");
      };
      expect(supportedTimeZones()).toEqual([...FALLBACK_TIME_ZONES]);
    } finally {
      intl.supportedValuesOf = original;
    }
    expect(FALLBACK_TIME_ZONES).toContain("UTC");
    for (const zone of FALLBACK_TIME_ZONES) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
    }
  });

  test("deviceTimeZone returns the reported zone only when Intl accepts it", () => {
    deviceZone = "Asia/Tokyo";
    expect(deviceTimeZone()).toBe("Asia/Tokyo");
    deviceZone = "Not/A_Zone";
    expect(deviceTimeZone()).toBeNull();
    deviceZone = undefined;
    expect(deviceTimeZone()).toBeNull();
  });
});

describe("the picker without Intl.supportedValuesOf", () => {
  const intl = Intl as { supportedValuesOf?: unknown };
  let original: unknown;
  beforeEach(() => {
    original = intl.supportedValuesOf;
    intl.supportedValuesOf = undefined;
  });
  afterEach(() => {
    intl.supportedValuesOf = original;
  });

  test("offers the fallback zones and still accepts any zone Intl knows", async () => {
    await open();
    openZones();

    type("Search time zones", "kathmandu");
    expect(screen.getByText("No matching time zones.")).toBeOnTheScreen();

    type("Search time zones", "lagos");
    expect(choice("Time zone: Africa/Lagos")).toBeOnTheScreen();

    type("Other time zone", "Asia/Kathmandu");
    await press(choice("Use time zone"));
    await pressSave();
    expect(mockUpdate.mock.calls[0]?.[0].timeZone).toBe("Asia/Kathmandu");
  });
});

describe("touch targets", () => {
  // A native switch or text field takes touches only inside its own bounds,
  // so on Android each is itself 48 dp tall and at least 48 dp wide, spanning
  // the grouped row's height (DEC-17(4)). iOS keeps the system sizes.
  test.each([
    ["android", 48, -10],
    ["ios", undefined, undefined],
  ] as const)(
    "on %s the switches and the stale threshold field are %s dp tall",
    async (os, height, margin) => {
      jest.replaceProperty(Platform, "OS", os);
      await open();

      for (const label of [
        "Quiet hours",
        "Urgent decisions still push",
        "Stale threshold in minutes",
      ]) {
        const style = StyleSheet.flatten(input(label).props.style) ?? {};
        expect(style.height).toBe(height);
        expect(style.marginVertical).toBe(margin);
        if (os === "android") {
          expect(style.minWidth).toBeGreaterThanOrEqual(48);
        }
      }
    },
  );
});
