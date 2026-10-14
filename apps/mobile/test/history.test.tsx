import { type Decision, topicMatches } from "@agentdesk/contract";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import { useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  Alert,
  type AlertButton,
  Platform,
  StyleSheet,
} from "react-native";
import { haptic } from "../src/haptics";
import { INVALID_TOPIC } from "../src/history-filters";
import { DELETE_ACTION, formatSettledTime, LOAD_FAILURE, settledDay } from "../src/history-list";
import { decision } from "./data";
import { deferred, loading, queries, queryCalls, readQuery, setQuery, signInAs } from "./fakes";
import { findInbox, pressTab, queryLargeTitle, renderApp } from "./render";

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
// mutation keeps the shared fake.
const mockRemove = jest.fn<Promise<null>, [{ decisionId: string }]>();
type ConvexReactMock = {
  useMutation: (reference: unknown) => unknown;
  usePaginatedQuery?: unknown;
};

beforeEach(() => {
  mockRemove.mockReset().mockResolvedValue(null);
  const convexReact = jest.requireMock<ConvexReactMock>("convex/react");
  const sharedUseMutation = convexReact.useMutation;
  jest.spyOn(convexReact, "useMutation").mockImplementation((reference: unknown) => {
    if (getFunctionName(reference as never) === removeName) {
      return mockRemove;
    }
    return sharedUseMutation(reference);
  });
  convexReact.usePaginatedQuery = useFakePaginatedQuery;
  jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
  // React Native's preset already mocks this function, so the spy is that
  // mock and keeps earlier tests' calls until cleared.
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear();
  jest.spyOn(haptic, "success");
  jest.spyOn(haptic, "error");
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

// The swipe row around a decision's row, which carries its Delete action, or
// null when the row offers none.
function swipeRowOf(title: string) {
  let node = screen.getByRole("button", { name: `Decision: ${title}` }).parent;
  while (node !== null) {
    if (typeof node.type === "string" && node.props.accessibilityActions !== undefined) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

// Runs a row's Delete action, as a swipe's revealed button or VoiceOver's
// action does.
function deleteRow(title: string) {
  const row = swipeRowOf(title);
  if (row === null) {
    throw new Error(`The row "${title}" offers no Delete action`);
  }
  fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "Delete" } });
}

// The action sheets shown so far, in order.
function sheets() {
  return jest.mocked(ActionSheetIOS.showActionSheetWithOptions).mock.calls;
}

// Picks a button of the last action sheet by its label.
async function chooseInSheet(label: string) {
  const [options, callback] = sheets().at(-1) ?? [];
  const index = options?.options.indexOf(label) ?? -1;
  if (callback === undefined || index === -1) {
    throw new Error(`No action sheet offers "${label}"`);
  }
  await act(async () => callback(index));
}

function announced() {
  return jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([text]) => text);
}

// Opens the "Other topic" field and applies the typed topic.
function applyOtherTopic(text: string) {
  fireEvent.press(screen.getByRole("button", { name: "Other topic" }));
  fireEvent.changeText(screen.getByLabelText("Topic"), text);
  fireEvent.press(screen.getByRole("button", { name: "Apply topic" }));
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
  test("the History tab opens history under a large title", async () => {
    serveHistory([ship]);
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    pressTab("History");

    expect(await screen.findByText("Ship the release?")).toBeOnTheScreen();
    expect(queryLargeTitle("History")).toBeOnTheScreen();
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

    // The decision screen's title is a header; the history row is a button.
    expect(await screen.findByRole("header", { name: "Refund policy?" })).toBeOnTheScreen();
    expect(screen).toHavePathname("/decision/d_billing");
  });
});

