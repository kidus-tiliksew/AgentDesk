import type { Decision } from "@agentdesk/contract";
import { ConvexError } from "convex/values";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import { AccessibilityInfo, Dimensions, ScrollView, TextInput } from "react-native";
import { haptic } from "../src/haptics";
import { themes } from "../src/theme";
import { agent, decision } from "./data";
import { answerDecision, deferred, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens, decision/[id] (req-mobile-app REQ-3).

jest.mock("../src/haptics", () => ({
  haptic: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), selection: jest.fn() },
}));

const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);

// Apple HIG Buttons: text links reach 44 pt through their hit slop.
const LINK_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };
// The agent and parent links are 13 pt text, so they take a taller slop.
const SMALL_LINK_HIT_SLOP = { top: 16, bottom: 16, left: 8, right: 8 };

beforeEach(() => {
  announce.mockClear();
  for (const fn of Object.values(haptic)) {
    jest.mocked(fn).mockClear();
  }
});

// The settled outcome banner: one header element whose label reads it all.
function banner(title: string) {
  return screen.getByRole("header", { name: new RegExp(`^${title}(\\.|$)`) });
}

const get = "decisions/app:get";
const agentGet = "agents/app:get";

const choices = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

// Scripts decisions/app:get to return each decision by id.
function serve(...items: Decision[]) {
  setQuery(get, (args: { decisionId: string }) => {
    const found = items.find((item) => item.id === args.decisionId);
    if (found === undefined) {
      return new ConvexError({ code: "not_found", message: "Decision not found" });
    }
    return found;
  });
}

function openDecision(id = "d_1") {
  signInAs("sess_a");
  renderApp(`/decision/${id}`);
}

async function open(item: Decision) {
  serve(item);
  openDecision(item.id);
  await screen.findByText(item.title);
}

// Sends the draft of a choice or text decision.
function submit() {
  fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
}

// Approve and Reject each send at once.
function choose(name: "Approve" | "Reject") {
  fireEvent.press(screen.getByRole("button", { name }));
}

// The note sits behind "Add note" in the dock.
function addNote(text: string) {
  fireEvent.press(screen.getByRole("button", { name: "Add note" }));
  fireEvent.changeText(screen.getByLabelText("Note"), text);
}

// Lets a resolved or rejected mutation promise settle and re-render.
async function flush() {
  await act(async () => {});
}

function lastAnswer() {
  return answerDecision.mock.calls.at(-1)?.[0];
}

// The clock time the settled banner shows for `iso`.
function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function answered(overrides: Partial<Decision> & Pick<Decision, "id">): Decision {
  return decision({
    state: "answered",
    answer: { kind: "approve" },
    answered_at: "2026-10-11T10:00:00.000Z",
    answered_via: "app",
    ...overrides,
  });
}

function expectNoControls() {
  expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Reject" })).not.toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Add note" })).not.toBeOnTheScreen();
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
}

describe("display", () => {
  test("VoiceOver hears the priority even when only urgency is drawn (AC-3.1)", async () => {
    serve(decision({ id: "d_normal", title: "Normal one", priority: "normal" }));
    openDecision("d_normal");
    const normal = await screen.findByRole("header", { name: "Normal one" });
    expect(normal.props.accessibilityValue).toEqual({ text: "Normal priority" });
    expect(screen.queryByText("Urgent")).not.toBeOnTheScreen();
  });

  test("renders the body as Markdown with every field of AC-3.1", async () => {
    const deadline = new Date(Date.now() + 2 * 3_600_000 + 5 * 60_000 + 30_000).toISOString();
    setQuery(agentGet, (args: { agentSessionId: string }) => ({
      ...agent({ id: args.agentSessionId, display_name: "Claude on laptop" }),
      history: [],
      pending_decisions: [],
    }));
    const item = decision({
      id: "d_1",
      title: "Pick a plan",
      body: "## Context\n\nThe **refund** flow needs a choice.\n\n- keep old\n- add new",
      input_type: "single_choice",
      options: choices,
      recommendation: { kind: "option", option_id: "b" },
      default: { kind: "option", option_id: "a" },
      deadline,
      priority: "urgent",
      topic: "acme/billing",
      agent_session_id: "a_1",
      parent_id: "d_parent",
      follow_up_ids: ["d_f1", "d_f2"],
      created_at: new Date(Date.now() - 3 * 60_000 - 10_000).toISOString(),
    });
    serve(item, decision({ id: "d_parent", title: "Parent question" }));
    openDecision("d_1");
    await screen.findByText("Pick a plan");

    expect(queryCalls).toContainEqual({ name: get, args: { decisionId: "d_1" } });
    expect(screen.getByRole("header", { name: "Pick a plan" })).toBeOnTheScreen();
    // Markdown: a heading, bold text, and list items render as their own
    // text nodes, not as the raw source.
    expect(screen.getByText("Context")).toBeOnTheScreen();
    expect(screen.getByText("refund")).toBeOnTheScreen();
    expect(screen.getByText("keep old")).toBeOnTheScreen();
    expect(screen.queryByText(/\*\*refund\*\*/)).not.toBeOnTheScreen();

    // The recommendation: in the dock and on its option.
    expect(screen.getByText("Recommended: Beta")).toBeOnTheScreen();
    expect(
      within(screen.getByRole("radio", { name: "Beta" })).getByText("Recommended"),
    ).toBeOnTheScreen();
    // The deadline: a live countdown pill that names the due time.
    expect(screen.getByText(/^2h 5m left$/)).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`Deadline ${new Date(deadline).toLocaleString()}, 2h 5m left`),
    ).toBeOnTheScreen();
    expect(screen.getByText("Default: Alpha")).toBeOnTheScreen();
    expect(screen.getByText("Urgent")).toBeOnTheScreen();
    expect(screen.getByText("acme/billing")).toBeOnTheScreen();
    expect(screen.getByText("· 3m ago")).toBeOnTheScreen();
    expect(await screen.findByRole("link", { name: "Agent: Claude on laptop" })).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Follow-up to Parent question" })).toBeOnTheScreen();
    // Unreadable follow-ups stay reachable by position.
    expect(screen.getByRole("link", { name: "Follow-up decision 1" })).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Follow-up decision 2" })).toBeOnTheScreen();
  });

  test("names absent values instead of leaving them blank", async () => {
    await open(decision({ id: "d_1", title: "Bare" }));

    expect(screen.getByText("No recommendation")).toBeOnTheScreen();
    expect(screen.getByText("No deadline")).toBeOnTheScreen();
    expect(screen.getByText("No default")).toBeOnTheScreen();
    // A normal priority has no pill; only Urgent is marked.
    expect(screen.queryByText("Urgent")).not.toBeOnTheScreen();
    expect(screen.queryByRole("link", { name: /^Follow-up to/ })).not.toBeOnTheScreen();
    expect(screen.queryByRole("link", { name: /^Follow-up/ })).not.toBeOnTheScreen();
  });

  test("a passed deadline reads as passed while the decision is still pending", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Late",
        deadline: new Date(Date.now() - 1_000).toISOString(),
      }),
    );

    expect(screen.getByText("Deadline passed")).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Deadline passed, /)).toBeOnTheScreen();
    // Only the backend expires a decision, so the controls stay.
    expect(screen.getByRole("button", { name: "Approve" })).toBeOnTheScreen();
  });

  test("shows loading until the query returns", async () => {
    setQuery(get, loading);
    signInAs("sess_a");
    renderApp("/decision/d_1");

    expect(await screen.findByText("Loading decision")).toBeOnTheScreen();
  });

  test("re-renders when the decision changes", async () => {
    await open(decision({ id: "d_1", title: "Old title" }));

    act(() => serve(decision({ id: "d_1", title: "New title", priority: "urgent" })));

    expect(screen.getByText("New title")).toBeOnTheScreen();
    expect(screen.getByText("Urgent")).toBeOnTheScreen();
  });
});

