import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ConvexError } from "convex/values";
import { AccessibilityInfo, AppState, type AppStateStatus, View } from "react-native";
import type { CardDecision } from "../src/decision-row";
import { DecisionCard } from "../src/decision-row";
import { haptic } from "../src/haptics";
import { HOLD_MS, QuickAnswerScope, useQuickAnswers } from "../src/inbox-undo";
import { decision } from "./data";
import { answerDecision } from "./fakes";

// The Undo hold of one-tap answers (Apple HIG Feedback), on fake timers and
// outside the route tree. test/inbox.test.tsx covers the same scope on the
// real inbox.

// Stands in for expo-router: the focus effect runs while `focus` is true and
// is cleaned up when it turns false or the component unmounts, and the router
// records pushes.
const mockFocus = (() => {
  let focused = true;
  const listeners = new Set<() => void>();
  return {
    get: () => focused,
    set(next: boolean) {
      focused = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const { useEffect, useSyncExternalStore } = require("react");
    const focused = useSyncExternalStore(mockFocus.subscribe, mockFocus.get);
    useEffect(() => (focused ? effect() : undefined), [focused, effect]);
  },
  useRouter: () => ({ push: mockPush }),
}));

function Cards({ items }: { items: CardDecision[] }) {
  const { hidden } = useQuickAnswers();
  return (
    <View>
      {items
        .filter((item) => !hidden.has(item.id))
        .map((item) => (
          <DecisionCard key={item.id} decision={item} agentName={null} now={Date.now()} />
        ))}
    </View>
  );
}

function renderCards(items: CardDecision[]) {
  return render(
    <QuickAnswerScope>
      <Cards items={items} />
    </QuickAnswerScope>,
  );
}

const ship = decision({ id: "d_1", title: "Ship it?" });
const rename = decision({ id: "d_2", title: "Rename?" });

let appStateListeners: ((state: AppStateStatus) => void)[];

beforeEach(() => {
  // React waits for async work on setImmediate, so that stays real.
  jest.useFakeTimers({
    doNotFake: ["setImmediate", "clearImmediate", "nextTick", "queueMicrotask"],
  });
  mockFocus.set(true);
  mockPush.mockClear();
  jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockClear()
    .mockImplementation(() => {});
  jest.spyOn(haptic, "success").mockClear();
  jest.spyOn(haptic, "error").mockClear();
  answerDecision.mockImplementation(async ({ decisionId }) =>
    decision({ id: decisionId, state: "answered" }),
  );
  appStateListeners = [];
  jest.mocked(AppState.addEventListener).mockImplementation((type, listener) => {
    if (type === "change") {
      appStateListeners.push(listener as (state: AppStateStatus) => void);
    }
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// Advances the device clock and lets the answer's promise settle.
function hold(ms: number) {
  return act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function cardTitles() {
  return screen
    .queryAllByRole("button", { name: /^Decision: / })
    .map((card) => card.props.accessibilityLabel);
}

function announced() {
  return jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([text]) => text);
}

test("a held answer is sent once the hold runs out", async () => {
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
  expect(cardTitles()).toEqual([]);
  expect(screen.getByText("Approved “Ship it?”")).toBeOnTheScreen();

  await hold(HOLD_MS - 1);
  expect(answerDecision).not.toHaveBeenCalled();
  await hold(1);

  expect(answerDecision).toHaveBeenCalledTimes(1);
  expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "approve" } });
  expect(screen.queryByText("Approved “Ship it?”")).not.toBeOnTheScreen();
  // The card stays gone until the pending list drops it.
  expect(cardTitles()).toEqual([]);
  expect(haptic.success).toHaveBeenCalledTimes(1);
});

test("Undo cancels the send and restores the card", async () => {
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Reject: Ship it?" }));
  await hold(HOLD_MS - 1_000);
  fireEvent.press(screen.getByRole("button", { name: "Undo" }));

  expect(cardTitles()).toEqual(["Decision: Ship it?"]);
  expect(screen.queryByText("Rejected “Ship it?”")).not.toBeOnTheScreen();
  expect(jest.getTimerCount()).toBe(0);
  await hold(HOLD_MS * 2);
  expect(answerDecision).not.toHaveBeenCalled();
  expect(haptic.success).not.toHaveBeenCalled();
});

test("the banner is announced with its Undo", () => {
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));

  expect(announced()).toEqual(["Approved “Ship it?”. Undo available."]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeOnTheScreen();
});

