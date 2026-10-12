import { type Decision, topicMatches } from "@agentdesk/contract";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import { useState, useSyncExternalStore } from "react";
import { INVALID_TOPIC } from "../src/history-filters";
import { decision } from "./data";
import { deferred, loading, queries, queryCalls, readQuery, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens, history: search over settled decisions with
// state and topic filters, cursor pagination, and deletion after a
// confirmation (req-mobile-app REQ-6, AC-6.1, AC-6.2).

const search = "decisions/app:searchHistory";
const removeName = "decisions/app:remove";
const get = "decisions/app:get";

type Item = { decision: Decision; settled_at: string };
type Page = { page: Item[]; isDone: boolean; continueCursor: string };
type SearchArgs = {
  query?: string;
  state?: string;
  topic?: string;
  paginationOpts: { numItems: number; cursor: string | null };
};

// A file-local usePaginatedQuery with the Convex hook's contract: the first
// page is requested with a null cursor, each loadMore requests the last
// page's continueCursor once, every loaded page stays subscribed to the
// scripted query results, and new arguments start again from the first page.
// The shared convex/react fake has no paginated hook, so this file adds one.
type Request = { cursor: string | null; numItems: number };
function useFakePaginatedQuery(
  reference: unknown,
  args: Record<string, unknown>,
  options: { initialNumItems: number },
) {
  const name = getFunctionName(reference as never);
  useSyncExternalStore(queries.subscribe, queries.get);
  const key = JSON.stringify(args);
  const [state, setState] = useState<{ key: string; more: Request[] }>({ key, more: [] });
  const requests: Request[] = [
    { cursor: null, numItems: options.initialNumItems },
    ...(state.key === key ? state.more : []),
  ];
  const results: Item[] = [];
  let status: "LoadingFirstPage" | "LoadingMore" | "CanLoadMore" | "Exhausted" = "CanLoadMore";
  let next = "";
  for (const [index, request] of requests.entries()) {
    const page = readQuery(name, { ...args, paginationOpts: request }) as Page | undefined;
    if (page === undefined) {
      status = index === 0 ? "LoadingFirstPage" : "LoadingMore";
      break;
    }
    results.push(...page.page);
    if (page.isDone) {
      status = "Exhausted";
      break;
    }
    next = page.continueCursor;
  }
  let requested = false;
  const loadMore = (numItems: number) => {
    if (status !== "CanLoadMore" || requested) {
      return;
    }
    requested = true;
    const more = requests.slice(1);
    setState({ key, more: [...more, { cursor: next, numItems }] });
  };
  return { results, status, isLoading: status.startsWith("Loading"), loadMore };
}

// The shared convex/react fake refuses mutations it does not know. This file
// wraps its useMutation, so `remove` gets a local mock and every other
// mutation keeps the shared fake. `removeBinds` counts renders that bound it.
const mockRemove = jest.fn<Promise<null>, [{ decisionId: string }]>();
let removeBinds = 0;
type ConvexReactMock = {
  useMutation: (reference: unknown) => unknown;
  usePaginatedQuery?: unknown;
};

beforeEach(() => {
  mockRemove.mockReset().mockResolvedValue(null);
  removeBinds = 0;
  const convexReact = jest.requireMock<ConvexReactMock>("convex/react");
  const sharedUseMutation = convexReact.useMutation;
  jest.spyOn(convexReact, "useMutation").mockImplementation((reference: unknown) => {
    if (getFunctionName(reference as never) === removeName) {
      removeBinds += 1;
      return mockRemove;
    }
    return sharedUseMutation(reference);
  });
  convexReact.usePaginatedQuery = useFakePaginatedQuery;
});

afterEach(() => {
  jest.restoreAllMocks();
  delete jest.requireMock<ConvexReactMock>("convex/react").usePaginatedQuery;
});

const SETTLED = "2026-10-11T12:00:00.000Z";

function settled(overrides: Partial<Decision> & Pick<Decision, "id">, settledAt = SETTLED): Item {
  return {
    decision: decision({
      state: "answered",
      answer: { kind: "approve" },
      answered_at: settledAt,
      answered_via: "app",
      ...overrides,
    }),
    settled_at: settledAt,
  };
}

// A backend stand-in for searchHistory over `items` in the given order. It
// filters by state and topic with the contract's topicMatches, and by text
// against titles, which is enough to tell result sets apart; the backend owns
// the real matching. The cursor is the index of the next row. `pageSize`
// overrides the requested page size.
function serveHistory(items: Item[], { pageSize }: { pageSize?: number } = {}) {
  setQuery(search, (args: SearchArgs): Page => {
    const rows = items.filter(
      ({ decision: d }) =>
        (args.state === undefined || d.state === args.state) &&
        (args.topic === undefined || topicMatches(args.topic, d.topic)) &&
        (args.query === undefined || d.title.toLowerCase().includes(args.query.toLowerCase())),
    );
    const start = args.paginationOpts.cursor === null ? 0 : Number(args.paginationOpts.cursor);
    const page = rows.slice(start, start + (pageSize ?? args.paginationOpts.numItems));
    const end = start + page.length;
    return { page, isDone: end >= rows.length, continueCursor: String(end) };
  });
}

function searchCalls(): SearchArgs[] {
  return queryCalls.filter((call) => call.name === search).map((call) => call.args as SearchArgs);
}

// The distinct filter arguments the screen has sent, without pagination.
function sentFilters() {
  const seen = new Map<string, Omit<SearchArgs, "paginationOpts">>();
  for (const { paginationOpts: _page, ...filters } of searchCalls()) {
    seen.set(JSON.stringify(filters), filters);
  }
  return [...seen.values()];
}

function rowTitles() {
  return screen
    .queryAllByRole("button", { name: /^Decision: / })
    .map((row) => row.props.accessibilityLabel.replace(/^Decision: /, ""));
}

async function openHistory() {
  signInAs("sess_a");
  renderApp("/history");
  await act(async () => {});
  act(() => jest.advanceTimersByTime(0));
}

const ship = settled({ id: "d_ship", title: "Ship the release?", topic: "acme" });
const billing = settled({ id: "d_billing", title: "Refund policy?", topic: "acme/billing" });
const corp = settled({ id: "d_corp", title: "Rename the corp?", topic: "acmecorp" });

describe("navigation", () => {
  test("the inbox header opens history", async () => {
    serveHistory([ship]);
    signInAs("sess_a");
    renderApp("/");
    await screen.findByText("No pending decisions.");

    fireEvent.press(screen.getByText("History"));

    expect(await screen.findByText("Ship the release?")).toBeOnTheScreen();
    expect(screen).toHavePathname("/history");
  });

  test("a row opens its decision", async () => {
    serveHistory([ship, billing]);
    setQuery(get, (args: { decisionId: string }) =>
      args.decisionId === billing.decision.id
        ? billing.decision
        : new ConvexError({ code: "not_found", message: "Decision not found" }),
    );
    await openHistory();

    fireEvent.press(screen.getByRole("button", { name: "Decision: Refund policy?" }));

    expect(await screen.findByLabelText("Recorded outcome")).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_billing");
  });
});

describe("rows", () => {
  test("each row shows title, topic, state, settlement time, and the answer summary", async () => {
    const options = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ];
    const answered = settled(
      {
        id: "d_1",
        title: "Pick one",
        topic: "acme/billing",
        input_type: "single_choice",
        options,
        answer: { kind: "option", option_id: "b" },
      },
      "2026-10-10T08:15:00.000Z",
    );
    const defaulted = settled(
      {
        id: "d_2",
        title: "Defaulted",
        state: "expired",
        answer: { kind: "reject" },
        applied_by_default: true,
        answered_via: null,
      },
      "2026-10-09T07:00:00.000Z",
    );
    const lapsed = settled(
      { id: "d_3", title: "Lapsed", state: "expired", answer: null, answered_at: null },
      "2026-10-08T06:00:00.000Z",
    );
    const cancelled = settled(
      { id: "d_4", title: "Withdrawn", state: "cancelled", answer: null, answered_at: null },
      "2026-10-07T05:00:00.000Z",
    );
    serveHistory([answered, defaulted, lapsed, cancelled]);

    await openHistory();

    expect(rowTitles()).toEqual(["Pick one", "Defaulted", "Lapsed", "Withdrawn"]);
    const first = within(screen.getByRole("button", { name: "Decision: Pick one" }));
    expect(first.getByText("acme/billing")).toBeOnTheScreen();
    expect(first.getByText("Answered")).toBeOnTheScreen();
    expect(
      first.getByText(`Settled ${new Date("2026-10-10T08:15:00.000Z").toLocaleString()}`),
    ).toBeOnTheScreen();
    expect(first.getByText("Answer: Beta")).toBeOnTheScreen();
    const second = within(screen.getByRole("button", { name: "Decision: Defaulted" }));
    expect(second.getByText("Expired")).toBeOnTheScreen();
    expect(second.getByText("Default applied: Reject")).toBeOnTheScreen();
    // Expired and cancelled rows show their own settlement instant, which the
    // Decision read shape does not carry.
    const third = within(screen.getByRole("button", { name: "Decision: Lapsed" }));
    expect(third.getByText("Expired without an answer")).toBeOnTheScreen();
    expect(
      third.getByText(`Settled ${new Date("2026-10-08T06:00:00.000Z").toLocaleString()}`),
    ).toBeOnTheScreen();
    const fourth = within(screen.getByRole("button", { name: "Decision: Withdrawn" }));
    expect(fourth.getByText("Cancelled")).toBeOnTheScreen();
    expect(fourth.getByText("No answer was recorded.")).toBeOnTheScreen();
    expect(
      fourth.getByText(`Settled ${new Date("2026-10-07T05:00:00.000Z").toLocaleString()}`),
    ).toBeOnTheScreen();
  });
});

