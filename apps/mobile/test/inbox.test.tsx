import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { act, fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { AccessibilityInfo, AppState, type AppStateStatus, StyleSheet } from "react-native";
import { haptic } from "../src/haptics";
import { HOLD_MS } from "../src/inbox-undo";
import { themes } from "../src/theme";
import { agent, decision } from "./data";
import { answerDecision, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { findInbox, queryLargeTitle, renderApp } from "./render";

const listPending = "decisions/app:listPending";
const liveAgents = "agents/app:liveAgents";
const listConnections = "identity/connections:listConnections";

// The text size the window reports; the Dynamic Type tests raise it.
let mockFontScale = 1;
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({ width: 393, height: 852, scale: 3, fontScale: mockFontScale }),
}));

const laptop = { credentialId: "c_laptop", name: "Claude Code", firstConnectedAt: 0 };

// Add machine binds its code lookup as it opens; the shared fake refuses it,
// so this file gives it a local mock.
const lookupName = "identity/deviceRequests:lookupDeviceRequest";
const mockLookup = jest.fn();

beforeEach(() => {
  mockLookup.mockReset();
  const convexReact = jest.requireMock<{ useMutation: (reference: unknown) => unknown }>(
    "convex/react",
  );
  const sharedUseMutation = convexReact.useMutation;
  jest
    .spyOn(convexReact, "useMutation")
    .mockImplementation((reference: unknown) =>
      getFunctionName(reference as never) === lookupName
        ? mockLookup
        : sharedUseMutation(reference),
    );
  setQuery(listConnections, [laptop]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function decisionTitles() {
  return screen
    .queryAllByRole("button", { name: /^Decision: / })
    .map((row) => row.props.accessibilityLabel);
}

function agentNames() {
  return screen
    .queryAllByRole("button", { name: /^Agent: / })
    .map((card) => card.props.accessibilityLabel);
}

async function openInbox() {
  signInAs("sess_a");
  renderApp("/");
  await findInbox();
}

type Host = ReturnType<typeof screen.getByText>;

// The text inside an element, nested text included.
function textOf(node: Host | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function insideText(node: Host, top: Host) {
  for (let parent = node.parent; parent !== null && parent !== top; parent = parent.parent) {
    if (parent.type === "Text") {
      return true;
    }
  }
  return false;
}

// An agent row's text lines from top to bottom, each with its line limit and
// weight: the outermost texts in the column that holds the row's name.
function agentRowLines(name: string) {
  const row = screen.getByRole("button", { name: `Agent: ${name}` });
  let column = within(row).getByText(name).parent;
  while (column !== null && column.type !== "View") {
    column = column.parent;
  }
  if (column === null) {
    throw new Error(`No text column in the row of ${name}`);
  }
  const top = column;
  return top
    .findAll((node) => node.type === "Text")
    .filter((text) => !insideText(text, top))
    .map((text) => ({
      text: textOf(text),
      lines: text.props.numberOfLines,
      weight: StyleSheet.flatten(text.props.style).fontWeight,
    }));
}

describe("inbox sections", () => {
  test("lists pending decisions, then live agents, each in the order the query returns", async () => {
    // Deliberately not in any sorted order: the screen must not reorder.
    setQuery(listPending, [
      decision({ id: "d_b", title: "Second" }),
      decision({ id: "d_c", title: "Third", priority: "urgent" }),
      decision({ id: "d_a", title: "First" }),
    ]);
    setQuery(liveAgents, [
      agent({ id: "a_2", display_name: "Zed" }),
      agent({ id: "a_1", display_name: "Amy" }),
    ]);

    await openInbox();

    const rows = screen.getAllByRole("button", { name: /^(Decision|Agent): / });
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      "Decision: Second",
      "Decision: Third",
      "Decision: First",
      "Agent: Zed",
      "Agent: Amy",
    ]);
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    const headers = screen.getAllByRole("header").map((header) => header.props.children);
    expect(headers).toEqual(["Needs you", "Agents"]);
    expect(screen.getByText("2 live")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: listPending, args: {} });
    expect(queryCalls).toContainEqual({ name: liveAgents, args: {} });
  });

  test("a decision card shows one urgency pill, its title, agent and topic", async () => {
    setQuery(listPending, [
      decision({
        id: "d_1",
        title: "Ship it?",
        topic: "acme/billing",
        priority: "urgent",
        deadline: new Date(Date.now() + 4 * 60_000 + 30_000).toISOString(),
        recommendation: { kind: "approve" },
        agent_session_id: "a_1",
      }),
      decision({
        id: "d_2",
        title: "Which retry strategy?",
        topic: "beta",
        input_type: "single_choice",
        options: [
          { id: "o_1", label: "Linear" },
          { id: "o_2", label: "Exponential backoff" },
          { id: "o_3", label: "None" },
        ],
        recommendation: { kind: "option", option_id: "o_2" },
        deadline: new Date(Date.now() + 80 * 60_000 + 30_000).toISOString(),
        agent_session_id: "a_gone",
      }),
      decision({ id: "d_3", title: "Rename?", topic: "beta", deadline: null }),
      decision({ id: "d_4", title: "Hotfix?", topic: "beta", priority: "urgent" }),
    ]);
    setQuery(liveAgents, [agent({ id: "a_1", display_name: "Claude on laptop" })]);

    await openInbox();
    fireEvent.press(screen.getByRole("button", { name: "Show 1 more" }));

    const urgent = within(screen.getByRole("button", { name: "Decision: Ship it?" }));
    expect(urgent.getByText("Ship it?")).toBeOnTheScreen();
    expect(urgent.getByText("Urgent · 4m left")).toBeOnTheScreen();
    // A live agent names the decision's agent.
    expect(urgent.getByText("Claude on laptop · acme/billing")).toBeOnTheScreen();
    // The sparkles on the recommended button shows the recommendation.
    expect(urgent.queryByText(/^Recommends/)).not.toBeOnTheScreen();

    const choice = within(screen.getByRole("button", { name: "Decision: Which retry strategy?" }));
    expect(choice.getByText("1h 20m left")).toBeOnTheScreen();
    expect(choice.queryByText(/options/)).not.toBeOnTheScreen();
    expect(choice.queryByText(/Urgent/)).not.toBeOnTheScreen();
    // An agent that is not live leaves the topic alone.
    expect(choice.getByText("beta")).toBeOnTheScreen();
    // Without one-tap buttons the card names the recommendation.
    expect(choice.getByText("Recommends Exponential backoff")).toBeOnTheScreen();

    const plain = within(screen.getByRole("button", { name: "Decision: Rename?" }));
    expect(plain.queryByText(/left$|Urgent/)).not.toBeOnTheScreen();
    expect(plain.queryByText(/^Recommends/)).not.toBeOnTheScreen();

    const hotfix = within(screen.getByRole("button", { name: "Decision: Hotfix?" }));
    expect(hotfix.getByText("Urgent")).toBeOnTheScreen();
  });

  test("a decision card's VoiceOver value carries every fact, drawn or not", async () => {
    setQuery(listPending, [
      decision({
        id: "d_1",
        title: "Ship it?",
        topic: "acme/billing",
        priority: "urgent",
        deadline: new Date(Date.now() + 4 * 60_000 + 30_000).toISOString(),
        recommendation: { kind: "approve" },
        agent_session_id: "a_1",
      }),
      decision({
        id: "d_2",
        title: "Which retry strategy?",
        topic: "beta",
        input_type: "single_choice",
        options: [
          { id: "o_1", label: "Linear" },
          { id: "o_2", label: "Exponential backoff" },
        ],
        recommendation: { kind: "option", option_id: "o_2" },
      }),
    ]);
    setQuery(liveAgents, [agent({ id: "a_1", display_name: "Claude on laptop" })]);

    await openInbox();

    expect(screen.getByRole("button", { name: "Decision: Ship it?" })).toHaveAccessibilityValue({
      text: "Urgent, 4m left, Claude on laptop, Topic acme/billing, Approve or reject, Recommends Approve",
    });
    expect(
      screen.getByRole("button", { name: "Decision: Which retry strategy?" }),
    ).toHaveAccessibilityValue({
      text: "No deadline, Topic beta, Choose one of 2 options, Recommends Exponential backoff",
    });
    // The answer buttons stay separate elements.
    expect(screen.getByRole("button", { name: "Approve: Ship it?" })).toBeOnTheScreen();
  });

  test("an agent row shows its name, then its status line, then topic, state, and time", async () => {
    setQuery(liveAgents, [
      agent({
        id: "a_1",
        display_name: "Claude on laptop",
        topic: "acme/billing",
        state: "blocked",
        line: "Waiting on the migration review",
        status_at: new Date(Date.now() - 3 * 60_000).toISOString(),
        pending_decision_count: 2,
        stale: true,
      }),
      agent({ id: "a_2", display_name: "Codex", pending_decision_count: 0, stale: false }),
    ]);

    await openInbox();

    // req-mobile-app AC-2.2: display name, topic, state, status line, time
    // since the last update, pending count, and the stale marker. The name is
    // the bold title, the status line is the second line, and both stop at
    // two lines; the meta line holds topic, state, and time.
    const staleRow = screen.getByRole("button", { name: "Agent: Claude on laptop" });
    const stale = within(staleRow);
    expect(agentRowLines("Claude on laptop")).toEqual([
      { text: "Claude on laptop", lines: 2, weight: "600" },
      { text: "Waiting on the migration review", lines: 2, weight: undefined },
      { text: "acme/billing · Blocked · 3m ago · Stale", lines: undefined, weight: undefined },
    ]);
    expect(StyleSheet.flatten(stale.getByText("Stale").props.style).color).toBe(themes.light.amber);
    expect(stale.getByText("2 pending")).toBeOnTheScreen();
    expect(staleRow).toHaveAccessibilityValue({
      text: "Blocked, Waiting on the migration review, Topic acme/billing, Stale, 2 pending decisions, Updated 3m ago",
    });

    const freshRow = screen.getByRole("button", { name: "Agent: Codex" });
    const fresh = within(freshRow);
    expect(agentRowLines("Codex").map((line) => line.text)).toEqual([
      "Codex",
      "Running the test suite",
      expect.stringMatching(/^acme · Working · \d+s ago$/),
    ]);
    expect(fresh.queryByText("Stale")).not.toBeOnTheScreen();
    // No pending decisions draws no count, but VoiceOver still reads it.
    expect(fresh.queryByText(/pending/)).not.toBeOnTheScreen();
    expect(freshRow.props.accessibilityValue.text).toMatch(
      /, 0 pending decisions, Updated \d+s ago$/,
    );
  });

  test("a session with no status yet says so instead of showing activity as a status", async () => {
    setQuery(liveAgents, [
      agent({ id: "a_1", display_name: "New agent", state: null, line: null, status_at: null }),
    ]);

    await openInbox();

    // The name stays the title; the state label fills the status line and
    // stays in the meta line.
    expect(agentRowLines("New agent").map((line) => line.text)).toEqual([
      "New agent",
      "No status yet",
      "acme · No status yet · No update yet",
    ]);
    expect(screen.getByRole("button", { name: "Agent: New agent" })).toHaveAccessibilityValue({
      text: "No status yet, Topic acme, 0 pending decisions, No update yet",
    });
  });

  test("a session with a state but no line shows the state under its name", async () => {
    setQuery(liveAgents, [
      agent({ id: "a_1", display_name: "Fresh", state: "working", line: null }),
    ]);

    await openInbox();

    expect(agentRowLines("Fresh").map((line) => line.text)).toEqual([
      "Fresh",
      "Working",
      expect.stringMatching(/^acme · Working · \d+s ago$/),
    ]);
  });

  test("a long name and status line stop at two lines, and VoiceOver reads them whole", async () => {
    const name = "Context proposal UI: checklist + preview panel for the testing strategy document";
    const line = `Waiting for your call on attaching ${"the testing strategy ".repeat(8).trim()}`;
    setQuery(liveAgents, [
      agent({ id: "a_1", display_name: name, state: "waiting", line, pending_decision_count: 1 }),
    ]);

    await openInbox();

    const [title, status] = agentRowLines(name);
    expect(title).toEqual({ text: name, lines: 2, weight: "600" });
    expect(status).toEqual({ text: line, lines: 2, weight: undefined });
    const row = screen.getByRole("button", { name: `Agent: ${name}` });
    expect(row.props.accessibilityValue.text).toMatch(
      new RegExp(`^Waiting, ${line}, Topic acme, 1 pending decision, Updated \\d+s ago$`),
    );
  });

  test("an empty section says so while the other has items", async () => {
    setQuery(liveAgents, [agent({ id: "a_1", display_name: "Builder" })]);
    await openInbox();
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();

    act(() => {
      setQuery(liveAgents, []);
      setQuery(listPending, [decision({ id: "d_1", title: "Ship?" })]);
    });
    expect(screen.getByText("No live agents.")).toBeOnTheScreen();
  });

  test("shows one spinner until both queries return, not a section's empty note", async () => {
    setQuery(listPending, loading);
    setQuery(liveAgents, loading);

    await openInbox();

    expect(screen.getByLabelText("Loading inbox")).toBeOnTheScreen();
    expect(screen.queryByRole("header", { name: "Needs you" })).not.toBeOnTheScreen();
    expect(screen.queryByText("All caught up")).not.toBeOnTheScreen();

    act(() => setQuery(listPending, []));
    expect(screen.getByLabelText("Loading inbox")).toBeOnTheScreen();
    expect(screen.queryByText("No pending decisions.")).not.toBeOnTheScreen();

    act(() => setQuery(liveAgents, [agent({ id: "a_1", display_name: "Builder" })]));
    expect(screen.queryByLabelText("Loading inbox")).not.toBeOnTheScreen();
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
  });

  test("a failed query shows a failure with a retry, not an empty inbox", async () => {
    setQuery(listPending, new ConvexError({ code: "internal", message: "boom" }));
    signInAs("sess_a");
    renderApp("/");

    expect(await screen.findByText("Could not load your inbox.")).toBeOnTheScreen();
    expect(queryLargeTitle("Inbox")).toBeOnTheScreen();
    expect(screen.queryByText("All caught up")).not.toBeOnTheScreen();

    setQuery(listPending, []);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("All caught up")).toBeOnTheScreen();
  });
});