test("losing focus sends the held answer at once", async () => {
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
  await act(async () => mockFocus.set(false));

  expect(answerDecision).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("unmounting sends the held answer at once", () => {
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Reject: Ship it?" }));
  screen.unmount();

  expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "reject" } });
  expect(jest.getTimerCount()).toBe(0);
});

test.each(["background", "inactive"] as const)(
  "the app going %s sends the held answer at once",
  async (state) => {
    renderCards([ship]);

    fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
    await act(async () => {
      for (const listener of appStateListeners) listener(state);
    });

    expect(answerDecision).toHaveBeenCalledTimes(1);
    await hold(HOLD_MS);
    expect(answerDecision).toHaveBeenCalledTimes(1);
  },
);

test("another one-tap answer sends the held one first and holds its own", async () => {
  renderCards([ship, rename]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Reject: Rename?" })));

  expect(answerDecision).toHaveBeenCalledTimes(1);
  expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d_1", answer: { kind: "approve" } });
  expect(screen.getByText("Rejected “Rename?”")).toBeOnTheScreen();

  await hold(HOLD_MS);
  expect(answerDecision).toHaveBeenLastCalledWith({
    decisionId: "d_2",
    answer: { kind: "reject" },
  });
});

test("a deadline within the hold sends at once, without a banner", async () => {
  renderCards([
    decision({
      id: "d_1",
      title: "Ship it?",
      deadline: new Date(Date.now() + HOLD_MS).toISOString(),
    }),
  ]);

  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" })));

  expect(answerDecision).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeOnTheScreen();
  expect(haptic.success).toHaveBeenCalledTimes(1);
});

test("a failure restores the card with its message, an error haptic, and an announcement", async () => {
  answerDecision.mockRejectedValue(new Error("Network request failed"));
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
  await hold(HOLD_MS);

  const message = "Could not send your answer. Check your connection.";
  expect(cardTitles()).toEqual(["Decision: Ship it?"]);
  expect(screen.getByText(message)).toBeOnTheScreen();
  expect(haptic.error).toHaveBeenCalledTimes(1);
  expect(haptic.success).not.toHaveBeenCalled();
  expect(announced()).toContain(message);
  expect(mockPush).not.toHaveBeenCalled();
});

test("a decision settled elsewhere opens the decision screen while the screen is in focus", async () => {
  const settled = decision({ id: "d_1", state: "answered", answer: { kind: "reject" } });
  answerDecision.mockRejectedValue(
    new ConvexError({ code: "conflict", message: "Decision already settled", decision: settled }),
  );
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
  await hold(HOLD_MS);

  expect(mockPush).toHaveBeenCalledWith({ pathname: "/decision/[id]", params: { id: "d_1" } });
  expect(haptic.error).not.toHaveBeenCalled();
});

test("a decision settled elsewhere does not pull a person back who has left the screen", async () => {
  const settled = decision({ id: "d_1", state: "answered", answer: { kind: "reject" } });
  answerDecision.mockRejectedValue(
    new ConvexError({ code: "conflict", message: "Decision already settled", decision: settled }),
  );
  renderCards([ship]);

  fireEvent.press(screen.getByRole("button", { name: "Approve: Ship it?" }));
  await act(async () => mockFocus.set(false));

  expect(answerDecision).toHaveBeenCalledTimes(1);
  expect(mockPush).not.toHaveBeenCalled();
});