describe("search", () => {
  test("text reaches the search after 300 ms without a query per keystroke", async () => {
    serveHistory([ship, billing]);
    await openHistory();
    expect(sentFilters()).toEqual([{}]);

    const field = screen.getByLabelText("Search history");
    for (const text of ["r", "re", "ref", "refu"]) {
      fireEvent.changeText(field, text);
      act(() => jest.advanceTimersByTime(100));
    }
    fireEvent.changeText(field, "refund");
    act(() => jest.advanceTimersByTime(299));

    expect(sentFilters()).toEqual([{}]);
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);

    act(() => jest.advanceTimersByTime(1));
    await act(async () => {});

    expect(sentFilters()).toEqual([{}, { query: "refund" }]);
    expect(rowTitles()).toEqual(["Refund policy?"]);
  });

  test("whitespace around the text is trimmed and blank text sends no query", async () => {
    serveHistory([ship]);
    await openHistory();

    fireEvent.changeText(screen.getByLabelText("Search history"), "  ship  ");
    act(() => jest.advanceTimersByTime(300));
    fireEvent.changeText(screen.getByLabelText("Search history"), "   ");
    act(() => jest.advanceTimersByTime(300));

    expect(sentFilters()).toEqual([{}, { query: "ship" }]);
  });

  test("the state filter sends the state at once and All states clears it", async () => {
    const expired = settled({ id: "d_e", title: "Lapsed", state: "expired", answer: null });
    const cancelled = settled({ id: "d_c", title: "Withdrawn", state: "cancelled", answer: null });
    serveHistory([ship, expired, cancelled]);
    await openHistory();
    expect(screen.queryByRole("button", { name: "State: Pending" })).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "State: Expired" }));

    expect(rowTitles()).toEqual(["Lapsed"]);
    expect(screen.getByRole("button", { name: "State: Expired" })).toBeSelected();

    fireEvent.press(screen.getByRole("button", { name: "State: Cancelled" }));
    expect(rowTitles()).toEqual(["Withdrawn"]);

    fireEvent.press(screen.getByRole("button", { name: "State: Answered" }));
    expect(rowTitles()).toEqual(["Ship the release?"]);

    fireEvent.press(screen.getByRole("button", { name: "All states" }));
    expect(rowTitles()).toEqual(["Ship the release?", "Lapsed", "Withdrawn"]);
    expect(sentFilters()).toEqual([
      {},
      { state: "expired" },
      { state: "cancelled" },
      { state: "answered" },
    ]);
  });

  test("an applied topic keeps its subtopics and drops a longer name", async () => {
    serveHistory([ship, billing, corp]);
    await openHistory();
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?", "Rename the corp?"]);

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme");
    fireEvent.press(screen.getByRole("button", { name: "Apply topic" }));

    expect(sentFilters()).toContainEqual({ topic: "acme" });
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);
    expect(screen.getByRole("button", { name: "Topic: acme" })).toBeSelected();
  });

  test("an applied topic is normalized and offers its parent prefixes as chips", async () => {
    serveHistory([ship, billing, corp]);
    await openHistory();

    fireEvent.changeText(screen.getByLabelText("Topic"), " Acme/Billing ");
    fireEvent.press(screen.getByRole("button", { name: "Apply topic" }));

    expect(rowTitles()).toEqual(["Refund policy?"]);
    expect(screen.getByRole("button", { name: "Topic: acme/billing" })).toBeSelected();

    fireEvent.press(screen.getByRole("button", { name: "Topic: acme" }));
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);

    fireEvent.press(screen.getByRole("button", { name: "All topics" }));
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?", "Rename the corp?"]);
    // The chips stay after an empty result or a cleared filter.
    expect(screen.getByRole("button", { name: "Topic: acme/billing" })).toBeOnTheScreen();
    expect(sentFilters()).toEqual([{}, { topic: "acme/billing" }, { topic: "acme" }]);
  });

  test("an invalid topic shows the rule and sends no query", async () => {
    serveHistory([ship]);
    await openHistory();
    expect(screen.getByRole("button", { name: "Apply topic" })).toBeDisabled();

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme corp");
    fireEvent.press(screen.getByRole("button", { name: "Apply topic" }));

    expect(screen.getByText(INVALID_TOPIC)).toBeOnTheScreen();
    expect(sentFilters()).toEqual([{}]);

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme");
    expect(screen.queryByText(INVALID_TOPIC)).toBeNull();
  });
});

