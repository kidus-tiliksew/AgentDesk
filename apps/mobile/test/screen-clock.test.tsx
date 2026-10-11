import { act, render, screen } from "@testing-library/react-native";
import { AppState, type AppStateStatus, Text } from "react-native";
import { formatElapsed, useScreenClock } from "../src/use-screen-clock";

// Stands in for expo-router's useFocusEffect: the effect runs while `focus`
// is true and is cleaned up when it turns false or the component unmounts.
// The inbox tests cover the clock inside the real route tree.
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

jest.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const { useEffect, useSyncExternalStore } = require("react");
    const focused = useSyncExternalStore(mockFocus.subscribe, mockFocus.get);
    useEffect(() => (focused ? effect() : undefined), [focused, effect]);
  },
}));

describe("formatElapsed", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test.each([
    [0, "0s ago"],
    [59_999, "59s ago"],
    [60_000, "1m ago"],
    [59 * 60_000, "59m ago"],
    [3_600_000, "1h ago"],
    [23 * 3_600_000, "23h ago"],
    [24 * 3_600_000, "1d ago"],
    [9 * 24 * 3_600_000, "9d ago"],
  ])("%d ms reads %s", (ms, label) => {
    expect(formatElapsed(ago(ms), now)).toBe(label);
  });

  test("a time ahead of the device clock reads as zero", () => {
    expect(formatElapsed(ago(-30_000), now)).toBe("0s ago");
  });
});

describe("useScreenClock", () => {
  const start = Date.parse("2026-10-11T12:00:00.000Z");
  const since = new Date(start - 58_000).toISOString();
  let listeners: ((state: AppStateStatus) => void)[];
  let remove: jest.Mock;

  function Elapsed() {
    return <Text>{formatElapsed(since, useScreenClock())}</Text>;
  }

  function setAppState(state: AppStateStatus) {
    act(() => {
      for (const listener of listeners) listener(state);
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: start });
    mockFocus.set(true);
    listeners = [];
    remove = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      listeners.push(listener as (state: AppStateStatus) => void);
      return { remove };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("ticks every second while focused in the foreground", () => {
    render(<Elapsed />);
    expect(screen.getByText("58s ago")).toBeOnTheScreen();
    expect(jest.getTimerCount()).toBe(1);

    act(() => jest.advanceTimersByTime(1_000));
    expect(screen.getByText("59s ago")).toBeOnTheScreen();
    act(() => jest.advanceTimersByTime(1_000));
    expect(screen.getByText("1m ago")).toBeOnTheScreen();
  });

  test("stops while unfocused and catches up on focus", () => {
    render(<Elapsed />);

    act(() => mockFocus.set(false));
    expect(jest.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(3 * 60_000));
    expect(screen.getByText("58s ago")).toBeOnTheScreen();

    act(() => mockFocus.set(true));
    expect(screen.getByText("3m ago")).toBeOnTheScreen();
    expect(jest.getTimerCount()).toBe(1);
  });

  test("stops in the background and catches up in the foreground", () => {
    render(<Elapsed />);

    setAppState("background");
    expect(jest.getTimerCount()).toBe(0);
    act(() => jest.advanceTimersByTime(5 * 60_000));
    expect(screen.getByText("58s ago")).toBeOnTheScreen();

    setAppState("inactive");
    expect(jest.getTimerCount()).toBe(0);

    setAppState("active");
    expect(screen.getByText("5m ago")).toBeOnTheScreen();
    expect(jest.getTimerCount()).toBe(1);
  });

  test("does not start while the app is in the background", () => {
    // React Native's Jest mock defines currentState as a function, so the test
    // sets the string a device reports and restores the mock afterwards.
    const state = AppState as { currentState: unknown };
    const original = state.currentState;
    state.currentState = "background";
    try {
      render(<Elapsed />);

      expect(jest.getTimerCount()).toBe(0);
      setAppState("active");
      expect(jest.getTimerCount()).toBe(1);
    } finally {
      state.currentState = original;
    }
  });

  test("leaves no listener or timer behind on unmount", () => {
    render(<Elapsed />);
    expect(jest.getTimerCount()).toBe(1);

    screen.unmount();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
