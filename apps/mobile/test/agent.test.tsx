import { ConvexError } from "convex/values";
import { act, fireEvent, screen } from "expo-router/testing-library";
import { TextInput } from "react-native";
import { agent, decision } from "./data";
import { loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

const get = "agents/app:get";

function detail(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...agent({
      id,
      display_name: "Claude on laptop",
      topic: "acme/billing",
      state: "waiting",
      line: "Waiting for a decision on the refund flow",
      link: "https://example.com/pr/12",
      status_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      pending_decision_count: 2,
      stale: true,
    }),
    history: [
      {
        state: "working",
        line: "Writing the refund handler",
        link: null,
        at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
      {
        state: "working",
        line: "Reading the billing module",
        link: "https://example.com/notes",
        at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    ],
    pending_decisions: [
      decision({ id: "d_9", title: "Refund partial orders?", priority: "urgent" }),
      decision({ id: "d_3", title: "Keep the old endpoint?" }),
    ],
    ...overrides,
  };
}

async function openAgent(id = "a_1") {
  signInAs("sess_a");
  renderApp(`/agent/${id}`);
}

describe("agent screen", () => {
  test("shows the session's status, its pending decisions, and its history newest first", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));

    await openAgent("a_1");

    expect(await screen.findByText("Waiting for a decision on the refund flow")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: get, args: { agentSessionId: "a_1" } });
    expect(screen.getAllByText("Claude on laptop").length).toBeGreaterThan(0);
    expect(screen.getByText("acme/billing")).toBeOnTheScreen();
    expect(screen.getByText("waiting")).toBeOnTheScreen();
    expect(screen.getByText("Updated 2m ago")).toBeOnTheScreen();
    expect(screen.getByText("2 pending decisions")).toBeOnTheScreen();
    expect(screen.getByText("Stale")).toBeOnTheScreen();
    expect(screen.getByText("https://example.com/pr/12")).toBeOnTheScreen();

    const decisions = screen
      .getAllByRole("button", { name: /^Decision: / })
      .map((row) => row.props.accessibilityLabel);
    expect(decisions).toEqual([
      "Decision: Refund partial orders?",
      "Decision: Keep the old endpoint?",
    ]);

    const lines = screen
      .getAllByText(/^(Writing the refund handler|Reading the billing module)$/)
      .map((line) => line.props.children);
    expect(lines).toEqual(["Writing the refund handler", "Reading the billing module"]);
    expect(screen.getByText("10m ago")).toBeOnTheScreen();
    expect(screen.getByText("2h ago")).toBeOnTheScreen();
    expect(screen.getByText("https://example.com/notes")).toBeOnTheScreen();
  });

  // The agent card is not a button here, so the decision rows are the only
  // controls.
  test("is read-only: no text input and no control other than the decision rows", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));

    await openAgent();
    await screen.findByText("Waiting for a decision on the refund flow");

    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    const controls = screen
      .queryAllByRole("button")
      .map((button) => button.props.accessibilityLabel);
    expect(
      controls.every((label) => typeof label === "string" && label.startsWith("Decision: ")),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /send|message|reply|command/i }),
    ).not.toBeOnTheScreen();
  });

  test("a pending decision opens its decision screen", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    await openAgent();

    fireEvent.press(
      await screen.findByRole("button", { name: "Decision: Keep the old endpoint?" }),
    );

    expect(await screen.findByText("The decision view is coming soon.")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_3");
  });

  test("shows empty states for no history and no pending decisions", async () => {
    setQuery(get, (args: { agentSessionId: string }) =>
      detail(args.agentSessionId, {
        history: [],
        pending_decisions: [],
        pending_decision_count: 0,
      }),
    );

    await openAgent();

    expect(await screen.findByText("No earlier statuses.")).toBeOnTheScreen();
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
  });

  test("shows loading until the query returns", async () => {
    setQuery(get, loading);

    await openAgent();

    expect(await screen.findByText("Loading agent")).toBeOnTheScreen();
  });

  test("re-renders when the session's status changes", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    await openAgent();
    await screen.findByText("Waiting for a decision on the refund flow");

    act(() =>
      setQuery(get, (args: { agentSessionId: string }) =>
        detail(args.agentSessionId, {
          state: "done",
          line: "Refund flow merged",
          stale: false,
          pending_decisions: [],
          pending_decision_count: 0,
        }),
      ),
    );

    expect(screen.getByText("Refund flow merged")).toBeOnTheScreen();
    expect(screen.getByText("done")).toBeOnTheScreen();
    expect(screen.queryByText("Stale")).not.toBeOnTheScreen();
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
  });

  test("a missing or foreign session shows the not-found state", async () => {
    setQuery(get, new ConvexError({ code: "not_found", message: "Agent session not found" }));

    await openAgent("a_foreign");

    expect(await screen.findByText("Agent not found")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
  });

  test("a malformed session id shows the not-found state", async () => {
    setQuery(
      get,
      new ConvexError({
        code: "invalid",
        message: "Invalid agentSessionId",
        field: "agentSessionId",
      }),
    );

    await openAgent("not-an-id");

    expect(await screen.findByText("Agent not found")).toBeOnTheScreen();
  });

  test("any other failure offers a retry instead of not-found", async () => {
    setQuery(get, new Error("Network request failed"));
    await openAgent();

    expect(await screen.findByText("Could not load this agent.")).toBeOnTheScreen();
    expect(screen.queryByText("Agent not found")).not.toBeOnTheScreen();

    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Waiting for a decision on the refund flow")).toBeOnTheScreen();
  });

  test("a signed-out direct link goes to sign-in and runs no query", async () => {
    renderApp("/agent/a_1");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
    expect(queryCalls).toEqual([]);
  });
});
