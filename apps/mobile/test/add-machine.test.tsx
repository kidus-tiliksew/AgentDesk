import { getFunctionName } from "convex/server";
import { router } from "expo-router";
import { act, fireEvent, screen } from "expo-router/testing-library";
import { AppState } from "react-native";
import { normalizeCode } from "../src/add-machine";
import { deferred, loading, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens: settings/add-machine takes the installer's
// code, shows the requesting machine and its harnesses, and approves or
// declines (req-accounts-and-connections AC-6.2, AC-6.5, AC-6.6).

const lookupName = "identity/deviceRequests:lookupDeviceRequest";
const approveName = "identity/deviceRequests:approveDeviceRequest";
const declineName = "identity/deviceRequests:declineDeviceRequest";
const list = "identity/connections:listConnections";

const ENTRY_GUIDANCE = "Enter the 8-character code shown by the installer.";
const FOUND_GUIDANCE = "Approve to connect these harnesses on this machine.";
const NOT_FOUND = "That code is wrong or no longer available. Check the code and try again.";
const EXPIRED = "That code expired. Run the installer again for a new code.";
const LOCKED = "Too many wrong codes. Try again in 10 minutes.";
const APPROVED = "The machine is connecting. The installer will finish on its own.";
const DECLINED = "Request declined. Run the installer again for a new code.";
const LOOKUP_FAILED = "Could not find the machine. Check your connection and try again.";
const APPROVE_FAILED = "Could not approve the request. Check your connection and try again.";
const DECLINE_FAILED = "Could not decline the request. Check your connection and try again.";

type CodeArgs = { code: string };

// The shared convex/react fake refuses mutations it does not know. This file
// wraps its useMutation, so the three device-request mutations get local
// mocks and every other mutation, such as ensureAccount, keeps the shared
// fake. `bound` records each device-request mutation a render binds.
const mockLookup = jest.fn<Promise<unknown>, [CodeArgs]>();
const mockApprove = jest.fn<Promise<unknown>, [CodeArgs]>();
const mockDecline = jest.fn<Promise<unknown>, [CodeArgs]>();
const bound = new Set<string>();

const found = {
  status: "found",
  machineName: "devbox-2",
  harnesses: ["codex", "claude-code", "cursor"],
};

beforeEach(() => {
  bound.clear();
  mockLookup.mockReset().mockResolvedValue(found);
  mockApprove.mockReset().mockResolvedValue({ status: "approved" });
  mockDecline.mockReset().mockResolvedValue({ status: "declined" });
  const mocks: Record<string, unknown> = {
    [lookupName]: mockLookup,
    [approveName]: mockApprove,
    [declineName]: mockDecline,
  };
  const convexReact = jest.requireMock<{ useMutation: (reference: unknown) => unknown }>(
    "convex/react",
  );
  const sharedUseMutation = convexReact.useMutation;
  jest.spyOn(convexReact, "useMutation").mockImplementation((reference: unknown) => {
    const name = getFunctionName(reference as never);
    if (name in mocks) {
      bound.add(name);
      return mocks[name];
    }
    return sharedUseMutation(reference);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function openAddMachine() {
  signInAs("sess_a");
  renderApp("/settings/add-machine");
  return screen.findByLabelText("Installer code");
}

function input() {
  return screen.getByLabelText("Installer code");
}

function button(name: string) {
  return screen.getByRole("button", { name });
}

async function press(name: string) {
  await act(async () => {
    fireEvent.press(button(name));
  });
}

// Opens the screen, enters `code`, and finds the request.
async function openFound(code = "abcd-efgh") {
  await openAddMachine();
  fireEvent.changeText(input(), code);
  await press("Find machine");
  expect(screen.getByText("devbox-2")).toBeOnTheScreen();
}

function expectEditableEntry() {
  expect(input()).toHaveProp("editable", true);
  expect(screen.queryByText("devbox-2")).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Decline" })).not.toBeOnTheScreen();
}

function expectLocked() {
  expect(screen.getByText(LOCKED)).toBeOnTheScreen();
  expect(input()).toHaveProp("editable", false);
  expect(button("Find machine")).toBeDisabled();
  expect(screen.queryByText(ENTRY_GUIDANCE)).not.toBeOnTheScreen();
  expect(screen.queryByText("devbox-2")).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Decline" })).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
}

describe("normalizeCode", () => {
  test.each([
    ["ABCDEFGH", "ABCDEFGH"],
    ["abcdefgh", "ABCDEFGH"],
    ["abcd-efgh", "ABCDEFGH"],
    ["AbCd-EfGh", "ABCDEFGH"],
    ["  abcd-2345\n", "ABCD2345"],
    ["\tAB12cd34 ", "AB12CD34"],
  ])("%j normalizes to %s", (raw, code) => {
    expect(normalizeCode(raw)).toBe(code);
  });

  test.each([
    "",
    "ABCDEFG",
    "ABC-DEFGH",
    "ABCDEFGHJ",
    "ABCD-EFGHJ",
    "ABCD--EFGH",
    "AB-CD-EFGH",
    "ABCDEFGH-",
    "ABCD EFGH",
    "ABCD_EFGH",
    "ABCD.EFGH",
    "ABCDEFGß",
    "ABCDEFGĦ",
  ])("%j is not a code", (raw) => {
    expect(normalizeCode(raw)).toBeNull();
  });
});

describe("add machine screen", () => {
  test("shows code entry and keeps Find machine disabled until 8 code characters are present", async () => {
    await openAddMachine();

    expect(screen.getByText(ENTRY_GUIDANCE)).toBeOnTheScreen();
    expect(input()).toHaveProp("placeholder", "ABCD-EFGH");
    expect(button("Find machine")).toBeDisabled();

    fireEvent.changeText(input(), "abcd-efg");
    expect(button("Find machine")).toBeDisabled();

    fireEvent.changeText(input(), "abcd-efgh");
    expect(button("Find machine")).toBeEnabled();

    fireEvent.changeText(input(), "abcdefgh");
    expect(button("Find machine")).toBeEnabled();

    fireEvent.changeText(input(), "abcd-efghj");
    expect(button("Find machine")).toBeDisabled();

    fireEvent.changeText(input(), "ab-cd-efgh");
    expect(button("Find machine")).toBeDisabled();

    // Typing never looks a code up: lookup records wrong-code attempts.
    expect(mockLookup).not.toHaveBeenCalled();
    // The entry screen binds no approve or decline mutation.
    expect(bound).toEqual(new Set([lookupName]));
  });

  // req-accounts-and-connections AC-6.2
  test("Find machine looks up the normalized code and shows the machine and each harness, connecting nothing", async () => {
    await openAddMachine();
    fireEvent.changeText(input(), " abcd-efgh ");

    await press("Find machine");

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith({ code: "ABCDEFGH" });
    expect(screen.getByText("Machine")).toBeOnTheScreen();
    expect(screen.getByText("devbox-2")).toBeOnTheScreen();
    expect(screen.getByText("Harnesses")).toBeOnTheScreen();
    const names = screen
      .getAllByText(/^(Claude Code|Codex|Cursor)$/)
      .map((element) => element.props.children);
    expect(names).toEqual(["Codex", "Claude Code", "Cursor"]);
    expect(screen.getByText(FOUND_GUIDANCE)).toBeOnTheScreen();
    expect(button("Approve")).toBeEnabled();
    expect(button("Decline")).toBeEnabled();
    expect(input()).toHaveProp("editable", false);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();
  });

  // req-accounts-and-connections AC-6.2
  test("Approve sends the found request's code and shows that the machine is connecting", async () => {
    await openFound("wxyz-2345");

    await press("Approve");

    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledWith({ code: "WXYZ2345" });
    expect(mockDecline).not.toHaveBeenCalled();
    expect(screen.getByText(APPROVED)).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeOnTheScreen();

    fireEvent.press(button("Enter another code"));

    expect(input()).toHaveProp("value", "");
    expect(screen.getByText(ENTRY_GUIDANCE)).toBeOnTheScreen();
    expect(screen.queryByText(APPROVED)).not.toBeOnTheScreen();
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledTimes(1);
  });

  // req-accounts-and-connections AC-6.6
  test("Decline sends the found request's code and shows that the request was declined", async () => {
    await openFound("wxyz2345");

    await press("Decline");

    expect(mockDecline).toHaveBeenCalledTimes(1);
    expect(mockDecline).toHaveBeenCalledWith({ code: "WXYZ2345" });
    expect(mockApprove).not.toHaveBeenCalled();
    expect(screen.getByText(DECLINED)).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeOnTheScreen();

    fireEvent.press(button("Enter another code"));

    expect(input()).toHaveProp("value", "");
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  test("Use another code returns to entry without a call", async () => {
    await openFound();

    fireEvent.press(button("Use another code"));

    expectEditableEntry();
    expect(input()).toHaveProp("value", "");
    expect(screen.getByText(ENTRY_GUIDANCE)).toBeOnTheScreen();
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();
  });

  test.each([
    ["not_found", NOT_FOUND],
    ["expired", EXPIRED],
  ])("a %s lookup shows its next step and keeps entry editable", async (status, message) => {
    mockLookup.mockResolvedValueOnce({ status });
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");

    await press("Find machine");

    expect(screen.getByText(message)).toBeOnTheScreen();
    expectEditableEntry();
    expect(button("Find machine")).toBeEnabled();

    // Editing the code clears the obsolete message.
    fireEvent.changeText(input(), "abcd-efgj");
    expect(screen.queryByText(message)).not.toBeOnTheScreen();
  });

  test.each([
    ["Approve", "not_found", NOT_FOUND],
    ["Approve", "expired", EXPIRED],
    ["Decline", "not_found", NOT_FOUND],
    ["Decline", "expired", EXPIRED],
  ])(
    "%s returning %s discards the found request and shows its next step",
    async (action, status, message) => {
      (action === "Approve" ? mockApprove : mockDecline).mockResolvedValueOnce({ status });
      await openFound();

      await press(action);

      expect(screen.getByText(message)).toBeOnTheScreen();
      expectEditableEntry();
      expect(screen.queryByText(APPROVED)).not.toBeOnTheScreen();
      expect(screen.queryByText(DECLINED)).not.toBeOnTheScreen();
      expect(button("Find machine")).toBeEnabled();
    },
  );

  // req-accounts-and-connections AC-6.5
  test("a locked lookup disables code entry and every action", async () => {
    mockLookup.mockResolvedValueOnce({ status: "locked" });
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");

    await press("Find machine");

    expectLocked();
    fireEvent.press(button("Find machine"));
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  // req-accounts-and-connections AC-6.5
  test.each(["Approve", "Decline"])(
    "%s returning locked discards the found request and disables entry",
    async (action) => {
      (action === "Approve" ? mockApprove : mockDecline).mockResolvedValueOnce({
        status: "locked",
      });
      await openFound();

      await press(action);

      expectLocked();
      expect(screen.queryByText(APPROVED)).not.toBeOnTheScreen();
      expect(screen.queryByText(DECLINED)).not.toBeOnTheScreen();
    },
  );

  test("a failed lookup shows an error and Try again repeats it for the same code", async () => {
    mockLookup.mockRejectedValueOnce(new Error("Network request failed"));
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");

    await press("Find machine");

    expect(screen.getByText(LOOKUP_FAILED)).toBeOnTheScreen();
    expect(screen.queryByText("devbox-2")).not.toBeOnTheScreen();
    expect(input()).toHaveProp("editable", true);

    await press("Try again");

    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(mockLookup).toHaveBeenLastCalledWith({ code: "ABCDEFGH" });
    expect(screen.queryByText(LOOKUP_FAILED)).not.toBeOnTheScreen();
    expect(screen.getByText("devbox-2")).toBeOnTheScreen();
  });

  test("editing the code after a failed lookup clears the error and its retry", async () => {
    mockLookup.mockRejectedValueOnce(new Error("Network request failed"));
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");
    await press("Find machine");
    expect(screen.getByText(LOOKUP_FAILED)).toBeOnTheScreen();

    fireEvent.changeText(input(), "wxyz-2345");

    expect(screen.queryByText(LOOKUP_FAILED)).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();

    await press("Find machine");
    expect(mockLookup).toHaveBeenLastCalledWith({ code: "WXYZ2345" });
  });

  test.each([
    ["Approve", APPROVE_FAILED, APPROVED],
    ["Decline", DECLINE_FAILED, DECLINED],
  ])(
    "a failed %s keeps the request, never shows success, and Try again repeats it",
    async (action, failure, success) => {
      const mock = action === "Approve" ? mockApprove : mockDecline;
      const other = action === "Approve" ? mockDecline : mockApprove;
      mock.mockRejectedValueOnce(new Error("Network request failed"));
      await openFound("wxyz-2345");

      await press(action);

      expect(screen.getByText(failure)).toBeOnTheScreen();
      expect(screen.queryByText(success)).not.toBeOnTheScreen();
      expect(screen.getByText("devbox-2")).toBeOnTheScreen();
      expect(button("Approve")).toBeEnabled();
      expect(button("Decline")).toBeEnabled();

      await press("Try again");

      expect(mock).toHaveBeenCalledTimes(2);
      expect(mock).toHaveBeenLastCalledWith({ code: "WXYZ2345" });
      expect(other).not.toHaveBeenCalled();
      expect(screen.queryByText(failure)).not.toBeOnTheScreen();
      expect(screen.getByText(success)).toBeOnTheScreen();
    },
  );

  test("a response outside the typed contract shows a failure, never success", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockApprove.mockResolvedValueOnce({ status: "pending" });
    await openFound();

    await press("Approve");

    expect(screen.getByText(APPROVE_FAILED)).toBeOnTheScreen();
    expect(screen.queryByText(APPROVED)).not.toBeOnTheScreen();
    expect(warn).toHaveBeenCalledWith("Unexpected approve response from identity/deviceRequests", {
      status: "pending",
    });
  });

  test("a found result with an unknown harness shows a failure", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockLookup.mockResolvedValueOnce({ ...found, harnesses: ["vim"] });
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");

    await press("Find machine");

    expect(screen.getByText(LOOKUP_FAILED)).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("sends one lookup while it runs and disables entry", async () => {
    const pending = deferred<unknown>();
    mockLookup.mockReturnValueOnce(pending.promise);
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");

    fireEvent.press(button("Find machine"));
    fireEvent.press(button("Finding machine..."));
    fireEvent.press(button("Finding machine..."));

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(button("Finding machine...")).toBeDisabled();
    expect(input()).toHaveProp("editable", false);

    await act(async () => {
      pending.resolve(found);
    });

    expect(screen.getByText("devbox-2")).toBeOnTheScreen();
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  test("sends one approval while it runs and refuses a competing decline", async () => {
    const pending = deferred<unknown>();
    mockApprove.mockReturnValueOnce(pending.promise);
    await openFound("wxyz-2345");

    fireEvent.press(button("Approve"));
    fireEvent.press(button("Approving..."));
    fireEvent.press(button("Decline"));
    fireEvent.press(button("Use another code"));

    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockDecline).not.toHaveBeenCalled();
    expect(button("Approving...")).toBeDisabled();
    expect(button("Decline")).toBeDisabled();
    expect(button("Use another code")).toBeDisabled();
    expect(screen.getByText("devbox-2")).toBeOnTheScreen();

    await act(async () => {
      pending.resolve({ status: "approved" });
    });

    expect(screen.getByText(APPROVED)).toBeOnTheScreen();
    expect(mockApprove).toHaveBeenCalledWith({ code: "WXYZ2345" });
  });

  test("sends one decline while it runs and refuses a competing approval", async () => {
    const pending = deferred<unknown>();
    mockDecline.mockReturnValueOnce(pending.promise);
    await openFound();

    fireEvent.press(button("Decline"));
    fireEvent.press(button("Declining..."));
    fireEvent.press(button("Approve"));

    expect(mockDecline).toHaveBeenCalledTimes(1);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(button("Approve")).toBeDisabled();

    await act(async () => {
      pending.resolve({ status: "declined" });
    });

    expect(screen.getByText(DECLINED)).toBeOnTheScreen();
  });

  test("a code chosen after Use another code cannot be approved with the earlier request", async () => {
    mockLookup.mockResolvedValueOnce(found).mockResolvedValueOnce({
      ...found,
      machineName: "laptop",
    });
    await openFound("abcd-efgh");

    fireEvent.press(button("Use another code"));
    fireEvent.changeText(input(), "wxyz-2345");
    await press("Find machine");
    await press("Approve");

    expect(screen.getByText(APPROVED)).toBeOnTheScreen();
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledWith({ code: "WXYZ2345" });
  });

  test("a lookup that settles after the screen ends changes nothing", async () => {
    const pending = deferred<unknown>();
    mockLookup.mockReturnValueOnce(pending.promise);
    setQuery(list, []);
    signInAs("sess_a");
    renderApp("/settings/connections");
    fireEvent.press(await screen.findByText("Add machine"));
    fireEvent.changeText(await screen.findByLabelText("Installer code"), "abcd-efgh");
    fireEvent.press(button("Find machine"));

    act(() => router.back());
    expect(await screen.findByText("No connected harnesses.")).toBeOnTheScreen();

    await act(async () => {
      pending.resolve(found);
    });

    expect(screen).toHavePathname("/settings/connections");
    expect(screen.queryByText("devbox-2")).not.toBeOnTheScreen();
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["loading", loading, "Loading connections"],
    ["empty", [], "No connected harnesses."],
    ["failed", new Error("Network request failed"), "Could not load your connections."],
  ])("Connections links to Add machine while its list is %s", async (_state, result, text) => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    setQuery(list, result);
    signInAs("sess_a");
    renderApp("/settings/connections");
    expect(await screen.findByText(text)).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Add machine"));

    expect(await screen.findByLabelText("Installer code")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/add-machine");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

// renderRouter installs Jest's modern fake timers and keeps them for the rest
// of the test, so these tests move the clock with them and never call
// useFakeTimers or useRealTimers themselves. Switching timer modes around the
// route tree left React Native Testing Library's cleanup hanging in the next
// test file.
describe("add machine lock window", () => {
  const MINUTE = 60_000;

  async function lockScreen() {
    mockLookup.mockResolvedValueOnce({ status: "locked" });
    await openAddMachine();
    fireEvent.changeText(input(), "abcd-efgh");
    await press("Find machine");
    expectLocked();
  }

  // req-accounts-and-connections AC-6.5
  test("entry stays disabled for 10 minutes, then returns without a call", async () => {
    await lockScreen();

    act(() => {
      jest.advanceTimersByTime(10 * MINUTE - 1000);
    });
    expectLocked();

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.queryByText(LOCKED)).not.toBeOnTheScreen();
    expect(screen.getByText(ENTRY_GUIDANCE)).toBeOnTheScreen();
    expect(input()).toHaveProp("editable", true);
    expect(button("Find machine")).toBeEnabled();
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  test("a return to the foreground rechecks the window", async () => {
    const addListener = jest.spyOn(AppState, "addEventListener");
    await lockScreen();
    const lockedAt = Date.now();
    const foreground = () =>
      act(() => {
        for (const [type, listener] of addListener.mock.calls) {
          if (type === "change") {
            (listener as (state: string) => void)("active");
          }
        }
      });

    // A suspended app runs no timers, so only the clock moves.
    jest.setSystemTime(lockedAt + 5 * MINUTE);
    foreground();
    expectLocked();

    jest.setSystemTime(lockedAt + 11 * MINUTE);
    foreground();

    expect(screen.queryByText(LOCKED)).not.toBeOnTheScreen();
    expect(input()).toHaveProp("editable", true);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
});