// renderRouter installs Jest's fake timers, and findByText advances them
// while it polls, so the screen clock ticks without a real wait.
// screen-clock.test.tsx covers the clock's focus and background behavior.
describe("deadline countdown", () => {
  test("counts down while the screen is open", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Soon",
        deadline: new Date(Date.now() + 3_500).toISOString(),
      }),
    );
    expect(screen.getByText(/^[23]s left$/)).toBeOnTheScreen();

    expect(await screen.findByText("1s left", {}, { timeout: 3_000 })).toBeOnTheScreen();
  });

  test("the countdown turns red under five minutes and stays neutral before", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Later",
        deadline: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      }),
    );
    expect(screen.getByText(/left$/)).toHaveStyle({ color: themes.light.pillNeutral });

    act(() =>
      serve(
        decision({
          id: "d_1",
          title: "Later",
          deadline: new Date(Date.now() + 4 * 60_000).toISOString(),
        }),
      ),
    );

    expect(screen.getByText(/left$/)).toHaveStyle({ color: themes.light.red });
  });

  test("an urgent decision's countdown is red however far the deadline", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Urgent later",
        priority: "urgent",
        deadline: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      }),
    );

    expect(screen.getByText(/left$/)).toHaveStyle({ color: themes.light.red });
  });
});

describe("agent", () => {
  const detail = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...agent({ id, display_name: "Reviewer" }),
    history: [],
    pending_decisions: [],
    ...overrides,
  });

  test("the agent link opens the agent screen", async () => {
    setQuery(agentGet, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    await open(decision({ id: "d_1", title: "Ask", agent_session_id: "a_7" }));

    fireEvent.press(await screen.findByRole("link", { name: "Agent: Reviewer" }));

    expect(await screen.findByText("No earlier statuses.")).toBeOnTheScreen();
    expect(screen).toHavePathname("/agent/a_7");
    expect(queryCalls).toContainEqual({ name: agentGet, args: { agentSessionId: "a_7" } });
  });

  test("the agent's state is written after its name, not shown by the dot alone", async () => {
    setQuery(agentGet, (args: { agentSessionId: string }) =>
      detail(args.agentSessionId, { state: "blocked" }),
    );
    await open(decision({ id: "d_1", title: "Ask", agent_session_id: "a_7" }));

    const link = await screen.findByRole("link", { name: "Agent: Reviewer" });
    expect(link.props.hitSlop).toEqual(SMALL_LINK_HIT_SLOP);
    expect(screen.getByText("· Blocked")).toHaveStyle({ color: themes.light.amber });

    act(() =>
      setQuery(agentGet, (args: { agentSessionId: string }) =>
        detail(args.agentSessionId, { state: "blocked", stale: true }),
      ),
    );
    expect(screen.getByText("· Stale")).toHaveStyle({ color: themes.light.amber });

    act(() =>
      setQuery(agentGet, (args: { agentSessionId: string }) =>
        detail(args.agentSessionId, { state: "working" }),
      ),
    );
    expect(screen.getByText("· Working")).toHaveStyle({ color: themes.light.textSecondary });
  });

  test("an ended session is labelled ended", async () => {
    setQuery(agentGet, (args: { agentSessionId: string }) =>
      detail(args.agentSessionId, { ended_at: "2026-10-11T08:00:00.000Z", state: "done" }),
    );
    await open(decision({ id: "d_1", title: "Ask", agent_session_id: "a_7" }));

    expect(await screen.findByRole("link", { name: "Agent: Reviewer (ended)" })).toBeOnTheScreen();
  });

  test("a purged session shows the agent as ended and the decision stays answerable", async () => {
    setQuery(agentGet, new ConvexError({ code: "not_found", message: "Agent session not found" }));
    answerDecision.mockResolvedValue(answered({ id: "d_1", title: "Ask" }));
    await open(decision({ id: "d_1", title: "Ask", agent_session_id: "a_purged" }));

    expect(await screen.findByText("Agent session ended")).toBeOnTheScreen();
    expect(screen.queryByRole("link", { name: /^Agent: / })).not.toBeOnTheScreen();

    choose("Approve");
    await flush();

    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.getByText("Approved")).toBeOnTheScreen();
  });

  test("a decision with no agent session shows the agent as ended", async () => {
    await open(decision({ id: "d_1", title: "Ask", agent_session_id: null }));

    expect(screen.getByText("Agent session ended")).toBeOnTheScreen();
    expect(queryCalls.some((call) => call.name === agentGet)).toBe(false);
  });

  test("another agent lookup failure offers a retry without hiding the decision", async () => {
    setQuery(agentGet, new Error("Network request failed"));
    await open(decision({ id: "d_1", title: "Ask", agent_session_id: "a_7" }));

    expect(await screen.findByText("Could not load the agent.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Approve" })).toBeOnTheScreen();

    setQuery(agentGet, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    const retry = screen.getByRole("button", { name: "Retry agent" });
    expect(retry.props.hitSlop).toEqual(SMALL_LINK_HIT_SLOP);
    fireEvent.press(retry);

    expect(await screen.findByRole("link", { name: "Agent: Reviewer" })).toBeOnTheScreen();
  });
});

