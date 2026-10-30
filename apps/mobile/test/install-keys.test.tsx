import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AccessibilityInfo } from "react-native";
import { formatConnectionDay } from "../src/connections/format";
import { haptic } from "../src/haptics";
import { revokeConnectionsLabel } from "../src/install-keys/format";
import { REVOKE_NOTE, revokeFailure } from "../src/install-keys/revoke";
import { SECRET_WARNING } from "../src/install-keys/secret";
import {
  CREATE_FAILURE,
  type Draft,
  INITIAL_DRAFT,
  MESSAGES,
  validateDraft,
} from "../src/install-keys/validation";
import {
  analytics,
  clipboard,
  createInstallKey,
  deferred,
  loading,
  queryCalls,
  revokeInstallKey,
  secureStore,
  setQuery,
  signInAs,
} from "./fakes";
import { pressTab, renderApp } from "./render";

// component-mobile-app §Install keys: settings/install-keys lists the
// person's install keys, creates one within the bounds of req-install-keys
// AC-1.2 and AC-1.3, shows its secret once (AC-1.1), and revokes a key with a
// switch that also disconnects its machines (AC-3.1, AC-3.2).

jest.mock("../src/haptics", () => ({
  haptic: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), selection: jest.fn() },
}));

const list = "identity/installKeys:listInstallKeys";
const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);

const SECRET = "adk_s3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Times relative to the real clock: renderRouter installs fake timers that
// start from it.
const now = Date.now();

const sandboxes = {
  installKeyId: "k_sandboxes",
  label: "CI sandboxes",
  harnesses: ["claude-code", "codex"],
  createdAt: now - 3 * DAY,
  expiresAt: now + 27 * DAY,
  ephemeral: true,
  idleLimitMinutes: 60,
  machineLimit: 10,
  machinesConnected: 3,
  lastUsedAt: now - 5 * MINUTE,
};
const devbox = {
  installKeyId: "k_devbox",
  label: "Devbox",
  harnesses: ["cursor"],
  createdAt: now - 40 * DAY,
  expiresAt: now - DAY,
  ephemeral: false,
  machineLimit: 1,
  machinesConnected: 0,
};

beforeEach(() => {
  announce.mockClear();
  for (const fn of Object.values(haptic)) {
    jest.mocked(fn).mockClear();
  }
});

async function openInstallKeys() {
  signInAs("sess_a");
  renderApp("/settings/install-keys");
  // useFocusEffect runs after a timer flush.
  await act(async () => {});
  act(() => jest.advanceTimersByTime(0));
}

function type(label: string, text: string) {
  fireEvent.changeText(screen.getByLabelText(label), text);
}

function check(harness: string) {
  fireEvent.press(screen.getByRole("checkbox", { name: harness }));
}

async function pressCreate() {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Create install key" }));
  });
}

// Fills a valid persistent key: a label and Claude Code, with the default
// expiry and machine limit.
function fillValid(label = "CI sandboxes") {
  type("Label", label);
  check("Claude Code");
}

function draft(overrides: Partial<Draft>): Draft {
  return { ...INITIAL_DRAFT, label: "Key", harnesses: ["codex"], ...overrides };
}

function errorsOf(overrides: Partial<Draft>) {
  const result = validateDraft(draft(overrides));
  return result.ok ? {} : result.errors;
}

