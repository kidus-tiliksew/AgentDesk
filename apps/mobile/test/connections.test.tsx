import { getFunctionName } from "convex/server";
import { act, fireEvent, screen } from "expo-router/testing-library";
import { formatConnectionTime } from "../src/connections/format";
import { deferred, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens: settings/connections lists the person's
// connected harnesses and revokes one after a confirmation
// (req-accounts-and-connections REQ-4).

const list = "identity/connections:listConnections";
const revokeName = "identity/connections:revokeConnection";

// The shared convex/react fake refuses mutations it does not know. This file
// wraps its useMutation, so revokeConnection gets a local mock and every other
// mutation, such as ensureAccount, keeps the shared fake.
const mockRevokeConnection = jest.fn<Promise<null>, [{ credentialId: string }]>();

beforeEach(() => {
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
        : sharedUseMutation(reference),
    );
});

afterEach(() => {
  jest.restoreAllMocks();
});

const MINUTE = 60_000;
const FIRST = Date.UTC(2026, 9, 1, 9, 30, 0);
const USED = Date.UTC(2026, 9, 11, 13, 45, 0);

const laptop = {
  credentialId: "c_laptop",
  name: "Claude Code",
  machineName: "laptop",
  firstConnectedAt: FIRST + 5 * MINUTE,
  lastUsedAt: USED,
};
const cursor = {
  credentialId: "c_cursor",
  name: "cursor",
  firstConnectedAt: FIRST,
};

async function openConnections() {
  signInAs("sess_a");
  renderApp("/settings/connections");
}

describe("connections screen", () => {
  // req-accounts-and-connections AC-4.1
  test("shows each connection's name, machine, first connected, and last used in query order", async () => {
    setQuery(list, [laptop, cursor]);

    await openConnections();

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: list, args: {} });
    const names = screen
      .getAllByText(/^(Claude Code|cursor)$/)
      .map((element) => element.props.children);
    expect(names).toEqual(["Claude Code", "cursor"]);
    expect(screen.getByText("laptop")).toBeOnTheScreen();
    expect(
      screen.getByText(`First connected ${formatConnectionTime(laptop.firstConnectedAt)}`),
    ).toBeOnTheScreen();
    expect(screen.getByText(`Last used ${formatConnectionTime(USED)}`)).toBeOnTheScreen();
    expect(screen.getByText(`First connected ${formatConnectionTime(FIRST)}`)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Revoke Claude Code on laptop" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Revoke cursor" })).toBeOnTheScreen();
  });

  test("shows Machine unknown and Never used for absent values", async () => {
    setQuery(list, [cursor]);

    await openConnections();

    expect(await screen.findByText("Machine unknown")).toBeOnTheScreen();
    expect(screen.getByText("Never used")).toBeOnTheScreen();
    expect(screen.queryByText(/^Last used /)).not.toBeOnTheScreen();
  });

  test("shows loading until the query returns, then the list", async () => {
    setQuery(list, loading);

    await openConnections();

    expect(await screen.findByText("Loading connections")).toBeOnTheScreen();
    expect(screen.queryByText("No connected harnesses.")).not.toBeOnTheScreen();

    act(() => setQuery(list, [laptop]));

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
    expect(screen.queryByText("Loading connections")).not.toBeOnTheScreen();
  });

  test("shows an empty state when there are no connections", async () => {
    setQuery(list, []);

    await openConnections();

    expect(await screen.findByText("No connected harnesses.")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /^Revoke/ })).not.toBeOnTheScreen();
  });

  test("a failed query shows a failure with a retry, never an empty list", async () => {
    setQuery(list, new Error("Network request failed"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await openConnections();

    expect(await screen.findByText("Could not load your connections.")).toBeOnTheScreen();
    expect(screen.queryByText("No connected harnesses.")).not.toBeOnTheScreen();

    setQuery(list, [laptop]);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Claude Code")).toBeOnTheScreen();
  });

  // req-accounts-and-connections AC-4.2
  test("revokes the selected connection only after confirmation, and the row leaves with the query", async () => {
    setQuery(list, [laptop, cursor]);
    await openConnections();

    fireEvent.press(await screen.findByRole("button", { name: "Revoke Claude Code on laptop" }));

    expect(
      screen.getByText("Revoke Claude Code on laptop? Its next tool call will be refused."),
    ).toBeOnTheScreen();
    expect(mockRevokeConnection).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Revoke connection" }));
    });

    expect(mockRevokeConnection).toHaveBeenCalledTimes(1);
    expect(mockRevokeConnection).toHaveBeenCalledWith({ credentialId: "c_laptop" });
    // The screen keeps the row until the reactive query drops it.
    expect(screen.getByText("Claude Code")).toBeOnTheScreen();

    act(() => setQuery(list, [cursor]));

    expect(screen.queryByText("Claude Code")).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Revoke connection" })).not.toBeOnTheScreen();
    expect(screen.getByText("cursor")).toBeOnTheScreen();
  });

  test("a cancelled confirmation revokes nothing", async () => {
    setQuery(list, [laptop, cursor]);
    await openConnections();

    fireEvent.press(await screen.findByRole("button", { name: "Revoke cursor" }));
    expect(
      screen.getByText("Revoke cursor? Its next tool call will be refused."),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText(/Its next tool call will be refused/)).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Revoke connection" })).not.toBeOnTheScreen();
    expect(mockRevokeConnection).not.toHaveBeenCalled();
    expect(screen.getByText("cursor")).toBeOnTheScreen();
  });

  test("sends one revocation while it runs and disables the controls", async () => {
    const pending = deferred<null>();
    mockRevokeConnection.mockReturnValueOnce(pending.promise);
    setQuery(list, [laptop, cursor]);
    await openConnections();
    fireEvent.press(await screen.findByRole("button", { name: "Revoke Claude Code on laptop" }));

    const confirm = screen.getByRole("button", { name: "Revoke connection" });
    fireEvent.press(confirm);
    fireEvent.press(confirm);

    expect(mockRevokeConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Revoke connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke cursor" })).toBeDisabled();

    await act(async () => {
      pending.resolve(null);
    });

    expect(screen.getByRole("button", { name: "Revoke cursor" })).toBeEnabled();
  });

  test("a failed revocation keeps the row, shows an error, and allows another attempt", async () => {
    mockRevokeConnection.mockRejectedValueOnce(new Error("Network request failed"));
    setQuery(list, [laptop]);
    await openConnections();
    fireEvent.press(await screen.findByRole("button", { name: "Revoke Claude Code on laptop" }));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Revoke connection" }));
    });

    expect(screen.getByText("Could not revoke Claude Code. Try again.")).toBeOnTheScreen();
    expect(screen.getByText("Claude Code")).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Revoke connection" }));
    });

    expect(mockRevokeConnection).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Could not revoke Claude Code. Try again.")).not.toBeOnTheScreen();
  });
});

describe("formatConnectionTime", () => {
  test("formats to the minute without seconds", () => {
    const text = formatConnectionTime(Date.UTC(2026, 9, 11, 14, 5, 42), {
      locale: "en-US",
      timeZone: "UTC",
    });

    expect(text.replace(/\s/g, " ")).toBe("Oct 11, 2026, 2:05 PM");
  });
});