describe("related decisions", () => {
  const parent = decision({ id: "d_parent", title: "Parent question", follow_up_ids: ["d_1"] });
  const child = decision({
    id: "d_1",
    title: "Child question",
    parent_id: "d_parent",
    follow_up_ids: ["d_f1", "d_f2"],
  });
  const first = decision({ id: "d_f1", title: "First follow-up", parent_id: "d_1" });
  const second = answered({
    id: "d_f2",
    title: "Second follow-up",
    parent_id: "d_1",
    answer: { kind: "reject" },
  });

  test("the parent link names the parent and opens it", async () => {
    serve(parent, child, first, second);
    openDecision("d_1");
    await screen.findByText("Child question");

    fireEvent.press(await screen.findByRole("link", { name: "Follow-up to Parent question" }));

    expect(await screen.findByRole("header", { name: "Parent question" })).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_parent");
  });

  test("each follow-up reads as a thread row with its state and opens its decision", async () => {
    serve(parent, child, first, second);
    openDecision("d_1");
    await screen.findByText("Child question");

    expect(
      await screen.findByRole("link", { name: "Follow-up: First follow-up, Pending" }),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("link", { name: "Follow-up: Second follow-up, Rejected" }));

    expect(await screen.findByRole("header", { name: "Second follow-up" })).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_f2");
    expect(queryCalls).toContainEqual({ name: get, args: { decisionId: "d_f2" } });
  });

  test("another decision opens with its own draft, not the previous one's", async () => {
    serve(
      decision({
        id: "d_1",
        title: "Child question",
        input_type: "single_choice",
        options: choices,
        follow_up_ids: ["d_f1"],
      }),
      decision({
        id: "d_f1",
        title: "First follow-up",
        input_type: "single_choice",
        options: choices,
        parent_id: "d_1",
      }),
    );
    openDecision("d_1");
    await screen.findByText("Child question");
    fireEvent.press(screen.getByRole("radio", { name: "Gamma" }));
    addNote("Draft note");

    fireEvent.press(
      await screen.findByRole("link", { name: "Follow-up: First follow-up, Pending" }),
    );
    await screen.findByRole("header", { name: "First follow-up" });

    for (const name of ["Alpha", "Beta", "Gamma"]) {
      expect(screen.getByRole("radio", { name })).not.toBeChecked();
    }
    expect(screen.queryByLabelText("Note")).not.toBeOnTheScreen();
    fireEvent.press(screen.getByRole("button", { name: "Add note" }));
    expect(screen.getByLabelText("Note")).toHaveDisplayValue("");
  });
});

describe("removed decisions", () => {
  const child = decision({ id: "d_1", title: "Child question", parent_id: "d_parent" });

  // component-decisions §Removal: a follow-up keeps its parent's id.
  test("a follow-up whose parent was removed shows the parent as unavailable and stays answerable", async () => {
    answerDecision.mockResolvedValue(answered({ id: "d_1", title: "Child question" }));
    serve(child);
    openDecision("d_1");

    expect(await screen.findByText("Parent decision unavailable")).toBeOnTheScreen();
    expect(screen.queryByRole("link", { name: /^Follow-up to/ })).not.toBeOnTheScreen();
    expect(screen.getByText("Child question")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: get, args: { decisionId: "d_parent" } });

    choose("Approve");
    await flush();

    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.getByText("Approved")).toBeOnTheScreen();
  });

  test("a malformed parent id shows the parent as unavailable", async () => {
    setQuery(get, (args: { decisionId: string }) =>
      args.decisionId === "d_1"
        ? child
        : new ConvexError({ code: "invalid", message: "Invalid id", field: "decisionId" }),
    );
    openDecision("d_1");

    expect(await screen.findByText("Parent decision unavailable")).toBeOnTheScreen();
  });

  test("the parent shows loading until its query returns", async () => {
    let parentReady = false;
    setQuery(get, (args: { decisionId: string }) =>
      args.decisionId === "d_1"
        ? child
        : parentReady
          ? decision({ id: "d_parent", title: "Parent question" })
          : loading,
    );
    openDecision("d_1");

    expect(await screen.findByText("Loading parent")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Approve" })).toBeOnTheScreen();

    parentReady = true;
    act(() => serve(child, decision({ id: "d_parent", title: "Parent question" })));

    expect(screen.getByRole("link", { name: "Follow-up to Parent question" })).toBeOnTheScreen();
    expect(screen.queryByText("Loading parent")).not.toBeOnTheScreen();
  });

  test("another parent lookup failure offers a retry without hiding the decision", async () => {
    setQuery(get, (args: { decisionId: string }) =>
      args.decisionId === "d_1" ? child : new Error("Network request failed"),
    );
    openDecision("d_1");

    expect(await screen.findByText("Could not load the parent decision.")).toBeOnTheScreen();
    expect(screen.getByText("Child question")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Approve" })).toBeOnTheScreen();

    serve(child, decision({ id: "d_parent", title: "Parent question" }));
    const retry = screen.getByRole("button", { name: "Retry parent" });
    expect(retry.props.hitSlop).toEqual(SMALL_LINK_HIT_SLOP);
    fireEvent.press(retry);

    expect(
      await screen.findByRole("link", { name: "Follow-up to Parent question" }),
    ).toBeOnTheScreen();
  });

  test("a decision removed while open shows the not-found state", async () => {
    await open(decision({ id: "d_1", title: "Soon gone" }));

    act(() => serve());

    expect(await screen.findByText("Decision not found")).toBeOnTheScreen();
    expect(screen.queryByText("Soon gone")).not.toBeOnTheScreen();
  });
});