describe("create form bounds", () => {
  // req-install-keys AC-1.2
  test("the label is trimmed and must be 1 to 64 characters", () => {
    expect(errorsOf({ label: "" })).toEqual({ label: MESSAGES.label });
    expect(errorsOf({ label: "   " })).toEqual({ label: MESSAGES.label });
    expect(errorsOf({ label: "x".repeat(65) })).toEqual({ label: MESSAGES.label });
    expect(validateDraft(draft({ label: "x".repeat(64) }))).toMatchObject({ ok: true });
    expect(validateDraft(draft({ label: ` ${"x".repeat(64)} ` }))).toMatchObject({
      ok: true,
      args: { label: "x".repeat(64) },
    });
    expect(validateDraft(draft({ label: "a" }))).toMatchObject({ ok: true, args: { label: "a" } });
  });

  test("at least one harness from Claude Code, Codex, and Cursor, in that order", () => {
    expect(errorsOf({ harnesses: [] })).toEqual({ harnesses: MESSAGES.harnesses });
    expect(validateDraft(draft({ harnesses: ["cursor", "claude-code"] }))).toMatchObject({
      ok: true,
      args: { harnesses: ["claude-code", "cursor"] },
    });
  });

  test("the expiry is a whole number of days from 1 to 90", () => {
    for (const bad of ["0", "91", "1.5", "-3", "abc", "", " "]) {
      expect(errorsOf({ expiresInDays: bad })).toEqual({ expiresInDays: MESSAGES.expiresInDays });
    }
    expect(validateDraft(draft({ expiresInDays: "1" }))).toMatchObject({
      args: { expiresInDays: 1 },
    });
    expect(validateDraft(draft({ expiresInDays: "90" }))).toMatchObject({
      args: { expiresInDays: 90 },
    });
  });

  test("the machine limit is a whole number from 1 to 100", () => {
    for (const bad of ["0", "101", "2.5", "ten", ""]) {
      expect(errorsOf({ machineLimit: bad })).toEqual({ machineLimit: MESSAGES.machineLimit });
    }
    expect(validateDraft(draft({ machineLimit: "1" }))).toMatchObject({
      args: { machineLimit: 1 },
    });
    expect(validateDraft(draft({ machineLimit: "100" }))).toMatchObject({
      args: { machineLimit: 100 },
    });
  });

  // req-install-keys AC-1.3
  test("an ephemeral key needs an idle limit of 15 to 1440 minutes; any other key sends none", () => {
    for (const bad of ["14", "1441", "30.5", "", "x"]) {
      expect(errorsOf({ ephemeral: true, idleLimitMinutes: bad })).toEqual({
        idleLimitMinutes: MESSAGES.idleLimitMinutes,
      });
    }
    expect(validateDraft(draft({ ephemeral: true, idleLimitMinutes: "15" }))).toMatchObject({
      args: { ephemeral: true, idleLimitMinutes: 15 },
    });
    expect(validateDraft(draft({ ephemeral: true, idleLimitMinutes: "1440" }))).toMatchObject({
      args: { ephemeral: true, idleLimitMinutes: 1440 },
    });
    // A persistent key ignores whatever the hidden field holds.
    const persistent = validateDraft(draft({ ephemeral: false, idleLimitMinutes: "3" }));
    expect(persistent.ok).toBe(true);
    expect(persistent.ok && "idleLimitMinutes" in persistent.args).toBe(false);
  });

  test("every failing field is named at once", () => {
    expect(
      Object.keys(
        errorsOf({
          label: "",
          harnesses: [],
          expiresInDays: "0",
          machineLimit: "0",
          ephemeral: true,
          idleLimitMinutes: "0",
        }),
      ),
    ).toEqual(["label", "harnesses", "expiresInDays", "machineLimit", "idleLimitMinutes"]);
  });
});