describe("empty inbox", () => {
  test("with machines connected, nothing pending and no live agent is all caught up", async () => {
    await openInbox();

    expect(screen.getByText("All caught up")).toBeOnTheScreen();
    expect(screen.queryByRole("header", { name: "Needs you" })).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "All topics" })).not.toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: listConnections, args: {} });
  });

  test("with no machine connected, it guides the first connection to Add machine", async () => {
    setQuery(listConnections, []);
    await openInbox();

    expect(screen.getByText("Connect your first machine")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Run the AgentDesk installer on the computer where your agents run. It shows a code you approve here.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("All caught up")).not.toBeOnTheScreen();

    fireEvent.press(screen.getByRole("button", { name: "Enter installer code" }));

    expect(await screen.findByLabelText("Installer code")).toBeOnTheScreen();
    expect(screen).toHavePathname("/settings/add-machine");
  });

  test("keeps the spinner while it reads the connections, not a blank screen", async () => {
    setQuery(listConnections, loading);
    await openInbox();

    expect(screen.getByLabelText("Loading inbox")).toBeOnTheScreen();
    expect(screen.queryByText("All caught up")).not.toBeOnTheScreen();

    act(() => setQuery(listConnections, [laptop]));

    expect(screen.queryByLabelText("Loading inbox")).not.toBeOnTheScreen();
    expect(screen.getByText("All caught up")).toBeOnTheScreen();
  });

  test("connecting a machine switches the guide to all caught up", async () => {
    setQuery(listConnections, []);
    await openInbox();
    expect(screen.getByText("Connect your first machine")).toBeOnTheScreen();

    act(() => setQuery(listConnections, [laptop]));

    expect(screen.getByText("All caught up")).toBeOnTheScreen();
  });

  test("a failed connections read falls back to all caught up, not a failed inbox", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    setQuery(listConnections, new Error("Network request failed"));
    await openInbox();

    expect(await screen.findByText("All caught up")).toBeOnTheScreen();
    expect(screen.queryByText("Could not load your inbox.")).not.toBeOnTheScreen();
  });

  test("reads connections only when the inbox is empty", async () => {
    setQuery(listPending, [decision({ id: "d_1" })]);
    await openInbox();

    expect(queryCalls.map((call) => call.name)).not.toContain(listConnections);
  });
});