describe("pagination", () => {
  const five = ["1", "2", "3", "4", "5"].map((n) =>
    settled({ id: `d_${n}`, title: `Decision ${n}`, topic: "acme" }),
  );

  test("Load more forwards the continuation cursor and stops at the end", async () => {
    serveHistory(five, { pageSize: 2 });
    await openHistory();

    expect(rowTitles()).toEqual(["Decision 1", "Decision 2"]);
    expect(searchCalls()[0]?.paginationOpts).toEqual({ numItems: 20, cursor: null });

    fireEvent.press(screen.getByRole("button", { name: "Load more" }));
    expect(rowTitles()).toEqual(["Decision 1", "Decision 2", "Decision 3", "Decision 4"]);
    expect(searchCalls()).toContainEqual({ paginationOpts: { numItems: 20, cursor: "2" } });

    fireEvent.press(screen.getByRole("button", { name: "Load more" }));
    expect(rowTitles()).toEqual([
      "Decision 1",
      "Decision 2",
      "Decision 3",
      "Decision 4",
      "Decision 5",
    ]);
    expect(searchCalls()).toContainEqual({ paginationOpts: { numItems: 20, cursor: "4" } });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.queryByText("No settled decisions.")).toBeNull();
  });

  test("Load more requests one page while it loads and disables itself", async () => {
    const first: Page = { page: five.slice(0, 2), isDone: false, continueCursor: "c2" };
    const second: Page = { page: five.slice(2, 4), isDone: true, continueCursor: "c4" };
    let secondReady = false;
    setQuery(search, (args: SearchArgs) =>
      args.paginationOpts.cursor === null ? first : secondReady ? second : loading,
    );
    await openHistory();

    const more = screen.getByRole("button", { name: "Load more" });
    fireEvent.press(more);
    fireEvent.press(screen.getByRole("button", { name: "Loading more" }));

    expect(screen.getByRole("button", { name: "Loading more" })).toBeDisabled();
    const cursors = new Set(searchCalls().map((call) => call.paginationOpts.cursor));
    expect([...cursors]).toEqual([null, "c2"]);
    expect(rowTitles()).toEqual(["Decision 1", "Decision 2"]);

    secondReady = true;
    act(() => queries.set({}));

    expect(rowTitles()).toEqual(["Decision 1", "Decision 2", "Decision 3", "Decision 4"]);
    expect(screen.queryByRole("button", { name: /^Load(ing)? more$/ })).toBeNull();
  });

  test("an empty page with a continuation cursor is not the end", async () => {
    const pages: Record<string, Page> = {
      start: { page: [], isDone: false, continueCursor: "c1" },
      c1: { page: five.slice(0, 1), isDone: true, continueCursor: "c2" },
    };
    setQuery(search, (args: SearchArgs) => pages[args.paginationOpts.cursor ?? "start"] as Page);
    await openHistory();

    expect(screen.queryByText("No settled decisions.")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Load more" }));

    expect(rowTitles()).toEqual(["Decision 1"]);
  });

  test("a new input starts from the first page and never shows the old rows", async () => {
    serveHistory(five, { pageSize: 2 });
    await openHistory();
    fireEvent.press(screen.getByRole("button", { name: "Load more" }));
    expect(rowTitles()).toHaveLength(4);

    const answeredOnly = (args: SearchArgs) => args.state === "answered";
    const before = searchCalls().length;
    const script = queries.get()[search] as (args: SearchArgs) => Page;
    act(() =>
      setQuery(search, (args: SearchArgs) => (answeredOnly(args) ? loading : script(args))),
    );
    fireEvent.press(screen.getByRole("button", { name: "State: Answered" }));

    expect(screen.getByText("Loading history")).toBeOnTheScreen();
    expect(rowTitles()).toEqual([]);
    const fresh = searchCalls().slice(before).filter(answeredOnly);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((call) => call.paginationOpts.cursor === null)).toBe(true);

    act(() => serveHistory(five, { pageSize: 2 }));
    expect(rowTitles()).toEqual(["Decision 1", "Decision 2"]);
  });

  test("loaded pages follow live changes without duplicate rows", async () => {
    serveHistory(five, { pageSize: 2 });
    await openHistory();
    fireEvent.press(screen.getByRole("button", { name: "Load more" }));

    // A row moved between pages appears once, at its first position.
    act(() =>
      setQuery(search, (args: SearchArgs): Page => {
        if (args.paginationOpts.cursor === null) {
          return { page: [five[0], five[2]] as Item[], isDone: false, continueCursor: "2" };
        }
        return { page: [five[2], five[3]] as Item[], isDone: false, continueCursor: "4" };
      }),
    );

    expect(rowTitles()).toEqual(["Decision 1", "Decision 3", "Decision 4"]);
  });
});