describe("install keys list", () => {
  // req-install-keys AC-3.1
  test("shows each key's label, harnesses, lifetime, dates, machines, and last use, and no secret", async () => {
    setQuery(list, [sandboxes, devbox]);
    await openInstallKeys();

    expect(await screen.findByText("CI sandboxes")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: list, args: {} });
    expect(
      screen.getByText("Claude Code, Codex · Ephemeral, ends after 1 hour idle"),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        `Created ${formatConnectionDay(sandboxes.createdAt, now)} · expires ${formatConnectionDay(sandboxes.expiresAt, now)}`,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("3 of 10 machines connected · used 5m ago")).toBeOnTheScreen();

    // An expired key stays listed, marked expired, and a never-used key says so.
    expect(screen.getByText("Devbox")).toBeOnTheScreen();
    expect(screen.getByText("Cursor · Persistent")).toBeOnTheScreen();
    expect(screen.getByText("Expired")).toBeOnTheScreen();
    expect(
      screen.getByText(
        `Created ${formatConnectionDay(devbox.createdAt, now)} · expired ${formatConnectionDay(devbox.expiresAt, now)}`,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("0 of 1 machine connected · never used")).toBeOnTheScreen();

    // VoiceOver reads each key as one element, in words.
    expect(screen.getByLabelText("Install key Devbox")).toHaveProp("accessibilityValue", {
      text: `Expired. Cursor. Persistent. Created ${formatConnectionDay(devbox.createdAt, now)}, expired ${formatConnectionDay(devbox.expiresAt, now)}. 0 of 1 machine connected. never used`,
    });
    expect(screen.getByLabelText("Install key CI sandboxes").props.accessibilityValue.text).toMatch(
      /3 of 10 machines connected\. last used 5 minutes ago$/,
    );
    expect(screen.queryByText(/adk_/)).not.toBeOnTheScreen();
  });

  test("follows the reactive query: a new machine count, and a key revoked elsewhere leaving", async () => {
    setQuery(list, [sandboxes, devbox]);
    await openInstallKeys();
    expect(await screen.findByText("3 of 10 machines connected · used 5m ago")).toBeOnTheScreen();

    act(() => setQuery(list, [{ ...sandboxes, machinesConnected: 4 }, devbox]));
    expect(screen.getByText("4 of 10 machines connected · used 5m ago")).toBeOnTheScreen();

    act(() => setQuery(list, [devbox]));
    expect(screen.queryByText("CI sandboxes")).not.toBeOnTheScreen();
    expect(screen.getByText("Devbox")).toBeOnTheScreen();
  });

  test("shows loading, then an empty list, and a failed query offers a retry while the form stays", async () => {
    setQuery(list, loading);
    await openInstallKeys();
    expect(await screen.findByText("Loading install keys")).toBeOnTheScreen();

    act(() => setQuery(list, []));
    expect(screen.getByText("No install keys")).toBeOnTheScreen();

    jest.spyOn(console, "error").mockImplementation(() => {});
    act(() => setQuery(list, new Error("Network request failed")));
    expect(await screen.findByText("Could not load your install keys.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Create install key" })).toBeOnTheScreen();

    setQuery(list, [devbox]);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Devbox")).toBeOnTheScreen();
    jest.mocked(console.error).mockRestore();
  });
});