describe("not found and failures", () => {
  test("a missing or foreign decision shows the not-found state", async () => {
    setQuery(get, new ConvexError({ code: "not_found", message: "Decision not found" }));
    signInAs("sess_a");
    renderApp("/decision/d_foreign");

    expect(await screen.findByText("Decision not found")).toBeOnTheScreen();
    expect(screen.getByText("This decision does not exist or is not yours.")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
    expectNoControls();
  });

  test("a malformed id shows the not-found state", async () => {
    setQuery(
      get,
      new ConvexError({ code: "invalid", message: "Invalid decisionId", field: "decisionId" }),
    );
    signInAs("sess_a");
    renderApp("/decision/not-an-id");

    expect(await screen.findByText("Decision not found")).toBeOnTheScreen();
  });

  test("any other failure offers a query retry that sends no answer", async () => {
    setQuery(get, new Error("Network request failed"));
    signInAs("sess_a");
    renderApp("/decision/d_1");

    expect(await screen.findByText("Could not load this decision.")).toBeOnTheScreen();
    expect(screen.queryByText("Decision not found")).not.toBeOnTheScreen();

    serve(decision({ id: "d_1", title: "Back again" }));
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Back again")).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("a signed-out direct link goes to sign-in and runs no query", async () => {
    renderApp("/decision/d_1");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
    expect(queryCalls).toEqual([]);
  });
});

describe("answer controls", () => {
  beforeEach(() => {
    answerDecision.mockImplementation(async (args) =>
      answered({ id: args.decisionId, title: "Done", answer: args.answer as Decision["answer"] }),
    );
  });

  test("Reject sends reject in one tap", async () => {
    await open(decision({ id: "d_1", title: "Ship?", input_type: "approve_reject" }));

    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeOnTheScreen();
    choose("Reject");
    await flush();

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "reject" } });
  });

  test("Approve sends approve in one tap", async () => {
    await open(decision({ id: "d_1", title: "Ship?", input_type: "approve_reject" }));

    choose("Approve");
    await flush();

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "approve" } });
  });

  test("single choice submits one option", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice", options: choices }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Alpha" }));
    fireEvent.press(screen.getByRole("radio", { name: "Gamma" }));
    expect(screen.getByRole("radio", { name: "Gamma" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Alpha" })).not.toBeChecked();
    submit();
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "option", option_id: "c" },
    });
  });

  test("multiple choice submits the checked options in option order", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "multiple_choice", options: choices }),
    );

    fireEvent.press(screen.getByRole("checkbox", { name: "Gamma" }));
    fireEvent.press(screen.getByRole("checkbox", { name: "Beta" }));
    fireEvent.press(screen.getByRole("checkbox", { name: "Alpha" }));
    fireEvent.press(screen.getByRole("checkbox", { name: "Beta" }));
    expect(screen.getByRole("checkbox", { name: "Beta" })).not.toBeChecked();
    submit();
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "options", option_ids: ["a", "c"] },
    });
  });

  test("free text submits the text", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    fireEvent.changeText(screen.getByLabelText("Answer text"), "Call it Atlas");
    submit();
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "text", text: "Call it Atlas" },
    });
  });

  test("single choice or text submits an option", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice_or_text", options: choices }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Beta" }));
    expect(screen.queryByLabelText("Answer text")).not.toBeOnTheScreen();
    submit();
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "option", option_id: "b" },
    });
  });

  test("single choice or text submits text from Other answer, never both", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice_or_text", options: choices }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Beta" }));
    fireEvent.press(screen.getByRole("radio", { name: "Other answer" }));
    expect(screen.getByRole("radio", { name: "Beta" })).not.toBeChecked();
    fireEvent.changeText(screen.getByLabelText("Answer text"), "Something else");
    submit();
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "text", text: "Something else" },
    });
  });

  test("picking an option after Other answer drops the typed text", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice_or_text", options: choices }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Other answer" }));
    fireEvent.changeText(screen.getByLabelText("Answer text"), "Typed then dropped");
    fireEvent.press(screen.getByRole("radio", { name: "Alpha" }));
    fireEvent.press(screen.getByRole("radio", { name: "Other answer" }));
    expect(screen.getByLabelText("Answer text")).toHaveDisplayValue("");
    fireEvent.press(screen.getByRole("radio", { name: "Alpha" }));
    submit();
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "option", option_id: "a" },
    });
  });

  test("without a recommendation Approve is the primary button and Reject is never red", async () => {
    await open(decision({ id: "d_1", title: "Ship?", input_type: "approve_reject" }));

    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(within(approve).getByText("Approve")).toHaveStyle({ color: themes.light.onAccent });
    // Reject is an answer, not a destructive action: a secondary button.
    expect(within(reject).getByText("Reject")).toHaveStyle({ color: themes.light.text });
  });

  test("at large text sizes the answer buttons stack with the primary one first", async () => {
    const window = Dimensions.get("window");
    const names = () =>
      screen
        .getAllByRole("button")
        .map(
          (button) =>
            button.props.accessibilityLabel ?? within(button).queryByText(/./)?.props.children,
        )
        .filter((name) => name === "Approve" || name === "Reject");
    try {
      // React Native's Jest setup reports a font scale of 2; start at 1.
      Dimensions.set({ window: { ...window, fontScale: 1 }, screen: window });
      await open(decision({ id: "d_1", title: "Ship?", recommendation: { kind: "approve" } }));
      expect(names()).toEqual(["Reject", "Approve"]);
      // Side by side, each button takes half the row.
      expect(screen.getByRole("button", { name: "Reject" })).toHaveStyle({ flex: 1 });

      act(() => Dimensions.set({ window: { ...window, fontScale: 2 }, screen: window }));

      // Stacked, each button takes the full width, the recommended one first.
      expect(screen.getByRole("button", { name: "Reject" })).not.toHaveStyle({ flex: 1 });
      expect(names()).toEqual(["Approve", "Reject"]);
      act(() => serve(decision({ id: "d_1", title: "Ship?", recommendation: { kind: "reject" } })));
      expect(names()).toEqual(["Reject", "Approve"]);
    } finally {
      act(() => Dimensions.set({ window, screen: window }));
    }
  });

  test("focusing the answer text scrolls the body so the field stays in view", async () => {
    const scrollToEnd = jest.mocked(ScrollView.prototype.scrollToEnd);
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));
    scrollToEnd.mockClear();

    fireEvent(screen.getByLabelText("Answer text"), "focus");

    expect(scrollToEnd).toHaveBeenCalled();
  });

  test("the note stays tucked behind Add note until asked for", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    expect(screen.queryByLabelText("Note")).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Add note" }).props.hitSlop).toEqual(LINK_HIT_SLOP);
    fireEvent.press(screen.getByRole("button", { name: "Add note" }));

    expect(screen.getByLabelText("Note")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Add note" })).not.toBeOnTheScreen();
  });

  test("an optional note is sent with the answer", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    addNote("Ship after the freeze");
    choose("Approve");
    await flush();

    expect(lastAnswer()).toEqual({
      decisionId: "d_1",
      answer: { kind: "approve" },
      note: "Ship after the freeze",
    });
  });
});

describe("limits and validation", () => {
  beforeEach(() => {
    answerDecision.mockImplementation(async (args) =>
      answered({ id: args.decisionId, title: "Done" }),
    );
  });

  test("a note of 2,000 characters is sent", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    addNote("n".repeat(2000));
    // The counter meets 4.5:1 in the secondary color.
    expect(screen.getByText("2000/2000")).toHaveStyle({ color: themes.light.textSecondary });
    choose("Approve");
    await flush();

    expect(lastAnswer()?.note).toHaveLength(2000);
  });

  test("a note of 2,001 characters shows the contract message and sends nothing", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    addNote("n".repeat(2001));
    expect(screen.getByText("2001/2000")).toHaveStyle({ color: themes.light.red });
    choose("Approve");
    await flush();

    expect(screen.getByText("Keep your note to 2,000 characters or fewer.")).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith("Keep your note to 2,000 characters or fewer.");
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("an answer text of 4,000 characters is sent and 4,001 is refused", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    fireEvent.changeText(screen.getByLabelText("Answer text"), "t".repeat(4001));
    submit();
    await flush();
    expect(screen.getByText("Keep your answer to 4,000 characters or fewer.")).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith("Keep your answer to 4,000 characters or fewer.");
    expect(answerDecision).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByLabelText("Answer text"), "t".repeat(4000));
    submit();
    await flush();
    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(lastAnswer()?.answer).toEqual({ kind: "text", text: "t".repeat(4000) });
  });

  test("an over-long answer and note each show their own message", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    fireEvent.changeText(screen.getByLabelText("Answer text"), "t".repeat(4001));
    addNote("n".repeat(2001));
    submit();
    await flush();

    expect(screen.getByText("Keep your answer to 4,000 characters or fewer.")).toBeOnTheScreen();
    expect(screen.getByText("Keep your note to 2,000 characters or fewer.")).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(
      "Keep your answer to 4,000 characters or fewer. Keep your note to 2,000 characters or fewer.",
    );
    expect(answerDecision).not.toHaveBeenCalled();
  });
});

