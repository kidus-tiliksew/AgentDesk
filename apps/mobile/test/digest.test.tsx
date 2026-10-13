import { ConvexError } from "convex/values";
import { router } from "expo-router";
import { act, fireEvent, screen } from "expo-router/testing-library";
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
  StyleSheet,
  TextInput,
} from "react-native";
import type { Digest, DigestDecision, DigestEvent } from "../../../convex/notifications/digests";
import { agent, decision } from "./data";
import {
  answerDecision,
  clerkLoadedSignedOut,
  loading,
  queryCalls,
  setQuery,
  signInAs,
} from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens, digest: the screen a digest push opens
// (req-mobile-app REQ-4; req-notification-rules AC-6.3).

const get = "notifications/digests:get";

// The text size the window reports; the stat tile test raises it.
let mockFontScale = 1;
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({ width: 393, height: 852, scale: 3, fontScale: mockFontScale }),
}));

afterEach(() => {
  mockFontScale = 1;
  jest.restoreAllMocks();
});
const SENT_AT = "2026-10-12T09:00:00.000Z";

function pendingDecision(
  overrides: Partial<DigestDecision> & Pick<DigestDecision, "id">,
): DigestDecision {
  return {
    topic: "acme",
    title: `Decision ${overrides.id}`,
    priority: "normal",
    deadline: null,
    state: "pending",
    answer: null,
    answered_at: null,
    answered_via: null,
    chat_message: null,
    applied_by_default: false,
    agent_session_id: "a_1",
    agent_name: "Claude on laptop",
    created_at: "2026-10-11T22:00:00.000Z",
    ...overrides,
  };
}

function digestEvent(overrides: Partial<DigestEvent> & Pick<DigestEvent, "id">): DigestEvent {
  return {
    kind: "decision.expired",
    topic: "acme",
    occurred_at: "2026-10-12T02:30:00.000Z",
    action: "digest",
    decision_id: null,
    agent_session_id: null,
    decision_title: null,
    agent_name: null,
    ...overrides,
  };
}

function digest(id: string, overrides: Partial<Digest> = {}): Digest {
  return {
    id,
    sent_at: SENT_AT,
    // The backend's order, which the screen keeps: urgent first here, and
    // neither by id nor by title.
    pending_decisions: [
      pendingDecision({ id: "d_9", title: "Refund partial orders?", priority: "urgent" }),
      pendingDecision({ id: "d_3", title: "Keep the old endpoint?" }),
      pendingDecision({ id: "d_5", title: "Archive the logs?" }),
    ],
    events: [
      digestEvent({
        id: "ev_1",
        kind: "decision.expired",
        topic: "acme/billing",
        decision_id: "d_2",
        agent_session_id: "a_1",
        decision_title: "Ship on Friday?",
        agent_name: "Claude on laptop",
      }),
      digestEvent({
        id: "ev_2",
        kind: "agent.done",
        topic: null,
        occurred_at: "2026-10-12T03:15:00.000Z",
        agent_session_id: "a_2",
        agent_name: "Codex on desktop",
      }),
    ],
    ...overrides,
  };
}

function serveDestinations() {
  setQuery("decisions/app:get", (args: { decisionId: string }) =>
    decision({ id: args.decisionId, title: `Opened ${args.decisionId}` }),
  );
  setQuery("agents/app:get", (args: { agentSessionId: string }) => ({
    ...agent({ id: args.agentSessionId, display_name: `Agent ${args.agentSessionId}` }),
    line: `Status of ${args.agentSessionId}`,
    history: [],
    pending_decisions: [],
  }));
}

async function openDigest(id = "dg_1") {
  signInAs("sess_a");
  renderApp(`/digest/${id}`);
}

function buttonLabels() {
  return screen.queryAllByRole("button").map((button) => button.props.accessibilityLabel);
}