// Apple HIG Feedback: a one-tap answer hides its card and offers Undo before
// it is sent. These tests run the real route tree on real timers and send the
// held answer by the events that send it at once; test/inbox-undo.test.tsx
// covers the hold itself with fake timers. (Fake timers inside the route tree
// leave state behind that hangs the test's cleanup.)
describe("one-tap answers", () => {
  let appStateListeners: ((state: AppStateStatus) => void)[];

  beforeEach(() => {
    jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockClear()
      .mockImplementation(() => {});
    jest.spyOn(haptic, "success").mockClear();
    jest.spyOn(haptic, "error").mockClear();
    answerDecision.mockImplementation(async ({ decisionId }) =>
      decision({ id: decisionId, state: "answered" }),
    );
    // React Native's Jest mock of AppState records listeners without calling
    // them; the tests call them as iOS would.
    appStateListeners = [];
    jest.mocked(AppState.addEventListener).mockImplementation((type, listener) => {
      if (type === "change") {
        appStateListeners.push(listener as (state: AppStateStatus) => void);
      }
      return { remove: jest.fn() } as never;
    });
  });

  function announced() {
    return jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([text]) => text);
  }

  // The app leaves the foreground, which sends a held answer at once.
  function background() {
    return act(async () => {
      for (const listener of appStateListeners) listener("background");
    });
  }

  test("Approve hides the card and offers Undo instead of sending at once", async () => {
    setQuery(listPending, [
      decision({ id: "d_1", title: "Ship it?", recommendation: { kind: "approve" } }),
    ]);
    await openInbox();

    const approve = screen.getByRole("button", { name: "Approve: Ship it?" });
    // The recommended choice is marked (req-mobile-app AC-3.3).
    expect(approve.props.accessibilityHint).toBe("Recommended by the agent");
    expect(
      screen.getByRole("button", { name: "Reject: Ship it?" }).props.accessibilityHint,
    ).toBeUndefined();

    fireEvent.press(approve);

    expect(decisionTitles()).toEqual([]);
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
    expect(screen.getByText("Approved “Ship it?”")).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();

    await background();

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.queryByText("Approved “Ship it?”")).not.toBeOnTheScreen();
    expect(haptic.success).toHaveBeenCalledTimes(1);
    // The answer settles the decision; the reactive list drops it.
    act(() => setQuery(listPending, []));
    expect(decisionTitles()).toEqual([]);
  });

  test("the Undo banner is read out and its button is reachable", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Reject: Ship it?" }));

    expect(announced()).toContain("Rejected “Ship it?”. Undo available.");
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.props.accessibilityHint).toBe("Puts “Ship it?” back without answering it");
    expect(screen.getByTestId("undo-banner").props.accessibilityLiveRegion).toBe("polite");
    // Apple HIG Buttons: at least 44 pt tall.
    expect(StyleSheet.flatten(undo.props.style).minHeight).toBeGreaterThanOrEqual(44);
  });

  test("Undo restores the card and nothing is sent", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Reject: Ship it?" }));
    fireEvent.press(screen.getByRole("button", { name: "Undo" }));

    expect(decisionTitles()).toEqual(["Decision: Ship it?"]);
    expect(screen.queryByText("Rejected “Ship it?”")).not.toBeOnTheScreen();
    expect(announced()).toContain("Undone. “Ship it?” is back.");
    await background();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("leaving the screen sends the held answer at once", async () => {
    setQuery(listPending, [
      decision({ id: "d_1", title: "Ship it?" }),
      decision({ id: "d_2", title: "Notes?", input_type: "free_text" }),
    ]);
    setQuery("decisions/app:get", (args: { decisionId: string }) =>
      decision({ id: args.decisionId, title: "Notes?", input_type: "free_text" }),
    );
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    fireEvent.press(screen.getByRole("button", { name: "Decision: Notes?" }));

    await waitFor(() => expect(screen).toHavePathname("/decision/d_2"));
    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "approve" } });
  });

  test("answering another card sends the held answer first", async () => {
    setQuery(listPending, [
      decision({ id: "d_1", title: "Ship it?" }),
      decision({ id: "d_2", title: "Rename?" }),
    ]);
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Reject: Rename?" })));

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.getByText("Rejected “Rename?”")).toBeOnTheScreen();
    expect(decisionTitles()).toEqual([]);

    await background();
    expect(answerDecision).toHaveBeenLastCalledWith({
      decisionId: "d_2",
      answer: { kind: "reject" },
    });
  });

  test("a deadline within the hold sends at once, without Undo", async () => {
    setQuery(listPending, [
      decision({
        id: "d_1",
        title: "Ship it?",
        deadline: new Date(Date.now() + HOLD_MS - 500).toISOString(),
      }),
    ]);
    await openInbox();

    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" })),
    );

    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeOnTheScreen();
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });

  test("a decision settled elsewhere opens its decision screen with the recorded outcome", async () => {
    const settled = decision({
      id: "d_1",
      title: "Ship it?",
      state: "answered",
      answer: { kind: "reject" },
      answered_at: "2026-10-12T10:00:00.000Z",
      answered_via: "notification",
    });
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    setQuery("decisions/app:get", settled);
    answerDecision.mockRejectedValue(
      new ConvexError({ code: "conflict", message: "Decision already settled", decision: settled }),
    );
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    await background();

    await waitFor(() => expect(screen).toHavePathname("/decision/d_1"));
    // The decision screen reads the settled decision and offers no answer.
    expect(queryCalls).toContainEqual({ name: "decisions/app:get", args: { decisionId: "d_1" } });
    expect(screen.queryByRole("button", { name: "Submit answer" })).not.toBeOnTheScreen();
  });

  test("a decision answered in chat first opens its decision screen with the chat answer", async () => {
    const settled = decision({
      id: "d_1",
      title: "Ship it?",
      state: "answered",
      answer: { kind: "reject" },
      answered_at: "2026-10-12T10:00:00.000Z",
      answered_via: "chat",
      chat_message: "Not yet, *wait* for QA",
      relayed_by_agent_session_id: "s_relay",
    });
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    setQuery("decisions/app:get", settled);
    answerDecision.mockRejectedValue(
      new ConvexError({ code: "conflict", message: "Decision already settled", decision: settled }),
    );
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    await background();

    await waitFor(() => expect(screen).toHavePathname("/decision/d_1"));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(0));
    // The stored chat answer, not the attempted Approve, is the outcome.
    expect(
      screen.getByRole("header", { name: /^Rejected\. Answered in chat, / }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText("Your message in chat: Not yet, *wait* for QA")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  test("any other failure restores the card with the message and allows a retry", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    answerDecision.mockRejectedValueOnce(new Error("Network request failed"));
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    await background();

    const message = "Could not send your answer. Check your connection.";
    expect(screen.getByText(message)).toBeOnTheScreen();
    expect(decisionTitles()).toEqual(["Decision: Ship it?"]);
    expect(screen).toHavePathname("/");
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(announced()).toContain(message);

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    expect(screen.queryByText(message)).not.toBeOnTheScreen();
    await background();
    expect(answerDecision).toHaveBeenCalledTimes(2);
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });

  test("a refusal restores the card with fixed copy for its code, never the backend's message", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    answerDecision.mockRejectedValueOnce(
      new ConvexError({ code: "unauthenticated", message: "Not signed in" }),
    );
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    await background();

    const message = "Your session ended. Sign in again.";
    expect(screen.getByText(message)).toBeOnTheScreen();
    expect(decisionTitles()).toEqual(["Decision: Ship it?"]);
    expect(announced()).toContain(message);
    expect(screen.queryByText("Not signed in")).not.toBeOnTheScreen();
    expect(announced()).not.toContain("Not signed in");
  });

  test("a second tap before the re-render sends one answer", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    await openInbox();

    const approve = screen.getByRole("button", { name: "Approve: Ship it?" });
    const reject = screen.getByRole("button", { name: "Reject: Ship it?" });
    act(() => {
      fireEvent.press(approve);
      fireEvent.press(approve);
      fireEvent.press(reject);
    });
    await background();

    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  test("without a recommendation neither button is marked and both are secondary", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    await openInbox();

    for (const name of ["Approve: Ship it?", "Reject: Ship it?"]) {
      const button = screen.getByRole("button", { name });
      expect(button.props.accessibilityHint).toBeUndefined();
      expect(StyleSheet.flatten(button.props.style).backgroundColor).toBe(themes.light.fill);
    }
    expect(screen.queryByText(/^Recommends/)).not.toBeOnTheScreen();
  });

  test("a recommended Reject is the filled button", async () => {
    setQuery(listPending, [
      decision({ id: "d_1", title: "Ship it?", recommendation: { kind: "reject" } }),
    ]);
    await openInbox();

    const reject = screen.getByRole("button", { name: "Reject: Ship it?" });
    const approve = screen.getByRole("button", { name: "Approve: Ship it?" });
    expect(reject.props.accessibilityHint).toBe("Recommended by the agent");
    expect(StyleSheet.flatten(reject.props.style).backgroundColor).toBe(themes.light.accentFill);
    expect(StyleSheet.flatten(approve.props.style).backgroundColor).toBe(themes.light.fill);
  });

  test("other input types have no one-tap answer", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Notes?", input_type: "free_text" })]);
    await openInbox();

    expect(screen.getByRole("button", { name: "Decision: Notes?" })).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /^(Approve|Reject): / })).not.toBeOnTheScreen();
  });
});