// "Send answer" stays disabled until the draft forms an answer, with a hint
// saying what to do, so an empty draft never reaches validation.
describe("an empty draft", () => {
  beforeEach(() => {
    answerDecision.mockImplementation(async (args) =>
      answered({ id: args.decisionId, title: "Done" }),
    );
  });

  function send() {
    return screen.getByRole("button", { name: "Send answer" });
  }

  // The button is disabled for presses and for VoiceOver, its hint repeats
  // the visible one, and a press sends and announces nothing.
  async function expectBlocked(hint: string) {
    expect(send()).toBeDisabled();
    expect(send().props.accessibilityState).toEqual({ disabled: true });
    expect(send().props.accessibilityHint).toBe(hint);
    expect(screen.getByText(hint)).toBeOnTheScreen();
    submit();
    await flush();
    expect(answerDecision).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  }

  function expectReady(hint: string) {
    expect(send()).toBeEnabled();
    expect(send().props.accessibilityState).toEqual({ disabled: false });
    expect(send().props.accessibilityHint).toBeUndefined();
    expect(screen.queryByText(hint)).not.toBeOnTheScreen();
  }

  test("single choice waits for an option", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice", options: choices }),
    );

    await expectBlocked("Choose an option.");

    fireEvent.press(screen.getByRole("radio", { name: "Beta" }));
    expectReady("Choose an option.");
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "option", option_id: "b" });
  });

  test("multiple choice waits for a checked option and blocks again when all are cleared", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "multiple_choice", options: choices }),
    );

    await expectBlocked("Choose at least one option.");

    fireEvent.press(screen.getByRole("checkbox", { name: "Alpha" }));
    expectReady("Choose at least one option.");
    fireEvent.press(screen.getByRole("checkbox", { name: "Alpha" }));
    await expectBlocked("Choose at least one option.");

    fireEvent.press(screen.getByRole("checkbox", { name: "Gamma" }));
    expectReady("Choose at least one option.");
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "options", option_ids: ["c"] });
  });

  test("free text waits for text and blocks again when it is cleared", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    await expectBlocked("Enter an answer.");

    fireEvent.changeText(screen.getByLabelText("Answer text"), "Blue");
    expectReady("Enter an answer.");
    fireEvent.changeText(screen.getByLabelText("Answer text"), "");
    await expectBlocked("Enter an answer.");
  });

  // The contract accepts text that is only whitespace, so the form sends it
  // exactly as typed.
  test("text that is only whitespace is an answer and is sent unchanged", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    fireEvent.changeText(screen.getByLabelText("Answer text"), "  ");
    expectReady("Enter an answer.");
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "text", text: "  " });
  });

  test("single choice or text follows the active mode", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Pick",
        input_type: "single_choice_or_text",
        options: choices,
      }),
    );

    await expectBlocked("Choose an option.");

    fireEvent.press(screen.getByRole("radio", { name: "Other answer" }));
    await expectBlocked("Enter an answer.");
    fireEvent.changeText(screen.getByLabelText("Answer text"), "Neither");
    expectReady("Enter an answer.");

    // Picking an option drops the text; the option alone forms the answer.
    fireEvent.press(screen.getByRole("radio", { name: "Alpha" }));
    expectReady("Choose an option.");

    // Back on Other answer the option no longer counts.
    fireEvent.press(screen.getByRole("radio", { name: "Other answer" }));
    await expectBlocked("Enter an answer.");
  });

  test("a recommended option is ready to send at once", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Pick",
        input_type: "single_choice",
        options: choices,
        recommendation: { kind: "option", option_id: "a" },
      }),
    );

    expectReady("Choose an option.");
  });

  test("approve and reject are never blocked", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeOnTheScreen();
  });
});