describe("states", () => {
  test("shows loading until the query returns", async () => {
    setQuery(search, loading);
    await openHistory();

    expect(screen.getByText("Loading history")).toBeOnTheScreen();
    expect(screen.queryByText("No settled decisions.")).toBeNull();

    act(() => serveHistory([ship]));

    expect(rowTitles()).toEqual(["Ship the release?"]);
    expect(screen.queryByText("Loading history")).toBeNull();
  });

  test("no settled decisions and no matches are distinct empty states", async () => {
    serveHistory([]);
    await openHistory();

    expect(screen.getByText("No settled decisions.")).toBeOnTheScreen();
    expect(screen.queryByText("No matches.")).toBeNull();

    act(() => serveHistory([ship]));
    fireEvent.press(screen.getByRole("button", { name: "State: Cancelled" }));

    expect(screen.getByText("No matches.")).toBeOnTheScreen();
    expect(screen.queryByText("No settled decisions.")).toBeNull();
  });

  test("a failed query shows a failure with a retry, never an empty list", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    setQuery(search, new Error("Network request failed"));
    await openHistory();

    expect(screen.getByText("Could not load your history.")).toBeOnTheScreen();
    expect(screen.queryByText("No settled decisions.")).toBeNull();
    // The inputs stay usable while the list fails.
    expect(screen.getByLabelText("Search history")).toBeOnTheScreen();

    act(() => serveHistory([ship]));
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(rowTitles()).toEqual(["Ship the release?"]);
  });

  test("a new input clears a failed list", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    serveHistory([ship]);
    const script = queries.get()[search] as (args: SearchArgs) => Page;
    setQuery(search, (args: SearchArgs) =>
      args.state === undefined ? new Error("Network request failed") : script(args),
    );
    await openHistory();
    expect(screen.getByText("Could not load your history.")).toBeOnTheScreen();

    fireEvent.press(screen.getByRole("button", { name: "State: Answered" }));

    expect(screen.queryByText("Could not load your history.")).toBeNull();
    expect(rowTitles()).toEqual(["Ship the release?"]);
  });
});