describe("Dynamic Type", () => {
  afterEach(() => {
    mockFontScale = 1;
  });

  // The view that lays out the card's two buttons.
  function actions() {
    let node = screen.getByRole("button", { name: "Approve: Ship it?" }).parent;
    while (node !== null && typeof node.type !== "string") {
      node = node.parent;
    }
    return StyleSheet.flatten(node?.props.style);
  }

  test("Reject and Approve sit side by side at regular sizes", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    await openInbox();

    expect(actions().flexDirection).toBe("row");
  });

  test("Reject and Approve stack at large text sizes", async () => {
    mockFontScale = 1.5;
    setQuery(listPending, [decision({ id: "d_1", title: "Ship it?" })]);
    await openInbox();

    expect(actions().flexDirection).toBe("column");
  });
});

describe("show more", () => {
  test("shows the first three decisions and reveals the rest on request", async () => {
    setQuery(
      listPending,
      ["One", "Two", "Three", "Four", "Five"].map((title, index) =>
        decision({ id: `d_${index}`, title }),
      ),
    );
    await openInbox();

    expect(decisionTitles()).toEqual(["Decision: One", "Decision: Two", "Decision: Three"]);

    fireEvent.press(screen.getByRole("button", { name: "Show 2 more" }));

    expect(decisionTitles()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).not.toBeOnTheScreen();
  });
});