describe("recommendation", () => {
  beforeEach(() => {
    answerDecision.mockImplementation(async (args) =>
      answered({ id: args.decisionId, title: "Done" }),
    );
  });

  test("single choice preselects and marks the recommended option", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Pick",
        input_type: "single_choice",
        options: choices,
        recommendation: { kind: "option", option_id: "b" },
      }),
    );

    const beta = screen.getByRole("radio", { name: "Beta" });
    expect(beta).toBeChecked();
    expect(within(beta).getByText("Recommended")).toBeOnTheScreen();
    // VoiceOver reads the marker as the row's value, after its checked state.
    expect(beta).toHaveAccessibilityValue({ text: "Recommended" });
    expect(screen.getByRole("radio", { name: "Alpha" })).not.toHaveAccessibilityValue({
      text: "Recommended",
    });
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
  });

  test("single choice: the user can change the selection and the marker stays", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Pick",
        input_type: "single_choice",
        options: choices,
        recommendation: { kind: "option", option_id: "b" },
      }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Gamma" }));

    expect(screen.getByRole("radio", { name: "Gamma" })).toBeChecked();
    const beta = screen.getByRole("radio", { name: "Beta" });
    expect(beta).not.toBeChecked();
    expect(within(beta).getByText("Recommended")).toBeOnTheScreen();
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "option", option_id: "c" });
  });

  test("multiple choice preselects and marks every recommended option", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Pick",
        input_type: "multiple_choice",
        options: choices,
        recommendation: { kind: "options", option_ids: ["a", "c"] },
      }),
    );

    for (const name of ["Alpha", "Gamma"]) {
      const box = screen.getByRole("checkbox", { name });
      expect(box).toBeChecked();
      expect(within(box).getByText("Recommended")).toBeOnTheScreen();
    }
    expect(screen.getByRole("checkbox", { name: "Beta" })).not.toBeChecked();
    expect(screen.getByText("Recommended: Alpha, Gamma")).toBeOnTheScreen();

    fireEvent.press(screen.getByRole("checkbox", { name: "Alpha" }));
    expect(
      within(screen.getByRole("checkbox", { name: "Alpha" })).getByText("Recommended"),
    ).toBeOnTheScreen();
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "options", option_ids: ["c"] });
  });

  test("an approve recommendation marks Approve and submits as is", async () => {
    await open(decision({ id: "d_1", title: "Ship?", recommendation: { kind: "approve" } }));

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.props.accessibilityHint).toBe("Recommended by the agent");
    expect(screen.getByRole("button", { name: "Reject" }).props.accessibilityHint).toBeUndefined();
    expect(screen.getByText("Recommended: Approve")).toBeOnTheScreen();
    // The recommended button is the filled primary one.
    expect(within(approve).getByText("Approve")).toHaveStyle({ color: themes.light.onAccent });
    choose("Approve");
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "approve" });
  });

  test("a reject recommendation marks Reject as the primary button", async () => {
    await open(decision({ id: "d_1", title: "Ship?", recommendation: { kind: "reject" } }));

    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject.props.accessibilityHint).toBe("Recommended by the agent");
    expect(within(reject).getByText("Reject")).toHaveStyle({ color: themes.light.onAccent });
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.props.accessibilityHint).toBeUndefined();
    expect(within(approve).getByText("Approve")).toHaveStyle({ color: themes.light.text });
    expect(screen.getByText("Recommended: Reject")).toBeOnTheScreen();
  });

  test("a text recommendation prefills the text and selects Other answer", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Pick",
        input_type: "single_choice_or_text",
        options: choices,
        recommendation: { kind: "text", text: "Use Delta" },
      }),
    );

    const other = screen.getByRole("radio", { name: "Other answer" });
    expect(other).toBeChecked();
    expect(within(other).getByText("Recommended")).toBeOnTheScreen();
    expect(screen.getByLabelText("Answer text")).toHaveDisplayValue("Use Delta");
  });

  test("a free-text recommendation is prefilled and says so", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Name it",
        input_type: "free_text",
        recommendation: { kind: "text", text: "Atlas" },
      }),
    );

    expect(screen.getByText("Recommended answer prefilled")).toBeOnTheScreen();
    expect(screen.getByLabelText("Answer text")).toHaveDisplayValue("Atlas");
  });

  test("a pending update to the same decision keeps the user's edits", async () => {
    const original = decision({
      id: "d_1",
      title: "Pick",
      input_type: "single_choice",
      options: choices,
      recommendation: { kind: "option", option_id: "b" },
    });
    await open(original);
    fireEvent.press(screen.getByRole("radio", { name: "Alpha" }));
    addNote("My reason");

    act(() => serve({ ...original, title: "Pick (edited)", follow_up_ids: ["d_9"] }));

    expect(screen.getByText("Pick (edited)")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Beta" })).not.toBeChecked();
    expect(screen.getByLabelText("Note")).toHaveDisplayValue("My reason");
  });
});