describe("rows", () => {
  // An instant `daysAgo` local days before now, at the given local time.
  function localAt(daysAgo: number, hours: number, minutes: number) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hours, minutes, 0, 0);
    return date.toISOString();
  }

  test("each row shows its outcome, title, topic and time, grouped by settlement day", async () => {
    const options = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ];
    const answeredAt = localAt(0, 8, 15);
    const answered = settled(
      {
        id: "d_1",
        title: "Pick one",
        topic: "acme/billing",
        input_type: "single_choice",
        options,
        answer: { kind: "option", option_id: "b" },
      },
      answeredAt,
    );
    const defaultedAt = localAt(1, 7, 0);
    const defaulted = settled(
      {
        id: "d_2",
        title: "Defaulted",
        state: "expired",
        answer: { kind: "reject" },
        applied_by_default: true,
        answered_via: null,
      },
      defaultedAt,
    );
    const lapsedAt = localAt(1, 6, 0);
    const lapsed = settled(
      { id: "d_3", title: "Lapsed", state: "expired", answer: null, answered_at: null },
      lapsedAt,
    );
    const cancelledAt = localAt(3, 5, 0);
    const cancelled = settled(
      { id: "d_4", title: "Withdrawn", state: "cancelled", answer: null, answered_at: null },
      cancelledAt,
    );
    serveHistory([answered, defaulted, lapsed, cancelled]);

    await openHistory();

    expect(rowTitles()).toEqual(["Pick one", "Defaulted", "Lapsed", "Withdrawn"]);
    expect(queryLargeTitle("History")).toBeOnTheScreen();
    expect(screen.getAllByRole("header").map((header) => header.props.children as string)).toEqual([
      "Today",
      "Yesterday",
      settledDay(cancelledAt, Date.now()),
    ]);

    const first = screen.getByRole("button", { name: "Decision: Pick one" });
    expect(
      within(first).getByText(`acme/billing · ${formatSettledTime(answeredAt)}`),
    ).toBeOnTheScreen();
    expect(within(first).getByText("Beta")).toBeOnTheScreen();
    expect(first.props.accessibilityValue.text).toBe(
      `Answered. Answer: Beta acme/billing, settled ${formatSettledTime(answeredAt)}`,
    );

    const second = screen.getByRole("button", { name: "Decision: Defaulted" });
    expect(within(second).getByText("Default: Reject")).toBeOnTheScreen();
    expect(second.props.accessibilityValue.text).toMatch(/^Expired\. Default applied: Reject /);

    // Expired and cancelled rows show their own settlement instant, which the
    // Decision read shape does not carry.
    const third = screen.getByRole("button", { name: "Decision: Lapsed" });
    expect(within(third).getByText("Expired")).toBeOnTheScreen();
    expect(within(third).getByText(`acme · ${formatSettledTime(lapsedAt)}`)).toBeOnTheScreen();
    expect(third.props.accessibilityValue.text).toMatch(/^Expired\. Expired without an answer /);

    const fourth = screen.getByRole("button", { name: "Decision: Withdrawn" });
    expect(within(fourth).getByText("Cancelled")).toBeOnTheScreen();
    expect(within(fourth).getByText(`acme · ${formatSettledTime(cancelledAt)}`)).toBeOnTheScreen();
    expect(fourth.props.accessibilityValue.text).toMatch(/^Cancelled\. No answer was recorded\. /);
  });

  // component-mobile-app §Screens, Rows (req-decision-requests AC-8.3).
  test("a chat answer of every type reads Answered in chat with the message below in two lines", async () => {
    const options = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Gamma" },
    ];
    const message = "**Go** with _this_ one.\n# not a heading\nThird line";
    const inChat = (
      id: string,
      title: string,
      overrides: Partial<Decision>,
      chatMessage = message,
    ): Item =>
      settled({
        id,
        title,
        options,
        answered_via: "chat",
        chat_message: chatMessage,
        relayed_by_agent_session_id: "s_relay",
        ...overrides,
      });
    const rows: [Item, string][] = [
      [inChat("d_1", "Approve it", { answer: { kind: "approve" } }), "Approve"],
      [inChat("d_2", "Reject it", { answer: { kind: "reject" } }), "Reject"],
      [
        inChat("d_3", "Pick one", {
          input_type: "single_choice",
          answer: { kind: "option", option_id: "b" },
        }),
        "Beta",
      ],
      [
        inChat("d_4", "Pick many", {
          input_type: "multiple_choice",
          answer: { kind: "options", option_ids: ["a", "c"] },
        }),
        "Alpha, Gamma",
      ],
      [
        inChat("d_5", "Name it", {
          input_type: "free_text",
          options: null,
          answer: { kind: "text", text: "Atlas" },
        }),
        "Atlas",
      ],
      [
        inChat("d_6", "Pick or type", {
          input_type: "single_choice_or_text",
          answer: { kind: "text", text: "Something else" },
        }),
        "Something else",
      ],
    ];
    const app = settled({ id: "d_7", title: "From the app", answer: { kind: "approve" } });
    serveHistory([...rows.map(([item]) => item), app]);

    await openHistory();

    const time = formatSettledTime(SETTLED);
    for (const [item, answer] of rows) {
      const row = screen.getByRole("button", { name: `Decision: ${item.decision.title}` });
      expect(within(row).getByText(`Answered in chat: ${answer}`)).toBeOnTheScreen();
      // The message is shown as typed and cut to two lines.
      const shown = within(row).getByText(message);
      expect(shown.props.numberOfLines).toBe(2);
      expect(row.props.accessibilityValue.text).toBe(
        `Answered. Answered in chat: ${answer}. Your message in chat: ${message}. acme, settled ${time}`,
      );
    }

    // An app answer keeps its summary and shows no chat message.
    const appRow = screen.getByRole("button", { name: "Decision: From the app" });
    expect(within(appRow).getByText("Approve")).toBeOnTheScreen();
    expect(within(appRow).queryByText(/Answered in chat/)).not.toBeOnTheScreen();
    expect(within(appRow).queryByText(message)).not.toBeOnTheScreen();
    expect(appRow.props.accessibilityValue.text).toBe(
      `Answered. Answer: Approve acme, settled ${time}`,
    );
  });

  test("a decision answered in chat while History is open joins the list", async () => {
    const pendingNow: Item[] = [];
    serveHistory(pendingNow);
    await openHistory();
    expect(rowTitles()).toEqual([]);

    act(() =>
      serveHistory([
        settled({
          id: "d_1",
          title: "Ship?",
          answered_via: "chat",
          chat_message: "Yes, ship it",
          relayed_by_agent_session_id: "s_relay",
        }),
      ]),
    );

    const row = screen.getByRole("button", { name: "Decision: Ship?" });
    expect(within(row).getByText("Answered in chat: Approve")).toBeOnTheScreen();
    expect(within(row).getByText("Yes, ship it")).toBeOnTheScreen();
  });

  test("day headings read Today, Yesterday, the weekday, then the date", () => {
    // Local noon on Tuesday 13 October 2026.
    const now = new Date(2026, 9, 13, 12, 0).getTime();
    const at = (month: number, day: number, year = 2026) =>
      new Date(year, month, day, 23, 30).toISOString();

    expect(settledDay(new Date(2026, 9, 13, 0, 5).toISOString(), now)).toBe("Today");
    expect(settledDay(at(9, 12), now)).toBe("Yesterday");
    expect(settledDay(at(9, 8), now)).toBe(
      new Date(2026, 9, 8).toLocaleDateString(undefined, { weekday: "long" }),
    );
    expect(settledDay(at(9, 6), now)).toBe(
      new Date(2026, 9, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(settledDay(at(11, 30, 2025), now)).toBe(
      new Date(2025, 11, 30).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
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

  test("the clear button empties the search", async () => {
    serveHistory([ship, billing]);
    await openHistory();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.changeText(screen.getByLabelText("Search history"), "refund");
    act(() => jest.advanceTimersByTime(300));
    expect(rowTitles()).toEqual(["Refund policy?"]);

    fireEvent.press(screen.getByRole("button", { name: "Clear search" }));
    act(() => jest.advanceTimersByTime(300));

    expect(screen.getByLabelText("Search history")).toHaveDisplayValue("");
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  // Apple HIG Typography and Buttons: the fields grow with Dynamic Type, and
  // the clear button is a 44pt target.
  test("the fields have no fixed height and the clear button is a 44pt target", async () => {
    serveHistory([ship]);
    await openHistory();
    const search = screen.getByLabelText("Search history");
    // The rounded field around the text input.
    let box = search.parent;
    while (box !== null && StyleSheet.flatten(box.props.style)?.borderRadius === undefined) {
      box = box.parent;
    }
    const field = StyleSheet.flatten(box?.props.style);
    expect(field.height).toBeUndefined();
    expect(field.minHeight).toBe(44);

    fireEvent.changeText(search, "ship");
    expect(screen.getByRole("button", { name: "Clear search" }).props.hitSlop).toBe(14);

    fireEvent.press(screen.getByRole("button", { name: "Other topic" }));
    const topic = StyleSheet.flatten(screen.getByLabelText("Topic").props.style);
    expect(topic.height).toBeUndefined();
    expect(topic.minHeight).toBe(44);
  });

  test("the state filter sends the state at once and All states clears it", async () => {
    const expired = settled({ id: "d_e", title: "Lapsed", state: "expired", answer: null });
    const cancelled = settled({ id: "d_c", title: "Withdrawn", state: "cancelled", answer: null });
    serveHistory([ship, expired, cancelled]);
    await openHistory();
    expect(screen.queryByRole("tab", { name: "State: Pending" })).toBeNull();

    fireEvent.press(screen.getByRole("tab", { name: "State: Expired" }));

    expect(rowTitles()).toEqual(["Lapsed"]);
    expect(screen.getByRole("tab", { name: "State: Expired" })).toBeSelected();

    fireEvent.press(screen.getByRole("tab", { name: "State: Cancelled" }));
    expect(rowTitles()).toEqual(["Withdrawn"]);

    fireEvent.press(screen.getByRole("tab", { name: "State: Answered" }));
    expect(rowTitles()).toEqual(["Ship the release?"]);

    fireEvent.press(screen.getByRole("tab", { name: "All states" }));
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

    applyOtherTopic("acme");

    expect(sentFilters()).toContainEqual({ topic: "acme" });
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);
    expect(screen.getByRole("button", { name: "Topic: acme" })).toBeSelected();
  });

  test("the topics of loaded rows and their prefixes are chips that filter at once", async () => {
    serveHistory([ship, billing, corp]);
    await openHistory();

    expect(screen.getByRole("button", { name: "All topics" })).toBeSelected();
    for (const topic of ["acme", "acme/billing", "acmecorp"]) {
      expect(screen.getByRole("button", { name: `Topic: ${topic}` })).toBeOnTheScreen();
    }

    fireEvent.press(screen.getByRole("button", { name: "Topic: acme" }));

    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);
    expect(screen.getByRole("button", { name: "Topic: acme" })).toBeSelected();
    // A narrowed list keeps the chips of topics it no longer shows.
    expect(screen.getByRole("button", { name: "Topic: acmecorp" })).toBeOnTheScreen();
    expect(sentFilters()).toEqual([{}, { topic: "acme" }]);
  });

  test("another topic is normalized, applied, and offers its parent prefixes as chips", async () => {
    serveHistory([ship, billing, corp]);
    await openHistory();
    expect(screen.queryByLabelText("Topic")).toBeNull();
    expect(screen.queryByRole("button", { name: "Topic: acme/billing/eu" })).toBeNull();

    applyOtherTopic(" Acme/Billing/EU ");

    expect(screen.getByText("No matches.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Topic: acme/billing/eu" })).toBeSelected();
    // The field closes once the topic applies.
    expect(screen.queryByLabelText("Topic")).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Topic: acme/billing" }));
    expect(rowTitles()).toEqual(["Refund policy?"]);

    fireEvent.press(screen.getByRole("button", { name: "All topics" }));
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?", "Rename the corp?"]);
    // The chips stay after an empty result or a cleared filter.
    expect(screen.getByRole("button", { name: "Topic: acme/billing/eu" })).toBeOnTheScreen();
    expect(sentFilters()).toEqual([{}, { topic: "acme/billing/eu" }, { topic: "acme/billing" }]);
  });

  test("an invalid topic shows the rule and sends no query", async () => {
    serveHistory([ship]);
    await openHistory();
    fireEvent.press(screen.getByRole("button", { name: "Other topic" }));
    expect(screen.getByRole("button", { name: "Apply topic" })).toBeDisabled();

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme corp");
    fireEvent.press(screen.getByRole("button", { name: "Apply topic" }));

    expect(screen.getByText(INVALID_TOPIC)).toBeOnTheScreen();
    expect(announced()).toEqual([INVALID_TOPIC]);
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
    fireEvent.press(screen.getByRole("tab", { name: "State: Answered" }));

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
    fireEvent.press(screen.getByRole("tab", { name: "State: Cancelled" }));

    expect(screen.getByText("No matches.")).toBeOnTheScreen();
    expect(screen.queryByText("No settled decisions.")).toBeNull();
  });

  test("a failed query shows a failure with a retry, never an empty list", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    setQuery(search, new Error("Network request failed"));
    await openHistory();

    expect(screen.getByText(LOAD_FAILURE)).toBeOnTheScreen();
    expect(announced()).toEqual([LOAD_FAILURE]);
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
    expect(screen.getByText(LOAD_FAILURE)).toBeOnTheScreen();

    fireEvent.press(screen.getByRole("tab", { name: "State: Answered" }));

    expect(screen.queryByText(LOAD_FAILURE)).toBeNull();
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

    deleteRow("Refund policy?");

    // Apple HIG Action sheets: the system sheet confirms the destructive choice.
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0]?.[0]).toEqual({
      title: 'Delete "Refund policy?"?',
      message: "It leaves every screen. This cannot be undone.",
      options: [DELETE_ACTION, "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(mockRemove).not.toHaveBeenCalled();

    await chooseInSheet(DELETE_ACTION);

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith({ decisionId: "d_billing" });
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(haptic.error).not.toHaveBeenCalled();
    // The screen keeps the row until the reactive query drops it.
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);

    act(() => serveHistory([ship]));

    expect(rowTitles()).toEqual(["Ship the release?"]);
    expect(screen).toHavePathname("/history");
  });

  test("a long press on a row offers Delete without the swipe", async () => {
    await openWith([ship, billing]);
    const row = screen.getByRole("button", { name: "Decision: Refund policy?" });
    expect(row.props.accessibilityHint).toBe("Touch and hold to delete.");

    fireEvent(row, "longPress");
    await chooseInSheet(DELETE_ACTION);

    expect(mockRemove).toHaveBeenCalledWith({ decisionId: "d_billing" });
    expect(screen).toHavePathname("/history");
  });

  test("Android confirms in the system alert", async () => {
    const os = Platform.OS;
    Platform.OS = "android";
    try {
      const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
      await openWith([ship]);

      deleteRow("Ship the release?");

      expect(sheets()).toHaveLength(0);
      const [title, message, buttons] = alert.mock.calls[0] ?? [];
      expect(title).toBe('Delete "Ship the release?"?');
      expect(message).toBe("It leaves every screen. This cannot be undone.");
      expect(buttons?.map(({ text, style }: AlertButton) => ({ text, style }))).toEqual([
        { text: "Cancel", style: "cancel" },
        { text: DELETE_ACTION, style: "destructive" },
      ]);
      expect(mockRemove).not.toHaveBeenCalled();

      await act(async () => buttons?.[1]?.onPress?.());

      expect(mockRemove).toHaveBeenCalledWith({ decisionId: "d_ship" });
    } finally {
      Platform.OS = os;
    }
  });

  test("a cancelled confirmation deletes nothing", async () => {
    await openWith([ship]);

    deleteRow("Ship the release?");
    await chooseInSheet("Cancel");

    expect(mockRemove).not.toHaveBeenCalled();
    expect(haptic.success).not.toHaveBeenCalled();
    expect(rowTitles()).toEqual(["Ship the release?"]);
  });

  test("sends one deletion while it runs and disables the controls", async () => {
    const pending = deferred<null>();
    mockRemove.mockReturnValueOnce(pending.promise);
    await openWith([ship, billing]);
    deleteRow("Ship the release?");
    const [, confirm] = sheets()[0] ?? [];

    await chooseInSheet(DELETE_ACTION);
    // A second confirmation, such as a stale sheet's, sends nothing.
    await act(async () => confirm?.(0));

    expect(mockRemove).toHaveBeenCalledTimes(1);
    // No row offers Delete, by swipe or long press, while the deletion runs.
    expect(swipeRowOf("Refund policy?")).toBeNull();
    const row = screen.getByRole("button", { name: "Decision: Refund policy?" });
    expect(row.props.onLongPress).toBeUndefined();
    expect(row.props.accessibilityHint).toBeUndefined();
    expect(screen.getByRole("tab", { name: "State: Answered" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Topic: acme" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Other topic" })).toBeDisabled();
    expect(screen.getByLabelText("Search history").props.editable).toBe(false);

    fireEvent.press(screen.getByRole("tab", { name: "State: Answered" }));
    expect(screen.getByRole("tab", { name: "All states" })).toBeSelected();

    await act(async () => {
      pending.resolve(null);
    });

    expect(swipeRowOf("Refund policy?")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "State: Answered" })).toBeEnabled();
    expect(screen.getByLabelText("Search history").props.editable).toBe(true);
  });

  test("a failed deletion keeps the row, says so, and allows a retry", async () => {
    mockRemove.mockRejectedValueOnce(new Error("Network request failed"));
    await openWith([ship]);
    deleteRow("Ship the release?");

    await chooseInSheet(DELETE_ACTION);

    const failure = 'Could not delete "Ship the release?". Try again.';
    expect(screen.getByText(failure)).toBeOnTheScreen();
    expect(announced()).toEqual([failure]);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(rowTitles()).toEqual(["Ship the release?"]);

    deleteRow("Ship the release?");
    await chooseInSheet(DELETE_ACTION);

    expect(mockRemove).toHaveBeenCalledTimes(2);
    expect(mockRemove).toHaveBeenLastCalledWith({ decisionId: "d_ship" });
    expect(screen.queryByText(/^Could not delete/)).toBeNull();
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });

  test("a conflict says the decision is pending and leaves the row to the query", async () => {
    mockRemove.mockRejectedValueOnce(
      new ConvexError({ code: "conflict", message: "Decision is pending" }),
    );
    await openWith([ship]);
    deleteRow("Ship the release?");

    await chooseInSheet(DELETE_ACTION);

    expect(screen.getByText("This decision is pending and cannot be deleted.")).toBeOnTheScreen();
    expect(announced()).toEqual(["This decision is pending and cannot be deleted."]);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(rowTitles()).toEqual(["Ship the release?"]);
  });

  test("a decision removed elsewhere says so and the query drops the row", async () => {
    mockRemove.mockRejectedValueOnce(
      new ConvexError({ code: "not_found", message: "Decision not found" }),
    );
    await openWith([ship, billing]);
    deleteRow("Ship the release?");

    await chooseInSheet(DELETE_ACTION);

    expect(screen.getByText("This decision was removed elsewhere.")).toBeOnTheScreen();
    expect(announced()).toEqual(["This decision was removed elsewhere."]);
    expect(rowTitles()).toEqual(["Ship the release?", "Refund policy?"]);

    act(() => serveHistory([billing]));

    expect(rowTitles()).toEqual(["Refund policy?"]);
    expect(screen.getByText("This decision was removed elsewhere.")).toBeOnTheScreen();
  });
});