describe("creating an install key", () => {
  test("sends the checked fields without an idle limit for a persistent key", async () => {
    createInstallKey.mockResolvedValue({ installKeyId: "k_new", secret: SECRET });
    await openInstallKeys();

    expect(screen.queryByLabelText("Idle limit in minutes")).not.toBeOnTheScreen();
    type("Label", "  CI sandboxes  ");
    check("Codex");
    check("Claude Code");
    type("Expiry in days", "90");
    type("Machine limit", "100");
    await pressCreate();

    expect(createInstallKey).toHaveBeenCalledTimes(1);
    expect(createInstallKey).toHaveBeenCalledWith({
      label: "CI sandboxes",
      harnesses: ["claude-code", "codex"],
      expiresInDays: 90,
      machineLimit: 100,
      ephemeral: false,
    });
  });

  test("shows the idle limit only for an ephemeral key and sends it then", async () => {
    createInstallKey.mockResolvedValue({ installKeyId: "k_new", secret: SECRET });
    await openInstallKeys();

    fillValid();
    fireEvent(screen.getByLabelText("Ephemeral"), "valueChange", true);
    expect(screen.getByLabelText("Idle limit in minutes")).toBeOnTheScreen();
    type("Idle limit in minutes", "15");
    await pressCreate();

    expect(createInstallKey).toHaveBeenCalledWith({
      label: "CI sandboxes",
      harnesses: ["claude-code"],
      expiresInDays: 30,
      machineLimit: 10,
      ephemeral: true,
      idleLimitMinutes: 15,
    });
  });

  test("names every bad field under it and sends nothing", async () => {
    await openInstallKeys();

    type("Label", "x".repeat(65));
    type("Expiry in days", "91");
    type("Machine limit", "0");
    fireEvent(screen.getByLabelText("Ephemeral"), "valueChange", true);
    type("Idle limit in minutes", "1441");
    await pressCreate();

    for (const message of Object.values(MESSAGES)) {
      expect(screen.getByText(message)).toBeOnTheScreen();
    }
    expect(createInstallKey).not.toHaveBeenCalled();
    expect(haptic.error).toHaveBeenCalledTimes(1);

    // Editing a field clears its own error only.
    type("Label", "Fixed");
    expect(screen.queryByText(MESSAGES.label)).not.toBeOnTheScreen();
    expect(screen.getByText(MESSAGES.harnesses)).toBeOnTheScreen();
  });

  test("a field the backend refuses is named under it, and any other failure keeps the draft", async () => {
    const { ConvexError } = jest.requireActual<typeof import("convex/values")>("convex/values");
    createInstallKey.mockRejectedValueOnce(
      new ConvexError({
        code: "invalid",
        message: "machineLimit must be an integer from 1 to 100",
        field: "machineLimit",
      }),
    );
    await openInstallKeys();
    fillValid();
    await pressCreate();

    expect(screen.getByText(MESSAGES.machineLimit)).toBeOnTheScreen();
    expect(screen.queryByText(/must be an integer/)).not.toBeOnTheScreen();

    createInstallKey.mockRejectedValueOnce(new Error("Network request failed"));
    await pressCreate();

    expect(screen.getByText(CREATE_FAILURE)).toBeOnTheScreen();
    expect(screen.getByLabelText("Label")).toHaveProp("value", "CI sandboxes");
    expect(announce).toHaveBeenCalledWith(CREATE_FAILURE);
  });

  test("sends one request while it runs", async () => {
    const pending = deferred<{ installKeyId: string; secret: string }>();
    createInstallKey.mockReturnValue(pending.promise);
    await openInstallKeys();
    fillValid();

    await pressCreate();
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    fireEvent.press(screen.getByRole("button", { name: "Creating..." }));
    expect(createInstallKey).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve({ installKeyId: "k_new", secret: SECRET }));
    expect(screen.getByText(SECRET)).toBeOnTheScreen();
  });
});