describe("submission", () => {
  test("repeated presses send one request, and the returned outcome replaces the form", async () => {
    const reply = deferred<unknown>();
    answerDecision.mockReturnValue(reply.promise);
    await open(decision({ id: "d_1", title: "Ship?" }));

    choose("Reject");
    fireEvent.press(screen.getByRole("button", { name: "Sending" }));
    fireEvent.press(screen.getByRole("button", { name: "Sending" }));
    fireEvent.press(screen.getByRole("button", { name: "Approve" }));

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    await act(async () => {
      reply.resolve(
        answered({
          id: "d_1",
          title: "Ship?",
          answer: { kind: "reject" },
          answered_via: "app",
        }),
      );
    });

    // The subscription still reports pending; the returned outcome stands.
    expect(screen.getByText("Rejected")).toBeOnTheScreen();
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(haptic.error).not.toHaveBeenCalled();
    expect(screen.getByText(/^By you in the app · /)).toBeOnTheScreen();
    expectNoControls();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  test("Send answer reads Sending and disables the options while the request runs", async () => {
    const reply = deferred<unknown>();
    answerDecision.mockReturnValue(reply.promise);
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice", options: choices }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Beta" }));
    submit();
    fireEvent.press(screen.getByRole("button", { name: "Sending" }));

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeDisabled();

    await act(async () => {
      reply.resolve(
        answered({
          id: "d_1",
          title: "Pick",
          input_type: "single_choice",
          options: choices,
          answer: { kind: "option", option_id: "b" },
        }),
      );
    });

    expect(screen.getByText("Answered")).toBeOnTheScreen();
    expect(screen.getByText("Beta")).toBeOnTheScreen();
    expectNoControls();
  });

  test("a conflict shows the stored outcome, discards the attempt, and does not retry", async () => {
    const stored = answered({
      id: "d_1",
      title: "Name it",
      input_type: "free_text",
      answer: { kind: "text", text: "Atlas from the phone" },
      note: "Answered on the lock screen",
      answered_via: "notification",
    });
    answerDecision.mockRejectedValue(
      new ConvexError({
        code: "conflict",
        message: "Decision is already answered",
        decision: stored,
      }),
    );
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    fireEvent.changeText(screen.getByLabelText("Answer text"), "My attempted answer");
    addNote("My attempted note");
    submit();
    await flush();

    expect(
      screen.getByText(
        "This decision was settled before your answer arrived. Your answer was not recorded.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Atlas from the phone")).toBeOnTheScreen();
    expect(screen.getByText("Answered on the lock screen")).toBeOnTheScreen();
    expect(screen.getByText(/^By you from a notification · /)).toBeOnTheScreen();
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      expect.stringMatching(
        /^This decision was settled before your answer arrived\. Your answer was not recorded\. Recorded outcome: Answered\. Atlas from the phone\. By you from a notification, /,
      ),
    );
    expect(screen.queryByText("My attempted answer")).not.toBeOnTheScreen();
    expect(screen.queryByText("My attempted note")).not.toBeOnTheScreen();
    expectNoControls();

    await flush();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  test("a conflict without a readable stored decision shows no outcome and allows no resend", async () => {
    answerDecision.mockRejectedValue(
      new ConvexError({ code: "conflict", message: "Decision is already answered" }),
    );
    const pending = decision({ id: "d_1", title: "Ship?" });
    await open(pending);

    choose("Approve");
    await flush();

    expect(
      screen.getByText(
        "This decision was settled elsewhere. Its recorded outcome appears here once it loads.",
      ),
    ).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(
      "This decision was settled elsewhere. Its recorded outcome appears here once it loads.",
    );
    expect(screen.queryByText("Approved")).not.toBeOnTheScreen();
    expect(screen.queryByRole("header", { name: /^Approved/ })).not.toBeOnTheScreen();
    expectNoControls();

    act(() =>
      serve(
        answered({ id: "d_1", title: "Ship?", answer: { kind: "reject" }, answered_via: "api" }),
      ),
    );

    expect(screen.getByText("Rejected")).toBeOnTheScreen();
    expect(screen.getByText(/^Through the API · /)).toBeOnTheScreen();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  test("another failure keeps the draft and the user may send it again", async () => {
    answerDecision.mockRejectedValueOnce(new Error("Network request failed"));
    answerDecision.mockImplementation(async (args) =>
      answered({ id: args.decisionId, title: "Ship?", answer: { kind: "reject" } }),
    );
    await open(decision({ id: "d_1", title: "Ship?" }));

    addNote("Kept");
    choose("Reject");
    await flush();

    expect(
      screen.getByText("Could not send your answer. Check your connection."),
    ).toBeOnTheScreen();
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith("Could not send your answer. Check your connection.");
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByLabelText("Note")).toHaveDisplayValue("Kept");
    expect(answerDecision).toHaveBeenCalledTimes(1);

    choose("Reject");
    await flush();

    expect(answerDecision).toHaveBeenCalledTimes(2);
    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "reject" }, note: "Kept" });
    expect(screen.getByText("Rejected")).toBeOnTheScreen();
  });

  // The backend's `data.message` is written for developers, so a refusal shows
  // fixed copy for its code. Each message differs from every copy, so a
  // pass-through would show on screen or in the announcement.
  const refusals = [
    ["invalid", "option_id names no option", "Check your answer and try again."],
    ["unauthenticated", "Not signed in", "Your session ended. Sign in again."],
    ["not_found", "Decision not found", "This decision no longer exists."],
    [
      "locked",
      "Locked until 2026-10-16T10:00:00Z",
      "This decision cannot accept an answer right now.",
    ],
    [
      "rate_limited",
      "Rate limit exceeded for usr_123",
      "Too many attempts. Wait a moment and try again.",
    ],
    ["quota_exceeded", "Quota exceeded for usr_123", "Could not send your answer. Try again."],
  ] as const;

  // Fails the test if `text` reached the screen or a VoiceOver announcement.
  function expectNotShown(text: string) {
    expect(screen.queryByText(text, { exact: false })).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(text, { exact: false })).not.toBeOnTheScreen();
    for (const [announced] of announce.mock.calls) {
      expect(announced).not.toContain(text);
    }
  }

  test.each(refusals)(
    "the %s refusal shows fixed copy and never the backend's message",
    async (code, message, copy) => {
      answerDecision.mockRejectedValue(new ConvexError({ code, message, field: "answer" }));
      await open(decision({ id: "d_1", title: "Ship?" }));

      choose("Approve");
      await flush();

      expect(screen.getByText(copy)).toBeOnTheScreen();
      expect(announce).toHaveBeenCalledWith(copy);
      expectNotShown(message);
      // Connection wording is only for failures without a code.
      expectNotShown("Check your connection");
      expect(haptic.error).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    },
  );

  test("a refusal without a message shows the fixed copy for its code", async () => {
    answerDecision.mockRejectedValue(new ConvexError({ code: "not_found" }));
    await open(decision({ id: "d_1", title: "Ship?" }));

    choose("Approve");
    await flush();

    expect(screen.getByText("This decision no longer exists.")).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith("This decision no longer exists.");
  });

  test.each([
    ["a malformed code", new ConvexError({ code: 409, message: "Conflict at /v1/answer" })],
    ["no code", new ConvexError({ message: "Conflict at /v1/answer" })],
    ["string data", new ConvexError("Conflict at /v1/answer")],
    ["a plain Error", new Error("Conflict at /v1/answer")],
  ])("a failure with %s shows the connection copy and never its text", async (_, error) => {
    answerDecision.mockRejectedValue(error);
    await open(decision({ id: "d_1", title: "Ship?" }));

    choose("Approve");
    await flush();

    const copy = "Could not send your answer. Check your connection.";
    expect(screen.getByText(copy)).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(copy);
    expectNotShown("Conflict at /v1/answer");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  test("a settlement arriving while editing removes the draft and shows the outcome", async () => {
    const pending = decision({ id: "d_1", title: "Name it", input_type: "free_text" });
    await open(pending);
    fireEvent.changeText(screen.getByLabelText("Answer text"), "Half-typed answer");

    act(() =>
      serve({
        ...pending,
        state: "cancelled",
      }),
    );

    expect(screen.getByText("Cancelled")).toBeOnTheScreen();
    expect(screen.queryByText("Half-typed answer")).not.toBeOnTheScreen();
    expectNoControls();
    expect(answerDecision).not.toHaveBeenCalled();
  });
});

describe("settled decisions", () => {
  test("an answered decision opens read-only with its answer, note, time, and surface", async () => {
    const at = "2026-10-11T10:00:00.000Z";
    await open(
      answered({
        id: "d_1",
        title: "Pick",
        input_type: "multiple_choice",
        options: choices,
        answer: { kind: "options", option_ids: ["a", "c"] },
        recommendation: { kind: "options", option_ids: ["a"] },
        note: "Both are needed",
        answered_at: at,
        answered_via: "api",
      }),
    );

    expect(banner("Answered")).toHaveAccessibleName(
      new RegExp(`^Answered\\. Alpha, Gamma\\. Through the API, .*${clockTime(at)}$`),
    );
    expect(screen.getByText("Alpha, Gamma")).toBeOnTheScreen();
    expect(screen.getByText("Both are needed")).toBeOnTheScreen();
    expect(
      screen.getByText(new RegExp(`^Through the API · .*${clockTime(at)}$`)),
    ).toBeOnTheScreen();
    // The rest of the decision stays below, recommendation included.
    expect(screen.getByText("Recommended: Alpha")).toBeOnTheScreen();
    expect(screen.getByText("acme")).toBeOnTheScreen();
    expectNoControls();
  });

  test("an approval from a notification today reads as the prototype's banner", async () => {
    const at = new Date().toISOString();
    await open(
      answered({ id: "d_1", title: "Ship?", answered_at: at, answered_via: "notification" }),
    );

    // VoiceOver reads the banner as one header: title, then how and when.
    expect(
      screen.getByRole("header", {
        name: `Approved. By you from a notification, Today ${clockTime(at)}`,
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(`By you from a notification · Today ${clockTime(at)}`),
    ).toBeOnTheScreen();
  });

  test("an expired decision shows its applied default", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Ship?",
        state: "expired",
        deadline: "2026-10-11T09:30:00.000Z",
        default: { kind: "reject" },
        answer: { kind: "reject" },
        applied_by_default: true,
        answered_at: "2026-10-11T09:30:20.000Z",
        answered_via: "default",
      }),
    );

    expect(banner("Default applied")).toBeOnTheScreen();
    expect(screen.getByText("Reject")).toBeOnTheScreen();
    expect(screen.getByText(/^Applied at the deadline · /)).toBeOnTheScreen();
    expect(screen.getByText("Default: Reject")).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`Deadline ${new Date("2026-10-11T09:30:00.000Z").toLocaleString()}`),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/left$/)).not.toBeOnTheScreen();
    expectNoControls();
  });

  test("an expired decision without a default says it expired without an answer", async () => {
    await open(
      decision({
        id: "d_1",
        title: "Ship?",
        state: "expired",
        deadline: "2026-10-11T09:30:00.000Z",
      }),
    );

    expect(
      screen.getByRole("header", { name: "Expired. Expired without an answer" }),
    ).toBeOnTheScreen();
    expect(screen.getByText("Expired without an answer")).toBeOnTheScreen();
    expectNoControls();
  });

  test("a cancelled decision shows no answer", async () => {
    await open(decision({ id: "d_1", title: "Ship?", state: "cancelled" }));

    expect(
      screen.getByRole("header", { name: "Cancelled. No answer was recorded" }),
    ).toBeOnTheScreen();
    expect(screen.getByText("No answer was recorded.")).toBeOnTheScreen();
    expectNoControls();
  });
});