describe("digest screen", () => {
  beforeEach(() => serveDestinations());

  test("lists the pending decisions in the backend's order before the events", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));

    await openDigest("dg_1");

    expect(await screen.findByText("Refund partial orders?")).toBeOnTheScreen();
    expect(queryCalls).toContainEqual({ name: get, args: { digestId: "dg_1" } });
    expect(buttonLabels()).toEqual([
      "Decision: Refund partial orders?, Pending",
      "Decision: Keep the old endpoint?, Pending",
      "Decision: Archive the logs?, Pending",
      "Event: Decision expired, Ship on Friday?",
      "Event: Agent done, Codex on desktop",
    ]);
    const headings = screen.getAllByRole("header").map((heading) => heading.props.children);
    expect(headings).toEqual(["While you were away", "Waiting on you", "Events"]);
    expect(screen.getByText("Urgent")).toBeOnTheScreen();
    expect(screen.getAllByText("Claude on laptop · acme")).toHaveLength(3);
    expect(screen.getByLabelText("3 Waiting on you")).toBeOnTheScreen();
    expect(screen.getByLabelText("0 Answered")).toBeOnTheScreen();
    expect(screen.getByLabelText("0 Closed")).toBeOnTheScreen();
  });

  test("shows the send time and each event time in the device's locale and time zone", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));

    await openDigest();

    const sent = new Date(SENT_AT);
    const day = sent.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const time = sent.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(await screen.findByText(`${day} · ${time}`)).toBeOnTheScreen();
    expect(
      screen.getByText(new Date("2026-10-12T02:30:00.000Z").toLocaleString()),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(new Date("2026-10-12T03:15:00.000Z").toLocaleString()),
    ).toBeOnTheScreen();
  });

  test("shows each event's kind, topic, and routed action", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));

    await openDigest();

    expect(await screen.findByText("Decision expired")).toBeOnTheScreen();
    expect(screen.getByText("Agent done")).toBeOnTheScreen();
    expect(screen.getByText("acme/billing")).toBeOnTheScreen();
    expect(screen.getAllByText("Digest", { exact: true }).length).toBeGreaterThanOrEqual(2);
  });

  test("a decision settled since the send shows its current state", async () => {
    setQuery(get, (args: { digestId: string }) =>
      digest(args.digestId, {
        events: [],
        pending_decisions: [
          pendingDecision({
            id: "d_1",
            title: "Still open?",
            deadline: new Date(Date.now() + 30 * 60_000 + 30_000).toISOString(),
          }),
          pendingDecision({
            id: "d_2",
            title: "Answered later?",
            state: "answered",
            answer: { kind: "approve" },
            answered_at: "2026-10-12T09:30:00.000Z",
          }),
          pendingDecision({ id: "d_3", title: "Ran out of time?", state: "expired" }),
          pendingDecision({ id: "d_4", title: "Withdrawn?", state: "cancelled" }),
          pendingDecision({
            id: "d_5",
            title: "Defaulted?",
            state: "answered",
            applied_by_default: true,
          }),
        ],
      }),
    );

    await openDigest();

    expect(await screen.findByText("Still open?")).toBeOnTheScreen();
    expect(buttonLabels()).toEqual([
      "Decision: Still open?, Pending",
      "Decision: Answered later?, Answered",
      "Decision: Ran out of time?, Expired",
      "Decision: Withdrawn?, Cancelled",
      "Decision: Defaulted?, Answered by default",
    ]);
    // Only the pending decision shows a deadline; the rest show outcomes.
    expect(screen.getAllByText(/left$/)).toHaveLength(1);
    expect(screen.getByText("30m left")).toBeOnTheScreen();
    expect(screen.getByText("Answered by default")).toBeOnTheScreen();
    expect(screen.getByLabelText("1 Waiting on you")).toBeOnTheScreen();
    expect(screen.getByLabelText("2 Answered")).toBeOnTheScreen();
    expect(screen.getByLabelText("2 Closed")).toBeOnTheScreen();
    const headings = screen.getAllByRole("header").map((heading) => heading.props.children);
    expect(headings).toEqual(["While you were away", "Waiting on you", "Settled since", "Events"]);
  });

  test("re-renders when a decision settles while the screen is open", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    await openDigest();
    await screen.findByRole("button", { name: "Decision: Keep the old endpoint?, Pending" });

    act(() =>
      setQuery(get, (args: { digestId: string }) => {
        const base = digest(args.digestId);
        return {
          ...base,
          pending_decisions: base.pending_decisions.map((item) =>
            item.id === "d_3" ? { ...item, state: "answered" } : item,
          ),
        };
      }),
    );

    expect(
      screen.getByRole("button", { name: "Decision: Keep the old endpoint?, Answered" }),
    ).toBeOnTheScreen();
    // It moves from Waiting on you to Settled since.
    expect(buttonLabels().slice(0, 3)).toEqual([
      "Decision: Refund partial orders?, Pending",
      "Decision: Archive the logs?, Pending",
      "Decision: Keep the old endpoint?, Answered",
    ]);
    expect(screen.getByLabelText("1 Answered")).toBeOnTheScreen();
  });

  test("a decision row opens its decision screen", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    await openDigest();

    fireEvent.press(
      await screen.findByRole("button", { name: "Decision: Keep the old endpoint?, Pending" }),
    );

    expect(await screen.findByText("Opened d_3")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_3");
  });

  test("a decision still pending answers in place like the inbox's", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    setQuery("decisions/app:listPending", [
      decision({
        id: "d_3",
        title: "Keep the old endpoint?",
        recommendation: { kind: "reject" },
      }),
    ]);
    answerDecision.mockResolvedValue(decision({ id: "d_3", state: "answered" }));
    const appStateListeners: ((state: AppStateStatus) => void)[] = [];
    jest.mocked(AppState.addEventListener).mockImplementation((type, listener) => {
      if (type === "change") {
        appStateListeners.push(listener as (state: AppStateStatus) => void);
      }
      return { remove: jest.fn() } as never;
    });
    await openDigest();

    const reject = await screen.findByRole("button", { name: "Reject: Keep the old endpoint?" });
    expect(reject.props.accessibilityHint).toBe("Recommended by the agent");
    // The sparkles on the recommended button shows the recommendation; the
    // card's VoiceOver value names it.
    expect(screen.queryByText("Recommends Reject")).not.toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Decision: Keep the old endpoint?, Pending" }).props
        .accessibilityValue.text,
    ).toMatch(/Recommends Reject$/);
    // A decision the pending list does not hold has no one-tap answer.
    expect(
      screen.queryByRole("button", { name: "Approve: Refund partial orders?" }),
    ).not.toBeOnTheScreen();

    fireEvent.press(reject);

    // The card leaves while Undo is offered; nothing is sent yet.
    expect(
      screen.queryByRole("button", { name: "Decision: Keep the old endpoint?, Pending" }),
    ).not.toBeOnTheScreen();
    expect(screen.getByText("Rejected “Keep the old endpoint?”")).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();

    // The app leaving the foreground sends the held answer at once;
    // test/inbox-undo.test.tsx covers the hold running out.
    await act(async () => {
      for (const listener of appStateListeners) listener("background");
    });

    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_3", answer: { kind: "reject" } });
  });

  test("Undo puts a digest card back", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    setQuery("decisions/app:listPending", [
      decision({ id: "d_3", title: "Keep the old endpoint?" }),
    ]);
    await openDigest();

    fireEvent.press(await screen.findByRole("button", { name: "Approve: Keep the old endpoint?" }));
    fireEvent.press(screen.getByRole("button", { name: "Undo" }));

    expect(
      screen.getByRole("button", { name: "Decision: Keep the old endpoint?, Pending" }),
    ).toBeOnTheScreen();
    expect(answerDecision).not.toHaveBeenCalled();
  });

  test("the stat tiles stack at large text sizes and have no fixed height", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    await openDigest();
    const tile = await screen.findByLabelText("3 Waiting on you");
    const row = () => {
      let node = screen.getByLabelText("3 Waiting on you").parent;
      while (node !== null && typeof node.type !== "string") {
        node = node.parent;
      }
      return StyleSheet.flatten(node?.props.style);
    };
    expect(StyleSheet.flatten(tile.props.style).height).toBeUndefined();
    expect(row().flexDirection).toBe("row");

    mockFontScale = 1.5;
    act(() => setQuery(get, (args: { digestId: string }) => digest(args.digestId)));
    expect(row().flexDirection).toBe("column");
  });

  test("an event with a decision and an agent opens the decision", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    await openDigest();

    fireEvent.press(
      await screen.findByRole("button", { name: "Event: Decision expired, Ship on Friday?" }),
    );

    expect(await screen.findByText("Opened d_2")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_2");
  });

  test("an event with only an agent opens the agent", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    await openDigest();

    fireEvent.press(
      await screen.findByRole("button", { name: "Event: Agent done, Codex on desktop" }),
    );

    expect(await screen.findByText("Status of a_2")).toBeOnTheScreen();
    expect(screen).toHavePathname("/agent/a_2");
  });

  test("an event whose decision is gone opens its agent and says the decision is unavailable", async () => {
    setQuery(get, (args: { digestId: string }) =>
      digest(args.digestId, {
        pending_decisions: [],
        events: [
          digestEvent({
            id: "ev_1",
            kind: "decision.expired",
            decision_id: "d_gone",
            agent_session_id: "a_1",
            decision_title: null,
            agent_name: "Claude on laptop",
          }),
        ],
      }),
    );
    await openDigest();

    expect(await screen.findByText("Decision unavailable")).toBeOnTheScreen();
    fireEvent.press(
      screen.getByRole("button", { name: "Event: Decision expired, Claude on laptop" }),
    );

    expect(await screen.findByText("Status of a_1")).toBeOnTheScreen();
    expect(screen).toHavePathname("/agent/a_1");
  });

  test("an event without an available target is a readable row with no action", async () => {
    setQuery(get, (args: { digestId: string }) =>
      digest(args.digestId, {
        pending_decisions: [],
        events: [
          digestEvent({
            id: "ev_1",
            kind: "decision.expired",
            topic: "acme/gone",
            decision_id: "d_gone",
            decision_title: null,
          }),
          digestEvent({
            id: "ev_2",
            kind: "agent.done",
            topic: "acme/ended",
            agent_session_id: "a_gone",
            agent_name: "Ended agent",
          }),
          digestEvent({ id: "ev_3", kind: "agent.stale", topic: "acme/none" }),
        ],
      }),
    );

    await openDigest();

    expect(await screen.findByText("acme/gone")).toBeOnTheScreen();
    expect(screen.getByText("Decision unavailable")).toBeOnTheScreen();
    expect(screen.getByText("Ended agent")).toBeOnTheScreen();
    expect(screen.getByText("Agent stale")).toBeOnTheScreen();
    expect(screen.getByLabelText("Event: Decision expired")).toBeOnTheScreen();
    expect(screen.getByLabelText("Event: Agent done")).toBeOnTheScreen();
    expect(screen.getByLabelText("Event: Agent stale")).toBeOnTheScreen();
    expect(buttonLabels()).toEqual([]);
  });

  test("is read-only: no text input", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));

    await openDigest();
    await screen.findByText("Refund partial orders?");

    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
  });

  test("shows a distinct empty message for each empty section", async () => {
    setQuery(get, (args: { digestId: string }) =>
      digest(args.digestId, { pending_decisions: [], events: [] }),
    );

    await openDigest();

    expect(await screen.findByText("No decisions were pending.")).toBeOnTheScreen();
    expect(screen.queryByRole("header", { name: "Settled since" })).not.toBeOnTheScreen();
    expect(screen.getByText("No events in this digest.")).toBeOnTheScreen();
  });

  test("shows loading until the query returns", async () => {
    setQuery(get, loading);

    await openDigest();

    expect(await screen.findByText("Loading digest")).toBeOnTheScreen();
  });

  test("a missing or foreign digest shows the not-found state", async () => {
    setQuery(get, new ConvexError({ code: "not_found", message: "Digest not found" }));

    await openDigest("dg_foreign");

    expect(await screen.findByText("Digest not found")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
  });

  test("a digest id the backend refuses as invalid shows the not-found state", async () => {
    setQuery(
      get,
      new ConvexError({ code: "invalid", message: "Invalid digestId", field: "digestId" }),
    );

    await openDigest("not_a_digest");

    expect(await screen.findByText("Digest not found")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeOnTheScreen();
  });

  test("a malformed route id shows the not-found state without a query", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));

    await openDigest("a".repeat(129));

    expect(await screen.findByText("Digest not found")).toBeOnTheScreen();
    expect(queryCalls.map((call) => call.name)).not.toContain(get);
  });

  test("any other failure offers a retry, and a retry that succeeds shows the digest", async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => {});
    setQuery(get, new Error("Network request failed"));
    await openDigest();

    expect(await screen.findByText("Could not load this digest.")).toBeOnTheScreen();
    // VoiceOver hears the failure that replaced the screen.
    expect(announce).toHaveBeenCalledWith("Could not load this digest.");
    expect(screen.queryByText("Digest not found")).not.toBeOnTheScreen();

    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Refund partial orders?")).toBeOnTheScreen();
  });

  test("a new digest id clears an earlier failure", async () => {
    setQuery(get, (args: { digestId: string }) => {
      if (args.digestId === "dg_bad") {
        throw new Error("Network request failed");
      }
      return digest(args.digestId, {
        pending_decisions: [pendingDecision({ id: "d_1", title: `From ${args.digestId}` })],
      });
    });
    await openDigest("dg_bad");
    expect(await screen.findByText("Could not load this digest.")).toBeOnTheScreen();

    act(() => router.setParams({ id: "dg_good" }));

    expect(await screen.findByText("From dg_good")).toBeOnTheScreen();
    expect(screen.queryByText("Could not load this digest.")).not.toBeOnTheScreen();
  });

  test("a signed-out direct link goes to sign-in without a digest query", async () => {
    setQuery(get, (args: { digestId: string }) => digest(args.digestId));
    clerkLoadedSignedOut();

    renderApp("/digest/dg_1");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(queryCalls.map((call) => call.name)).not.toContain(get);
  });
});