// req-install-keys AC-1.1
describe("the one-time secret", () => {
  async function createKey() {
    createInstallKey.mockResolvedValue({ installKeyId: "k_new", secret: SECRET });
    await openInstallKeys();
    fillValid();
    await pressCreate();
  }

  test("shows the secret once with a warning and a copy button that copies it on press", async () => {
    await createKey();

    expect(screen.getByText(SECRET)).toBeOnTheScreen();
    expect(screen.getByText(SECRET_WARNING)).toBeOnTheScreen();
    expect(screen.getByText("CI sandboxes created")).toBeOnTheScreen();
    expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    // The form gives way to the secret, so no second key starts under it.
    expect(screen.queryByRole("button", { name: "Create install key" })).not.toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Copy" }));
    });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(SECRET);
    expect(screen.getByRole("button", { name: "Copied" })).toBeOnTheScreen();

    fireEvent.press(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(SECRET)).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Create install key" })).toBeOnTheScreen();
    expect(screen.getByLabelText("Label")).toHaveProp("value", "");
  });

  test("a failed copy says so and keeps the secret on the screen", async () => {
    await createKey();
    clipboard.setStringAsync.mockRejectedValueOnce(new Error("Clipboard unavailable"));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Copy" }));
    });

    expect(
      screen.getByText("Could not copy the key. Select it and copy it instead."),
    ).toBeOnTheScreen();
    expect(screen.getByText(SECRET)).toBeOnTheScreen();
  });

  test("leaving the screen discards the secret, though the tab keeps the screen mounted", async () => {
    await createKey();
    expect(screen.getByText(SECRET)).toBeOnTheScreen();

    pressTab("Inbox");
    act(() => jest.advanceTimersByTime(0));
    pressTab("Settings");
    act(() => jest.advanceTimersByTime(0));

    expect(await screen.findByRole("button", { name: "Create install key" })).toBeOnTheScreen();
    expect(screen.queryByText(SECRET)).not.toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/install-keys");
  });

  test("a create that settles after the person left never shows its secret", async () => {
    const pending = deferred<{ installKeyId: string; secret: string }>();
    createInstallKey.mockReturnValue(pending.promise);
    await openInstallKeys();
    fillValid();
    await pressCreate();

    pressTab("Inbox");
    act(() => jest.advanceTimersByTime(0));
    await act(async () => pending.resolve({ installKeyId: "k_new", secret: SECRET }));
    pressTab("Settings");
    act(() => jest.advanceTimersByTime(0));

    expect(await screen.findByRole("button", { name: "Create install key" })).toBeOnTheScreen();
    expect(screen.queryByText(SECRET)).not.toBeOnTheScreen();
  });

  test("the secret reaches no route parameter, storage, log, or analytics event", async () => {
    const log = jest.spyOn(console, "log");
    const warn = jest.spyOn(console, "warn");
    const error = jest.spyOn(console, "error");
    await createKey();
    expect(screen.getByText(SECRET)).toBeOnTheScreen();

    expect(screen).toHavePathname("/settings/install-keys");
    expect(screen).toHaveSearchParams({});
    expect(secureStore.setItemAsync).not.toHaveBeenCalledWith(expect.anything(), SECRET);
    const seen = JSON.stringify([
      log.mock.calls,
      warn.mock.calls,
      error.mock.calls,
      analytics.screen.mock.calls,
      announce.mock.calls,
    ]);
    expect(seen).not.toContain(SECRET);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

// req-install-keys AC-3.2
describe("revoking an install key", () => {
  async function openRevoke() {
    setQuery(list, [sandboxes, devbox]);
    await openInstallKeys();
    fireEvent.press(await screen.findByRole("button", { name: "Revoke CI sandboxes" }));
  }

  function revokeSwitch() {
    return screen.getByLabelText(revokeConnectionsLabel(sandboxes.machinesConnected));
  }

  async function pressRevoke() {
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Revoke key" }));
    });
  }

  test("the switch is off by default, labelled with the machine count, and the key's connections stay", async () => {
    revokeInstallKey.mockResolvedValue(null);
    await openRevoke();

    expect(screen.getByText("Revoke CI sandboxes?")).toBeOnTheScreen();
    expect(screen.getByText(REVOKE_NOTE)).toBeOnTheScreen();
    expect(
      screen.getByText("Also disconnect 3 machines connected with this key"),
    ).toBeOnTheScreen();
    expect(revokeSwitch()).toHaveProp("value", false);
    expect(revokeInstallKey).not.toHaveBeenCalled();

    await pressRevoke();

    expect(revokeInstallKey).toHaveBeenCalledTimes(1);
    expect(revokeInstallKey).toHaveBeenCalledWith({
      installKeyId: "k_sandboxes",
      revokeConnections: false,
    });
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Revoked CI sandboxes");
    // The key stays until the reactive query drops it.
    expect(screen.getByText("CI sandboxes")).toBeOnTheScreen();
    act(() => setQuery(list, [devbox]));
    expect(screen.queryByText("CI sandboxes")).not.toBeOnTheScreen();
  });

  test("with the switch on, the key's connections are revoked in the same act", async () => {
    revokeInstallKey.mockResolvedValue(null);
    await openRevoke();

    fireEvent(revokeSwitch(), "valueChange", true);
    expect(revokeSwitch()).toHaveProp("value", true);
    await pressRevoke();

    expect(revokeInstallKey).toHaveBeenCalledWith({
      installKeyId: "k_sandboxes",
      revokeConnections: true,
    });
  });

  test("the label follows the backend's machine count while the panel is open", async () => {
    await openRevoke();

    act(() => setQuery(list, [{ ...sandboxes, machinesConnected: 1 }, devbox]));

    expect(screen.getByText("Also disconnect 1 machine connected with this key")).toBeOnTheScreen();
    expect(
      screen.queryByText("Also disconnect 3 machines connected with this key"),
    ).not.toBeOnTheScreen();
  });

  test("Cancel closes the panel and revokes nothing", async () => {
    await openRevoke();

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Revoke CI sandboxes?")).not.toBeOnTheScreen();
    expect(revokeInstallKey).not.toHaveBeenCalled();
  });

  test("sends one revocation while it runs, and a failure stays recoverable", async () => {
    const pending = deferred<null>();
    revokeInstallKey.mockReturnValueOnce(pending.promise);
    await openRevoke();

    await pressRevoke();
    const busy = screen.getByRole("button", { name: "Revoking..." });
    expect(busy).toBeDisabled();
    fireEvent.press(busy);
    expect(revokeInstallKey).toHaveBeenCalledTimes(1);

    await act(async () => pending.reject(new Error("Network request failed")));

    const message = revokeFailure("CI sandboxes");
    expect(screen.getByText(message)).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(message);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Network request failed/)).not.toBeOnTheScreen();

    revokeInstallKey.mockResolvedValueOnce(null);
    await pressRevoke();
    expect(revokeInstallKey).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(message)).not.toBeOnTheScreen();
  });
});