describe("reactive updates", () => {
  test("re-renders when a decision is created, settled, or cancelled", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Old" })]);
    await openInbox();
    expect(decisionTitles()).toEqual(["Decision: Old"]);

    act(() =>
      setQuery(listPending, [
        decision({ id: "d_2", title: "New urgent", priority: "urgent" }),
        decision({ id: "d_1", title: "Old" }),
      ]),
    );
    expect(decisionTitles()).toEqual(["Decision: New urgent", "Decision: Old"]);

    // Settling or cancelling removes the decision from the pending query.
    act(() =>
      setQuery(listPending, [decision({ id: "d_2", title: "New urgent", priority: "urgent" })]),
    );
    expect(decisionTitles()).toEqual(["Decision: New urgent"]);

    act(() => setQuery(listPending, []));
    expect(screen.getByText("All caught up")).toBeOnTheScreen();
  });

  test("a decision answered in chat leaves the inbox when the query drops it", async () => {
    setQuery(listPending, [
      decision({ id: "d_1", title: "Relayed", interactive: true }),
      decision({ id: "d_2", title: "Still open" }),
    ]);
    await openInbox();
    expect(decisionTitles()).toEqual(["Decision: Relayed", "Decision: Still open"]);

    act(() => setQuery(listPending, [decision({ id: "d_2", title: "Still open" })]));

    expect(decisionTitles()).toEqual(["Decision: Still open"]);
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("re-renders when an agent's status changes or it leaves the live set", async () => {
    setQuery(liveAgents, [agent({ id: "a_1", display_name: "Builder", line: "Compiling" })]);
    await openInbox();
    expect(agentRowLines("Builder").map((line) => line.text)).toEqual([
      "Builder",
      "Compiling",
      expect.stringMatching(/^acme · Working · \d+s ago$/),
    ]);

    act(() =>
      setQuery(liveAgents, [
        agent({
          id: "a_1",
          display_name: "Builder",
          state: "waiting",
          line: "Needs a decision",
          stale: true,
        }),
      ]),
    );
    expect(screen.queryByText("Compiling")).not.toBeOnTheScreen();
    // The name stays the title while the status line under it changes.
    expect(agentRowLines("Builder").map((line) => line.text)).toEqual([
      "Builder",
      "Needs a decision",
      expect.stringMatching(/^acme · Waiting · \d+s ago · Stale$/),
    ]);
    expect(screen.getByText("Stale")).toBeOnTheScreen();

    act(() => setQuery(liveAgents, []));
    expect(agentNames()).toEqual([]);
    expect(screen.getByText("All caught up")).toBeOnTheScreen();
  });
});

describe("topic filter", () => {
  beforeEach(() => {
    setQuery(listPending, [
      decision({ id: "d_1", title: "Root", topic: "acme" }),
      decision({ id: "d_2", title: "Billing", topic: "acme/billing" }),
      decision({ id: "d_3", title: "Corp", topic: "acmecorp" }),
    ]);
    setQuery(liveAgents, [
      agent({ id: "a_1", display_name: "Root agent", topic: "acme" }),
      agent({ id: "a_2", display_name: "Billing agent", topic: "acme/billing/invoices" }),
      agent({ id: "a_3", display_name: "Corp agent", topic: "acmecorp" }),
    ]);
  });

  function chipLabels() {
    return screen
      .getAllByRole("button", { name: /^(All topics|Topic: .+)$/ })
      .map((chip) => chip.props.accessibilityLabel);
  }

  test("offers All topics, then each topic and parent prefix from both sections", async () => {
    await openInbox();

    expect(chipLabels()).toEqual([
      "All topics",
      "Topic: acme",
      "Topic: acme/billing",
      "Topic: acme/billing/invoices",
      "Topic: acmecorp",
    ]);
    expect(screen.getByRole("button", { name: "All topics" })).toBeSelected();
  });

  test("offers no filter when everything shares one topic", async () => {
    setQuery(listPending, [decision({ id: "d_1", title: "Root", topic: "acme/billing" })]);
    setQuery(liveAgents, [agent({ id: "a_1", display_name: "Root agent", topic: "acme/billing" })]);

    await openInbox();

    expect(screen.queryByRole("button", { name: "All topics" })).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /^Topic: / })).not.toBeOnTheScreen();
  });

  test("chip acme keeps acme and its subtopics and drops acmecorp in both sections", async () => {
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Topic: acme" }));

    expect(screen.getByRole("button", { name: "Topic: acme" })).toBeSelected();
    expect(screen.getByRole("button", { name: "All topics" })).not.toBeSelected();
    expect(decisionTitles()).toEqual(["Decision: Root", "Decision: Billing"]);
    expect(agentNames()).toEqual(["Agent: Root agent", "Agent: Billing agent"]);
  });

  test("a deeper chip narrows both sections, and All topics restores them", async () => {
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Topic: acme/billing" }));
    expect(decisionTitles()).toEqual(["Decision: Billing"]);
    expect(agentNames()).toEqual(["Agent: Billing agent"]);

    fireEvent.press(screen.getByRole("button", { name: "Topic: acmecorp" }));
    expect(decisionTitles()).toEqual(["Decision: Corp"]);
    expect(agentNames()).toEqual(["Agent: Corp agent"]);

    fireEvent.press(screen.getByRole("button", { name: "All topics" }));
    expect(decisionTitles()).toHaveLength(3);
    expect(agentNames()).toHaveLength(3);
  });

  test("names the topic in a filtered section's empty state", async () => {
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Topic: acme/billing/invoices" }));

    expect(screen.getByText("No pending decisions in acme/billing/invoices.")).toBeOnTheScreen();
    expect(agentNames()).toEqual(["Agent: Billing agent"]);
  });

  test("the filter applies to reactive updates", async () => {
    await openInbox();
    fireEvent.press(screen.getByRole("button", { name: "Topic: acme" }));

    act(() =>
      setQuery(listPending, [
        decision({ id: "d_4", title: "Late corp", topic: "acmecorp" }),
        decision({ id: "d_5", title: "Late billing", topic: "acme/billing" }),
      ]),
    );

    expect(decisionTitles()).toEqual(["Decision: Late billing"]);
  });

  test("a selected topic that leaves both sections resets to All topics", async () => {
    await openInbox();
    fireEvent.press(screen.getByRole("button", { name: "Topic: acmecorp" }));

    act(() => {
      setQuery(listPending, [
        decision({ id: "d_1", title: "Root", topic: "acme" }),
        decision({ id: "d_2", title: "Billing", topic: "acme/billing" }),
      ]);
      setQuery(liveAgents, [agent({ id: "a_1", display_name: "Root agent", topic: "acme" })]);
    });

    expect(screen.queryByRole("button", { name: "Topic: acmecorp" })).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "All topics" })).toBeSelected();
    expect(decisionTitles()).toEqual(["Decision: Root", "Decision: Billing"]);
    expect(agentNames()).toEqual(["Agent: Root agent"]);
  });
});

