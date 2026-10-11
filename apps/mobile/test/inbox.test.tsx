import { ConvexError } from "convex/values";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import { agent, decision } from "./data";
import { loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

const listPending = "decisions/app:listPending";
const liveAgents = "agents/app:liveAgents";

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
  await screen.findByText("Pending decisions");
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
    const headers = screen.getAllByRole("header").map((header) => header.props.children);
    expect(headers).toEqual(["Pending decisions", "Live agents"]);
    expect(queryCalls).toContainEqual({ name: listPending, args: {} });
    expect(queryCalls).toContainEqual({ name: liveAgents, args: {} });
  });

  test("a decision row shows its title, topic, priority, and deadline", async () => {
    const deadline = "2026-10-12T15:30:00.000Z";
    setQuery(listPending, [
      decision({
        id: "d_1",
        title: "Ship it?",
        topic: "acme/billing",
        priority: "urgent",
        deadline,
      }),
      decision({ id: "d_2", title: "Rename?", topic: "beta", priority: "normal", deadline: null }),
    ]);

    await openInbox();

    const urgent = within(screen.getByRole("button", { name: "Decision: Ship it?" }));
    expect(urgent.getByText("Ship it?")).toBeOnTheScreen();
    expect(urgent.getByText("acme/billing")).toBeOnTheScreen();
    expect(urgent.getByText("Urgent")).toBeOnTheScreen();
    expect(urgent.getByText(`Due ${new Date(deadline).toLocaleString()}`)).toBeOnTheScreen();
    const normal = within(screen.getByRole("button", { name: "Decision: Rename?" }));
    expect(normal.getByText("beta")).toBeOnTheScreen();
    expect(normal.getByText("Normal")).toBeOnTheScreen();
    expect(normal.getByText("No deadline")).toBeOnTheScreen();
  });

  test("an agent card shows every field and marks a stale session", async () => {
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
      agent({ id: "a_2", display_name: "Codex", pending_decision_count: 1, stale: false }),
    ]);

    await openInbox();

    const stale = within(screen.getByRole("button", { name: "Agent: Claude on laptop" }));
    expect(stale.getByText("Claude on laptop")).toBeOnTheScreen();
    expect(stale.getByText("acme/billing")).toBeOnTheScreen();
    expect(stale.getByText("blocked")).toBeOnTheScreen();
    expect(stale.getByText("Waiting on the migration review")).toBeOnTheScreen();
    expect(stale.getByText("Updated 3m ago")).toBeOnTheScreen();
    expect(stale.getByText("2 pending decisions")).toBeOnTheScreen();
    expect(stale.getByText("Stale")).toBeOnTheScreen();
    const fresh = within(screen.getByRole("button", { name: "Agent: Codex" }));
    expect(fresh.getByText("1 pending decision")).toBeOnTheScreen();
    expect(fresh.queryByText("Stale")).not.toBeOnTheScreen();
  });

  test("a session with no status yet says so instead of showing activity as a status", async () => {
    setQuery(liveAgents, [
      agent({ id: "a_1", display_name: "New agent", state: null, line: null, status_at: null }),
    ]);

    await openInbox();

    const card = within(screen.getByRole("button", { name: "Agent: New agent" }));
    expect(card.getByText("No status yet")).toBeOnTheScreen();
    expect(card.getByText("No update yet")).toBeOnTheScreen();
    expect(card.getByText("0 pending decisions")).toBeOnTheScreen();
  });

  test("shows an empty state for each empty section", async () => {
    await openInbox();

    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
    expect(screen.getByText("No live agents.")).toBeOnTheScreen();
  });

  test("shows loading until each query returns, not an empty state", async () => {
    setQuery(listPending, loading);
    setQuery(liveAgents, loading);

    await openInbox();

    expect(screen.getByText("Loading decisions")).toBeOnTheScreen();
    expect(screen.getByText("Loading agents")).toBeOnTheScreen();
    expect(screen.queryByText("No pending decisions.")).not.toBeOnTheScreen();

    act(() => setQuery(listPending, []));
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
    expect(screen.getByText("Loading agents")).toBeOnTheScreen();
  });

  test("a failed query shows a failure with a retry, not an empty inbox", async () => {
    setQuery(listPending, new ConvexError({ code: "internal", message: "boom" }));
    signInAs("sess_a");
    renderApp("/");

    expect(await screen.findByText("Could not load your inbox.")).toBeOnTheScreen();
    expect(screen.queryByText("No pending decisions.")).not.toBeOnTheScreen();

    setQuery(listPending, []);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No pending decisions.")).toBeOnTheScreen();
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
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
  });

  test("re-renders when an agent's status changes or it leaves the live set", async () => {
    setQuery(liveAgents, [agent({ id: "a_1", display_name: "Builder", line: "Compiling" })]);
    await openInbox();
    expect(screen.getByText("Compiling")).toBeOnTheScreen();

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
    expect(screen.getByText("Needs a decision")).toBeOnTheScreen();
    expect(screen.getByText("waiting")).toBeOnTheScreen();
    expect(screen.getByText("Stale")).toBeOnTheScreen();

    act(() => setQuery(liveAgents, []));
    expect(agentNames()).toEqual([]);
    expect(screen.getByText("No live agents.")).toBeOnTheScreen();
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
      setQuery(listPending, [decision({ id: "d_1", title: "Root", topic: "acme" })]);
      setQuery(liveAgents, [agent({ id: "a_1", display_name: "Root agent", topic: "acme" })]);
    });

    expect(screen.queryByRole("button", { name: "Topic: acmecorp" })).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "All topics" })).toBeSelected();
    expect(decisionTitles()).toEqual(["Decision: Root"]);
    expect(agentNames()).toEqual(["Agent: Root agent"]);
  });
});

describe("navigation", () => {
  test("a decision row opens its decision screen", async () => {
    setQuery(listPending, [decision({ id: "d_42", title: "Deploy?" })]);
    setQuery("decisions/app:get", (args: { decisionId: string }) =>
      decision({ id: args.decisionId, title: "Deploy?", body: "Ship the **release** today." }),
    );
    await openInbox();

    fireEvent.press(screen.getByRole("button", { name: "Decision: Deploy?" }));

    expect(await screen.findByText("release")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_42");
    expect(queryCalls).toContainEqual({ name: "decisions/app:get", args: { decisionId: "d_42" } });
  });

  test("an agent card opens its agent screen", async () => {
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
    expect(screen.getByText(/^Updated 5[89]s ago$/)).toBeOnTheScreen();

    expect(await screen.findByText("Updated 1m ago", {}, { timeout: 3_000 })).toBeOnTheScreen();
  });
});