describe("Settings → Connections", () => {
  test("lists install keys below the connections and opens the install keys screen", async () => {
    setQuery(list, [sandboxes]);
    signInAs("sess_a");
    renderApp("/settings/connections");

    const section = await screen.findByRole("header", { name: "Install keys" });
    expect(section).toBeOnTheScreen();
    expect(screen.getByText("CI sandboxes")).toBeOnTheScreen();
    expect(screen.getByText("3 of 10 machines connected · used 5m ago")).toBeOnTheScreen();
    // The list here only shows keys; revoking lives on the install keys screen.
    expect(screen.queryByRole("button", { name: "Revoke CI sandboxes" })).not.toBeOnTheScreen();

    fireEvent.press(screen.getByRole("button", { name: "Manage install keys" }));

    await waitFor(() => expect(screen).toHavePathname("/settings/install-keys"));
    expect(await screen.findByRole("button", { name: "Create install key" })).toBeOnTheScreen();
  });

  test.each([
    ["no connections", [] as unknown],
    ["loading connections", loading as unknown],
    ["failed connections", new Error("Network request failed") as unknown],
  ])("the install keys entry opens the screen with %s", async (_name, connections) => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    setQuery("identity/connections:listConnections", connections);
    setQuery(list, []);
    signInAs("sess_a");
    renderApp("/settings/connections");

    expect(await screen.findByText("No install keys")).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Manage install keys" }));

    await waitFor(() => expect(screen).toHavePathname("/settings/install-keys"));
    jest.mocked(console.error).mockRestore();
  });

  test("a failed install key query keeps the entry and offers a retry", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    setQuery("identity/connections:listConnections", []);
    setQuery(list, new Error("Network request failed"));
    signInAs("sess_a");
    renderApp("/settings/connections");

    expect(await screen.findByText("Could not load your install keys.")).toBeOnTheScreen();
    expect(screen.getByText("No machines connected")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Manage install keys" })).toBeOnTheScreen();

    setQuery(list, [sandboxes]);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("CI sandboxes")).toBeOnTheScreen();
    jest.mocked(console.error).mockRestore();
  });
});