// component-mobile-app §Screens, Answers given in chat (req-decision-requests
// AC-8.3; req-mobile-app AC-3.2; DEC-13).
describe("answers given in chat", () => {
  // Markdown characters and line breaks the card must show as typed.
  const MESSAGE = "**Ship it** after the _tests_ pass.\n# Not a heading\n- not a list\n`code`";

  function inChat(overrides: Partial<Decision> & Pick<Decision, "id">): Decision {
    return answered({
      answered_via: "chat",
      chat_message: MESSAGE,
      relayed_by_agent_session_id: "s_relay",
      ...overrides,
    });
  }

  function messageCard() {
    return screen.getByLabelText(`Your message in chat: ${MESSAGE}`);
  }

  test("a chat answer shows its answer, Answered in chat with the time, and the message as typed", async () => {
    const at = "2026-10-11T10:00:00.000Z";
    await open(inChat({ id: "d_1", title: "Ship?", answered_at: at }));

    expect(banner("Approved")).toHaveAccessibleName(
      new RegExp(`^Approved\\. Answered in chat, .*${clockTime(at)}$`),
    );
    expect(
      screen.getByText(new RegExp(`^Answered in chat · .*${clockTime(at)}$`)),
    ).toBeOnTheScreen();
    // The card's label reads the message, and its text is the message
    // exactly, Markdown characters and line breaks included.
    const card = messageCard();
    expect(within(card).getByText("Your message in chat")).toBeOnTheScreen();
    expect(within(card).getByText(MESSAGE)).toBeOnTheScreen();
    // No Markdown renderer touched it: no heading, emphasis, or list text.
    expect(screen.queryByText("Ship it")).not.toBeOnTheScreen();
    expect(screen.queryByText("Not a heading")).not.toBeOnTheScreen();
    expectNoControls();
  });

  test("a chat answer of any kind names the recorded answer above the message card", async () => {
    await open(
      inChat({
        id: "d_1",
        title: "Pick",
        input_type: "multiple_choice",
        options: choices,
        answer: { kind: "options", option_ids: ["a", "c"] },
        note: "From the chat",
      }),
    );

    expect(banner("Answered")).toHaveAccessibleName(
      /^Answered\. Alpha, Gamma\. Answered in chat, /,
    );
    expect(screen.getByText("Alpha, Gamma")).toBeOnTheScreen();
    expect(messageCard()).toBeOnTheScreen();
    expect(screen.getByText("From the chat")).toBeOnTheScreen();
  });

  test("a chat rejection reads as Rejected with the message", async () => {
    await open(inChat({ id: "d_1", title: "Ship?", answer: { kind: "reject" } }));

    expect(banner("Rejected")).toHaveAccessibleName(/^Rejected\. Answered in chat, /);
    expect(messageCard()).toBeOnTheScreen();
  });

  test("a message at the contract's longest length shows in full", async () => {
    const long = `${"line of the user's message\n".repeat(150)}end`.slice(-4000);
    expect(long).toHaveLength(4000);
    await open(inChat({ id: "d_1", title: "Ship?", chat_message: long }));

    const text = screen.getByText(long);
    expect(text).toBeOnTheScreen();
    expect(text.props.numberOfLines).toBeUndefined();
    expect(screen.getByLabelText(`Your message in chat: ${long}`)).toBeOnTheScreen();
  });

  test("an app answer shows no chat message card", async () => {
    await open(answered({ id: "d_1", title: "Ship?" }));

    expect(banner("Approved")).toHaveAccessibleName(/^Approved\. By you in the app, /);
    expect(screen.queryByText("Your message in chat")).not.toBeOnTheScreen();
    expect(screen.queryByText(/Answered in chat/)).not.toBeOnTheScreen();
  });

  test("a pending decision answered in chat while open switches to the chat outcome", async () => {
    const pending = decision({ id: "d_1", title: "Name it", input_type: "free_text" });
    await open(pending);
    fireEvent.changeText(screen.getByLabelText("Answer text"), "Half-typed answer");

    act(() =>
      serve(
        inChat({
          id: "d_1",
          title: "Name it",
          input_type: "free_text",
          answer: { kind: "text", text: "Atlas" },
        }),
      ),
    );

    expect(banner("Answered")).toHaveAccessibleName(/^Answered\. Atlas\. Answered in chat, /);
    expect(messageCard()).toBeOnTheScreen();
    expect(screen.queryByText("Half-typed answer")).not.toBeOnTheScreen();
    expectNoControls();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("an answer that loses to a chat answer shows the chat outcome and is not retried", async () => {
    const stored = inChat({ id: "d_1", title: "Ship?", answer: { kind: "reject" } });
    answerDecision.mockRejectedValue(
      new ConvexError({
        code: "conflict",
        message: "Decision is already answered",
        decision: stored,
      }),
    );
    await open(decision({ id: "d_1", title: "Ship?" }));

    addNote("My attempted note");
    choose("Approve");
    await flush();

    expect(
      screen.getByText(
        "This decision was settled before your answer arrived. Your answer was not recorded.",
      ),
    ).toBeOnTheScreen();
    expect(banner("Rejected")).toHaveAccessibleName(/^Rejected\. Answered in chat, /);
    expect(messageCard()).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(
      expect.stringMatching(
        /^This decision was settled before your answer arrived\. Your answer was not recorded\. Recorded outcome: Rejected\. Answered in chat, /,
      ),
    );
    expect(screen.queryByText("Approved")).not.toBeOnTheScreen();
    expect(screen.queryByText("My attempted note")).not.toBeOnTheScreen();
    expectNoControls();

    await flush();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });
});
