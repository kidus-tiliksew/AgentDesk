import { ConvexError } from "convex/values";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AccessibilityInfo, AppState, type AppStateStatus, Linking, TextInput } from "react-native";
import { agent, decision } from "./data";
import { answerDecision, loading, queryCalls, setQuery, signInAs } from "./fakes";
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

afterEach(() => {
  jest.restoreAllMocks();
});

describe("agent screen", () => {
  test("shows the session's status, its pending decisions, and its history newest first", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));

    await openAgent("a_1");

    expect(await screen.findByText("Waiting for a decision on the refund flow")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: get, args: { agentSessionId: "a_1" } });
    // The status card: state, time since the update, line, name and topic,
    // the stale marker, the pending count, and the link.
    expect(screen.getByText("Waiting")).toBeOnTheScreen();
    expect(screen.getByText("2m ago")).toBeOnTheScreen();
    expect(screen.getByText("Claude on laptop · acme/billing")).toBeOnTheScreen();
    // Stale is written out, not carried by the dot's color alone.
    expect(screen.getByText("Stale")).toBeOnTheScreen();
    expect(screen.getByText("2 pending decisions")).toBeOnTheScreen();
    expect(screen.getByText("https://example.com/pr/12")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Open https://example.com/pr/12" }),
    ).toBeOnTheScreen();

    const headers = screen.getAllByRole("header").map((header) => header.props.children);
    expect(headers).toEqual(expect.arrayContaining(["Waiting on you", "Timeline"]));
    const decisions = screen
      .getAllByRole("button", { name: /^Decision: / })
      .map((row) => row.props.accessibilityLabel);
    expect(decisions).toEqual([
      "Decision: Refund partial orders?",
      "Decision: Keep the old endpoint?",
    ]);
    // Its decisions are cards like the inbox's, named for this agent.
    expect(screen.getAllByText("Claude on laptop · acme")).toHaveLength(2);
    expect(screen.getByText("Urgent")).toBeOnTheScreen();

    const lines = screen
      .getAllByText(/^(Writing the refund handler|Reading the billing module)$/)
      .map((line) => line.props.children);
    expect(lines).toEqual(["Writing the refund handler", "Reading the billing module"]);
    expect(screen.getAllByText("Working")).toHaveLength(2);
    expect(screen.getByText("10m ago")).toBeOnTheScreen();
    expect(screen.getByText("2h ago")).toBeOnTheScreen();
    expect(screen.getByText("https://example.com/notes")).toBeOnTheScreen();
  });

  test("Open link opens the agent's link", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    await openAgent();

    fireEvent.press(await screen.findByRole("button", { name: "Open https://example.com/pr/12" }));

    expect(openURL).toHaveBeenCalledWith("https://example.com/pr/12");
    openURL.mockRestore();
  });

  test("a session without a link or status shows neither", async () => {
    setQuery(get, (args: { agentSessionId: string }) =>
      detail(args.agentSessionId, { link: null, state: null, line: null, status_at: null }),
    );
    await openAgent();

    expect(await screen.findByText("No status yet")).toBeOnTheScreen();
    expect(screen.getByText("No update yet")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeOnTheScreen();
  });

  // Nothing here sends a message or command to the agent (req-agent-status
  // REQ-5). The controls are the decision cards and their answers, which
  // answer decisions as the inbox does, and the link.
  test("is read-only toward the agent: no text input and no control but decisions and the link", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));

    await openAgent();
    await screen.findByText("Waiting for a decision on the refund flow");

    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    const controls = screen
      .queryAllByRole("button")
      .map((button) => button.props.accessibilityLabel);
    expect(
      controls.every(
        (label) =>
          typeof label === "string" && /^(Decision|Approve|Reject): |^Open https:/.test(label),
      ),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /send|message|reply|command/i }),
    ).not.toBeOnTheScreen();
  });

  test("a pending decision answers from its card, with Undo first", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    answerDecision.mockResolvedValue(decision({ id: "d_3", state: "answered" }));
    const appStateListeners: ((state: AppStateStatus) => void)[] = [];
    jest.mocked(AppState.addEventListener).mockImplementation((type, listener) => {
      if (type === "change") {
        appStateListeners.push(listener as (state: AppStateStatus) => void);
      }
      return { remove: jest.fn() } as never;
    });
    await openAgent();

    const approve = await screen.findByRole("button", { name: "Approve: Keep the old endpoint?" });
    fireEvent.press(approve);

    // The card leaves the list and its count while Undo is offered.
    expect(
      screen.queryByRole("button", { name: "Decision: Keep the old endpoint?" }),
    ).not.toBeOnTheScreen();
    expect(screen.getByText("Approved “Keep the old endpoint?”")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Undo" })).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();

    // The app leaving the foreground sends the held answer at once;
    // test/inbox-undo.test.tsx covers the hold running out.
    await act(async () => {
      for (const listener of appStateListeners) listener("background");
    });

    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_3", answer: { kind: "approve" } });
  });

  test("a pending decision opens its decision screen", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    setQuery("decisions/app:get", (args: { decisionId: string }) =>
      decision({ id: args.decisionId, title: "Keep the old endpoint?", agent_session_id: "a_1" }),
    );
    await openAgent();

    fireEvent.press(
      await screen.findByRole("button", { name: "Decision: Keep the old endpoint?" }),
    );

    await waitFor(() => expect(screen).toHavePathname("/decision/d_3"));
    expect(queryCalls).toContainEqual({ name: "decisions/app:get", args: { decisionId: "d_3" } });
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
    expect(screen.getByText("0 pending decisions")).toBeOnTheScreen();
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
    expect(screen.getByText("Done")).toBeOnTheScreen();
    expect(screen.queryByText("Stale")).not.toBeOnTheScreen();
    expect(screen.getByText("No pending decisions.")).toBeOnTheScreen();
  });

  test("a pending decision answered in chat leaves the pending list when the query drops it", async () => {
    setQuery(get, (args: { agentSessionId: string }) => detail(args.agentSessionId));
    await openAgent();
    expect(
      await screen.findByRole("button", { name: "Decision: Keep the old endpoint?" }),
    ).toBeOnTheScreen();

    act(() =>
      setQuery(get, (args: { agentSessionId: string }) =>
        detail(args.agentSessionId, {
          pending_decisions: [
            decision({ id: "d_9", title: "Refund partial orders?", priority: "urgent" }),
          ],
          pending_decision_count: 1,
        }),
      ),
    );

    expect(
      screen.queryByRole("button", { name: "Decision: Keep the old endpoint?" }),
    ).not.toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Decision: Refund partial orders?" }),
    ).toBeOnTheScreen();
    expect(screen.getByText("1 pending decision")).toBeOnTheScreen();
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
    const announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => {});
    setQuery(get, new Error("Network request failed"));
    await openAgent();

    expect(await screen.findByText("Could not load this agent.")).toBeOnTheScreen();
    // VoiceOver hears the failure that replaced the screen.
    expect(announce).toHaveBeenCalledWith("Could not load this agent.");
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
