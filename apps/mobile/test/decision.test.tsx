import type { Decision } from "@agentdesk/contract";
import { ConvexError } from "convex/values";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import { TextInput } from "react-native";
import { agent, decision } from "./data";
import { answerDecision, deferred, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens, decision/[id] (req-mobile-app REQ-3).

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

function submit() {
  fireEvent.press(screen.getByRole("button", { name: "Submit answer" }));
}

// Lets a resolved or rejected mutation promise settle and re-render.
async function flush() {
  await act(async () => {});
}

function lastAnswer() {
  return answerDecision.mock.calls.at(-1)?.[0];
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
  expect(screen.queryByRole("button", { name: "Submit answer" })).not.toBeOnTheScreen();
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
}

describe("display", () => {
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
    });
    serve(item, decision({ id: "d_parent", title: "Parent question" }));
    openDecision("d_1");
    await screen.findByText("Pick a plan");

    expect(queryCalls).toContainEqual({ name: get, args: { decisionId: "d_1" } });
    // Markdown: a heading, bold text, and list items render as their own
    // text nodes, not as the raw source.
    expect(screen.getByText("Context")).toBeOnTheScreen();
    expect(screen.getByText("refund")).toBeOnTheScreen();
    expect(screen.getByText("keep old")).toBeOnTheScreen();
    expect(screen.queryByText(/\*\*refund\*\*/)).not.toBeOnTheScreen();

    expect(screen.getByText("Recommendation")).toBeOnTheScreen();
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
    expect(screen.getByText(`Due ${new Date(deadline).toLocaleString()}`)).toBeOnTheScreen();
    expect(screen.getByText(/^2h 5m left$/)).toBeOnTheScreen();
    expect(screen.getByText("Default")).toBeOnTheScreen();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText("Urgent")).toBeOnTheScreen();
    expect(screen.getByText("acme/billing")).toBeOnTheScreen();
    expect(await screen.findByRole("link", { name: "Agent: Claude on laptop" })).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Parent decision" })).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Follow-up decision 1" })).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Follow-up decision 2" })).toBeOnTheScreen();
  });

  test("names absent values instead of leaving them blank", async () => {
    await open(decision({ id: "d_1", title: "Bare" }));

    expect(screen.getByText("No recommendation")).toBeOnTheScreen();
    expect(screen.getByText("No deadline")).toBeOnTheScreen();
    expect(screen.getByText("No default")).toBeOnTheScreen();
    expect(screen.getByText("Normal")).toBeOnTheScreen();
    expect(screen.queryByRole("link", { name: "Parent decision" })).not.toBeOnTheScreen();
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
    // Only the backend expires a decision, so the controls stay.
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeOnTheScreen();
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

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    submit();
    await flush();

    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.getByText("Answered")).toBeOnTheScreen();
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
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeOnTheScreen();

    setQuery(agentGet, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    fireEvent.press(screen.getByRole("button", { name: "Retry agent" }));

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
  const second = decision({ id: "d_f2", title: "Second follow-up", parent_id: "d_1" });

  test("the parent link opens the parent decision", async () => {
    serve(parent, child, first, second);
    openDecision("d_1");
    await screen.findByText("Child question");

    fireEvent.press(screen.getByRole("link", { name: "Parent decision" }));

    expect(await screen.findByText("Parent question")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_parent");
  });

  test("each follow-up link opens its decision", async () => {
    serve(parent, child, first, second);
    openDecision("d_1");
    await screen.findByText("Child question");

    fireEvent.press(screen.getByRole("link", { name: "Follow-up decision 2" }));

    expect(await screen.findByText("Second follow-up")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_f2");
    expect(queryCalls).toContainEqual({ name: get, args: { decisionId: "d_f2" } });
  });

  test("another decision opens with its own draft, not the previous one's", async () => {
    serve(
      decision({ id: "d_1", title: "Child question", follow_up_ids: ["d_f1"] }),
      decision({ id: "d_f1", title: "First follow-up", parent_id: "d_1" }),
    );
    openDecision("d_1");
    await screen.findByText("Child question");
    fireEvent.press(screen.getByRole("radio", { name: "Reject" }));
    fireEvent.changeText(screen.getByLabelText("Note"), "Draft note");

    fireEvent.press(screen.getByRole("link", { name: "Follow-up decision 1" }));
    await screen.findByText("First follow-up");

    expect(screen.getByRole("radio", { name: "Reject" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Approve" })).not.toBeChecked();
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
    expect(screen.queryByRole("link", { name: "Parent decision" })).not.toBeOnTheScreen();
    expect(screen.getByText("Child question")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: get, args: { decisionId: "d_parent" } });

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    submit();
    await flush();

    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "approve" } });
    expect(screen.getByText("Answered")).toBeOnTheScreen();
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
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeOnTheScreen();

    parentReady = true;
    act(() => serve(child, decision({ id: "d_parent", title: "Parent question" })));

    expect(screen.getByRole("link", { name: "Parent decision" })).toBeOnTheScreen();
    expect(screen.queryByText("Loading parent")).not.toBeOnTheScreen();
  });

  test("another parent lookup failure offers a retry without hiding the decision", async () => {
    setQuery(get, (args: { decisionId: string }) =>
      args.decisionId === "d_1" ? child : new Error("Network request failed"),
    );
    openDecision("d_1");

    expect(await screen.findByText("Could not load the parent decision.")).toBeOnTheScreen();
    expect(screen.getByText("Child question")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeOnTheScreen();

    serve(child, decision({ id: "d_parent", title: "Parent question" }));
    fireEvent.press(screen.getByRole("button", { name: "Retry parent" }));

    expect(await screen.findByRole("link", { name: "Parent decision" })).toBeOnTheScreen();
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

  test("approve or reject submits approve or reject", async () => {
    await open(decision({ id: "d_1", title: "Ship?", input_type: "approve_reject" }));

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    fireEvent.press(screen.getByRole("radio", { name: "Reject" }));
    expect(screen.getByRole("radio", { name: "Reject" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Approve" })).not.toBeChecked();
    submit();
    await flush();

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "reject" } });
  });

  test("single choice submits one option", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "single_choice", options: choices }),
    );

    fireEvent.press(screen.getByRole("radio", { name: "Alpha" }));
    fireEvent.press(screen.getByRole("radio", { name: "Gamma" }));
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

  test("an optional note is sent with the answer", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    fireEvent.changeText(screen.getByLabelText("Note"), "Ship after the freeze");
    submit();
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

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    fireEvent.changeText(screen.getByLabelText("Note"), "n".repeat(2000));
    expect(screen.getByText("2000/2000")).toBeOnTheScreen();
    submit();
    await flush();

    expect(lastAnswer()?.note).toHaveLength(2000);
  });

  test("a note of 2,001 characters shows the contract message and sends nothing", async () => {
    await open(decision({ id: "d_1", title: "Ship?" }));

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    fireEvent.changeText(screen.getByLabelText("Note"), "n".repeat(2001));
    expect(screen.getByText("2001/2000")).toBeOnTheScreen();
    submit();
    await flush();

    expect(
      screen.getByText("Note: Too big: expected string to have <=2000 characters"),
    ).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("an answer text of 4,000 characters is sent and 4,001 is refused", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    fireEvent.changeText(screen.getByLabelText("Answer text"), "t".repeat(4001));
    submit();
    await flush();
    expect(
      screen.getByText("Text: Too big: expected string to have <=4000 characters"),
    ).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByLabelText("Answer text"), "t".repeat(4000));
    submit();
    await flush();
    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(lastAnswer()?.answer).toEqual({ kind: "text", text: "t".repeat(4000) });
  });

  test("submitting with nothing chosen shows the contract message and sends nothing", async () => {
    await open(decision({ id: "d_1", title: "Ship?", input_type: "approve_reject" }));

    submit();
    await flush();

    expect(
      screen.getByText("Answer: Invalid input: expected object, received null"),
    ).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("multiple choice with no option checked is refused", async () => {
    await open(
      decision({ id: "d_1", title: "Pick", input_type: "multiple_choice", options: choices }),
    );

    submit();
    await flush();

    expect(
      screen.getByText("Options: Too small: expected array to have >=1 items"),
    ).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("empty text is refused", async () => {
    await open(decision({ id: "d_1", title: "Name it", input_type: "free_text" }));

    submit();
    await flush();

    expect(
      screen.getByText("Text: Too small: expected string to have >=1 characters"),
    ).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();
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
    expect(beta.props.accessibilityHint).toBe("Recommended by the agent");
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

    fireEvent.press(screen.getByRole("checkbox", { name: "Alpha" }));
    expect(
      within(screen.getByRole("checkbox", { name: "Alpha" })).getByText("Recommended"),
    ).toBeOnTheScreen();
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "options", option_ids: ["c"] });
  });

  test("an approve recommendation is preselected and submits as is", async () => {
    await open(decision({ id: "d_1", title: "Ship?", recommendation: { kind: "approve" } }));

    const approve = screen.getByRole("radio", { name: "Approve" });
    expect(approve).toBeChecked();
    expect(within(approve).getByText("Recommended")).toBeOnTheScreen();
    submit();
    await flush();
    expect(lastAnswer()?.answer).toEqual({ kind: "approve" });
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
    fireEvent.changeText(screen.getByLabelText("Note"), "My reason");

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

    fireEvent.press(screen.getByRole("radio", { name: "Reject" }));
    submit();
    fireEvent.press(screen.getByRole("button", { name: "Submitting" }));
    fireEvent.press(screen.getByRole("button", { name: "Submitting" }));

    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Submitting" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Approve" })).toBeDisabled();

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
    expect(screen.getByText("Answered")).toBeOnTheScreen();
    expect(screen.getByText("Reject")).toBeOnTheScreen();
    expect(screen.getByText("Via app")).toBeOnTheScreen();
    expectNoControls();
    expect(answerDecision).toHaveBeenCalledTimes(1);
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
    fireEvent.changeText(screen.getByLabelText("Note"), "My attempted note");
    submit();
    await flush();

    expect(
      screen.getByText(
        "This decision was settled before your answer arrived. Your answer was not recorded.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Atlas from the phone")).toBeOnTheScreen();
    expect(screen.getByText("Answered on the lock screen")).toBeOnTheScreen();
    expect(screen.getByText("Via notification")).toBeOnTheScreen();
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

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    submit();
    await flush();

    expect(
      screen.getByText(
        "This decision was settled elsewhere. Its recorded outcome appears here once it loads.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Answered")).not.toBeOnTheScreen();
    expectNoControls();

    act(() =>
      serve(
        answered({ id: "d_1", title: "Ship?", answer: { kind: "reject" }, answered_via: "api" }),
      ),
    );

    expect(screen.getByText("Answered")).toBeOnTheScreen();
    expect(screen.getByText("Reject")).toBeOnTheScreen();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  test("another failure keeps the draft and the user may send it again", async () => {
    answerDecision.mockRejectedValueOnce(new Error("Network request failed"));
    answerDecision.mockImplementation(async (args) =>
      answered({ id: args.decisionId, title: "Ship?", answer: { kind: "reject" } }),
    );
    await open(decision({ id: "d_1", title: "Ship?" }));

    fireEvent.press(screen.getByRole("radio", { name: "Reject" }));
    fireEvent.changeText(screen.getByLabelText("Note"), "Kept");
    submit();
    await flush();

    expect(
      screen.getByText("Could not send your answer. Check your connection."),
    ).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Reject" })).toBeChecked();
    expect(screen.getByLabelText("Note")).toHaveDisplayValue("Kept");
    expect(answerDecision).toHaveBeenCalledTimes(1);

    submit();
    await flush();

    expect(answerDecision).toHaveBeenCalledTimes(2);
    expect(lastAnswer()).toEqual({ decisionId: "d_1", answer: { kind: "reject" }, note: "Kept" });
    expect(screen.getByText("Answered")).toBeOnTheScreen();
  });

  test("a backend refusal shows the backend's message", async () => {
    answerDecision.mockRejectedValue(
      new ConvexError({ code: "invalid", message: "option_id names no option", field: "answer" }),
    );
    await open(decision({ id: "d_1", title: "Ship?" }));

    fireEvent.press(screen.getByRole("radio", { name: "Approve" }));
    submit();
    await flush();

    expect(screen.getByText("option_id names no option")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeOnTheScreen();
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
        note: "Both are needed",
        answered_at: at,
        answered_via: "api",
      }),
    );

    expect(screen.getByText("Answered")).toBeOnTheScreen();
    expect(screen.getByText("Alpha, Gamma")).toBeOnTheScreen();
    expect(screen.getByText("Both are needed")).toBeOnTheScreen();
    expect(screen.getByText(`Answered ${new Date(at).toLocaleString()}`)).toBeOnTheScreen();
    expect(screen.getByText("Via api")).toBeOnTheScreen();
    expectNoControls();
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

    expect(screen.getByText("Expired")).toBeOnTheScreen();
    expect(screen.getByText("Default applied")).toBeOnTheScreen();
    expect(screen.getByText("Via default")).toBeOnTheScreen();
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

    expect(screen.getByText("Expired")).toBeOnTheScreen();
    expect(screen.getByText("Expired without an answer")).toBeOnTheScreen();
    expectNoControls();
  });

  test("a cancelled decision shows no answer", async () => {
    await open(decision({ id: "d_1", title: "Ship?", state: "cancelled" }));

    expect(screen.getByText("Cancelled")).toBeOnTheScreen();
    expect(screen.getByText("No answer was recorded.")).toBeOnTheScreen();
    expectNoControls();
  });
});