describe("delete", () => {
  async function openWith(items: Item[]) {
    serveHistory(items);
    await openHistory();
  }

  // req-mobile-app AC-6.2
  test("deletes the selected decision only after confirmation, and the row leaves with the query", async () => {
    await openWith([ship, billing]);
    expect(removeBinds).toBe(0);

    fireEvent.press(screen.getByRole("button", { name: "Delete Refund policy?" }));

    expect(
      screen.getByText('Delete "Refund policy?" from every screen? This cannot be undone.'),
    ).toBeOnTheScreen();
    expect(mockRemove).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete decision" }));
    });

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith({ decisionId: "d_billing" });
    // The screen keeps the row until the reactive query drops it.
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);
    expect(screen.queryByRole("button", { name: "Delete decision" })).toBeNull();

    act(() => serveHistory([ship]));

    expect(rowTitles()).toEqual(["Ship the release?"]);
    expect(screen).toHavePathname("/history");
  });

  test("a cancelled confirmation deletes nothing", async () => {
    await openWith([ship]);

    fireEvent.press(screen.getByRole("button", { name: "Delete Ship the release?" }));
    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Delete decision" })).toBeNull();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(rowTitles()).toEqual(["Ship the release?"]);
  });

  test("sends one deletion while it runs and disables the controls", async () => {
    const pending = deferred<null>();
    mockRemove.mockReturnValueOnce(pending.promise);
    await openWith([ship, billing]);
    fireEvent.press(screen.getByRole("button", { name: "Delete Ship the release?" }));

    const confirm = screen.getByRole("button", { name: "Delete decision" });
    fireEvent.press(confirm);
    fireEvent.press(confirm);

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete decision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Refund policy?" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "State: Answered" })).toBeDisabled();
    expect(screen.getByLabelText("Search history").props.editable).toBe(false);

    fireEvent.press(screen.getByRole("button", { name: "Delete Refund policy?" }));
    expect(mockRemove).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(null);
    });

    expect(screen.getByRole("button", { name: "Delete Refund policy?" })).toBeEnabled();
    expect(screen.getByLabelText("Search history").props.editable).toBe(true);
  });

  test("a failed deletion keeps the row and the confirmation and allows a retry", async () => {
    mockRemove.mockRejectedValueOnce(new Error("Network request failed"));
    await openWith([ship]);
    fireEvent.press(screen.getByRole("button", { name: "Delete Ship the release?" }));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete decision" }));
    });

    expect(screen.getByText('Could not delete "Ship the release?". Try again.')).toBeOnTheScreen();
    expect(rowTitles()).toEqual(["Ship the release?"]);

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete decision" }));
    });

    expect(mockRemove).toHaveBeenCalledTimes(2);
    expect(mockRemove).toHaveBeenLastCalledWith({ decisionId: "d_ship" });
    expect(screen.queryByText(/^Could not delete/)).toBeNull();
  });

  test("a conflict says the decision is pending and leaves the row to the query", async () => {
    mockRemove.mockRejectedValueOnce(
      new ConvexError({ code: "conflict", message: "Decision is pending" }),
    );
    await openWith([ship]);
    fireEvent.press(screen.getByRole("button", { name: "Delete Ship the release?" }));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete decision" }));
    });

    expect(screen.getByText("This decision is pending and cannot be deleted.")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Delete decision" })).toBeNull();
    expect(rowTitles()).toEqual(["Ship the release?"]);
  });

  test("a decision removed elsewhere says so and the query drops the row", async () => {
    mockRemove.mockRejectedValueOnce(
      new ConvexError({ code: "not_found", message: "Decision not found" }),
    );
    await openWith([ship, billing]);
    fireEvent.press(screen.getByRole("button", { name: "Delete Ship the release?" }));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete decision" }));
    });

    expect(screen.getByText("This decision was removed elsewhere.")).toBeOnTheScreen();
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);

    act(() => serveHistory([billing]));

    expect(rowTitles()).toEqual(["Refund policy?"]);
    expect(screen.getByText("This decision was removed elsewhere.")).toBeOnTheScreen();
  });
});