describe("navigation", () => {
  test("a decision card opens its decision screen", async () => {
    setQuery(listPending, [decision({ id: "d_42", title: "Deploy?" })]);
    setQuery("decisions/app:get", (args: { decisionId: string }) =>
      decision({ id: args.decisionId, title: "Deploy?", body: "Ship the **release** today." }),
    );
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Decision: Deploy?" }));

    expect(await screen.findByText("release")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_42");
    expect(queryCalls).toContainEqual({ name: "decisions/app:get", args: { decisionId: "d_42" } });
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("an agent row opens its agent screen", async () => {
    setQuery(liveAgents, [agent({ id: "a_7", display_name: "Reviewer" })]);
    setQuery("agents/app:get", (args: { agentSessionId: string }) => ({
      ...agent({ id: args.agentSessionId, display_name: "Reviewer", line: "Reading the diff" }),
      history: [],
      pending_decisions: [],
    }));
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Agent: Reviewer" }));

    expect(await screen.findByText("No earlier statuses.")).toBeOnTheScreen();
    expect(screen).toHavePathname("/agent/a_7");
    expect(queryCalls).toContainEqual({ name: "agents/app:get", args: { agentSessionId: "a_7" } });
  });
});

// Real timers: fake timers inside the route tree leave state behind that
// hangs the next test file in the same worker. screen-clock.test.tsx covers
// focus, background, and cleanup with fake timers on the hook alone.
describe("elapsed time", () => {
  test("the time since the last update advances while the inbox is open", async () => {
    setQuery(liveAgents, [
      agent({
        id: "a_1",
        display_name: "Builder",
        status_at: new Date(Date.now() - 58_500).toISOString(),
      }),
    ]);

    await openInbox();
    expect(screen.getByText(/^acme · Working · 5[89]s ago$/)).toBeOnTheScreen();

    expect(
      await screen.findByText("acme · Working · 1m ago", {}, { timeout: 3_000 }),
    ).toBeOnTheScreen();
  });
});
