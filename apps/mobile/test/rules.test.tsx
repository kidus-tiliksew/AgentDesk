import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { router } from "expo-router";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import { AccessibilityInfo, ActionSheetIOS, Dimensions } from "react-native";
import type { NotificationRule } from "../../../convex/notifications/rules";
import { haptic } from "../src/haptics";
import { INVALID_TOPIC } from "../src/history-filters";
import {
  DEFAULT_ROUTING,
  NO_MATCH,
  PRECEDENCE_EXPLANATION,
  PRIORITY_HINT,
  SUBTOPIC_HINT,
} from "../src/rules/format";
import { rulePreview } from "../src/rules/sentence";
import { agent } from "./data";
import { account, deferred, ensureAccount, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens, rules: settings/rules lists the person's
// notification rules and settings/rule/[id] creates, edits, and deletes one
// (req-mobile-app REQ-5; req-notification-rules REQ-2 to REQ-4). The editor
// shows the rule as a sentence whose highlighted parts open each match
// field's choices, so the helpers below open a field before using it.

const listName = "notifications/rules:list";
const saveName = "notifications/rules:save";
const removeName = "notifications/rules:remove";
const liveName = "agents/app:liveAgents";
const recentName = "agents/app:recentAgents";

type SaveArgs = {
  ruleId?: string;
  topic?: string;
  agentSessionId?: string;
  eventKind?: string;
  priority?: string;
  action: string;
};

// The shared convex/react fake refuses mutations it does not know. This file
// wraps its useMutation, so save and remove get local mocks and every other
// mutation, such as ensureAccount, keeps the shared fake. `binds` records
// each render that bound save or remove, apart from any call.
const mockSave = jest.fn<Promise<NotificationRule>, [SaveArgs]>();
const mockRemove = jest.fn<Promise<null>, [{ ruleId: string }]>();
let binds: string[] = [];
// The system action sheet that confirms a deletion or a discard.
// `chooseInSheet` picks one of its options as the person would.
let sheet: jest.SpyInstance;
let announce: jest.SpyInstance;

function chooseInSheet(option: string) {
  const [options, callback] = sheet.mock.lastCall as [
    { options: string[] },
    (index: number) => void,
  ];
  expect(options.options).toContain(option);
  callback(options.options.indexOf(option));
}

function rule(
  overrides: Partial<NotificationRule> & Pick<NotificationRule, "id">,
): NotificationRule {
  return {
    topic: null,
    agent_session_id: null,
    event_kind: null,
    priority: null,
    action: "push",
    updated_at: "2026-10-12T09:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => {});
  announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  mockSave.mockReset().mockImplementation(async (args) => rule({ id: args.ruleId ?? "r_new" }));
  mockRemove.mockReset().mockResolvedValue(null);
  binds = [];
  const convexReact = jest.requireMock<{ useMutation: (reference: unknown) => unknown }>(
    "convex/react",
  );
  const sharedUseMutation = convexReact.useMutation;
  jest.spyOn(convexReact, "useMutation").mockImplementation((reference: unknown) => {
    const name = getFunctionName(reference as never);
    if (name === saveName) {
      binds.push(name);
      return mockSave;
    }
    if (name === removeName) {
      binds.push(name);
      return mockRemove;
    }
    return sharedUseMutation(reference);
  });
  setQuery(listName, []);
  setQuery(liveName, [laptop]);
  setQuery(recentName, [server]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const laptop = agent({ id: "a_laptop", display_name: "Claude on laptop" });
const server = agent({
  id: "a_server",
  display_name: "Codex on server",
  ended_at: "2026-10-11T09:00:00.000Z",
});

const acmeUrgent = rule({
  id: "r_acme",
  topic: "acme",
  agent_session_id: "a_laptop",
  event_kind: "decision.created",
  priority: "urgent",
  action: "push",
});
const endedMute = rule({ id: "r_ended", agent_session_id: "a_gone", action: "mute" });
const serverDone = rule({
  id: "r_server",
  agent_session_id: "a_server",
  event_kind: "agent.done",
  action: "digest",
});

async function open(url: string) {
  signInAs("sess_a");
  renderApp(url);
  await act(async () => {});
  act(() => jest.advanceTimersByTime(0));
}

async function settle() {
  await act(async () => {});
  act(() => jest.advanceTimersByTime(0));
}

function rowLabels() {
  return screen
    .queryAllByRole("button", { name: /^Rule: / })
    .map((row) => row.props.accessibilityLabel.replace(/^Rule: /, ""));
}

// The sentence part that opens a match field's choices, e.g. "Agent, any
// agent".
function token(group: string) {
  return screen.getByRole("button", { name: new RegExp(`^${group}, `) });
}

// Opens a match field's choices unless they already show. The action
// buttons always show.
function reveal(group: string) {
  if (group === "Action") {
    return;
  }
  const showing =
    group === "Topic"
      ? screen.queryByLabelText("Topic") !== null
      : screen.queryAllByRole("button", { name: new RegExp(`^${group}: `) }).length > 0;
  if (!showing) {
    fireEvent.press(token(group));
  }
}

// A choice such as "Event: Agent stale", with its field opened first.
function choice(name: string) {
  reveal(name.slice(0, name.indexOf(":")));
  return screen.getByRole("button", { name });
}

function isSelected(name: string) {
  return choice(name).props.accessibilityState?.selected === true;
}

function topicInput() {
  reveal("Topic");
  return screen.getByLabelText("Topic");
}

function saveButton() {
  return screen.getByRole("button", { name: /^(Save|Saving\.\.\.)$/ });
}

async function pressSave() {
  await act(async () => {
    fireEvent.press(saveButton());
  });
  act(() => jest.advanceTimersByTime(0));
}

// Settings, then Rules, then New rule, so a finished editor goes back to the
// list and a second back would reach the settings tab.
async function openNewFromSettings() {
  await open("/settings");
  fireEvent.press(screen.getByText("Rules"));
  await settle();
  fireEvent.press(screen.getByRole("button", { name: "New rule" }));
  await settle();
  expect(screen).toHavePathname("/settings/rule/new");
}

describe("navigation", () => {
  test("the settings tab opens the rules list", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings");

    fireEvent.press(screen.getByText("Rules"));
    await settle();

    expect(screen).toHavePathname("/settings/rules");
    expect(rowLabels()).toHaveLength(1);
  });

  test("the header's + opens an empty editor at settings/rule/new", async () => {
    await open("/settings/rules");

    fireEvent.press(screen.getByRole("button", { name: "New rule" }));
    await settle();

    expect(screen).toHavePathname("/settings/rule/new");
    expect(token("Event")).toHaveTextContent("any event");
    expect(token("Agent")).toHaveTextContent("any agent");
    expect(token("Topic")).toHaveTextContent("any topic");
    expect(token("Priority")).toHaveTextContent("any");
    expect(topicInput().props.value).toBe("");
    expect(isSelected("Agent: Any agent")).toBe(true);
    expect(isSelected("Event: Any event")).toBe(true);
    expect(isSelected("Priority: Any priority")).toBe(true);
    expect(isSelected("Action: Push")).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete rule" })).toBeNull();
  });

  test("a row opens its rule in the editor, read as a sentence", async () => {
    setQuery(listName, [acmeUrgent, endedMute]);
    await open("/settings/rules");

    fireEvent.press(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    await settle();

    expect(screen).toHavePathname("/settings/rule/r_acme");
    expect(token("Event")).toHaveTextContent("a decision is created");
    expect(token("Agent")).toHaveTextContent("Claude on laptop");
    expect(token("Topic")).toHaveTextContent("acme");
    expect(token("Priority")).toHaveTextContent("urgent");
    expect(
      screen.getByText(
        "New urgent decisions from Claude on laptop in acme and its subtopics will push to this phone. Quiet hours still apply.",
      ),
    ).toBeOnTheScreen();
    expect(topicInput().props.value).toBe("acme");
    expect(isSelected("Agent: Claude on laptop")).toBe(true);
    expect(isSelected("Event: Decision created")).toBe(true);
    expect(isSelected("Priority: Urgent")).toBe(true);
    expect(isSelected("Action: Push")).toBe(true);
  });

  test("a sentence part opens its field's choices and a choice closes them", async () => {
    await open("/settings/rule/new");

    expect(screen.queryByRole("button", { name: "Event: Agent done" })).toBeNull();
    fireEvent.press(token("Event"));
    expect(token("Event").props.accessibilityState?.expanded).toBe(true);
    fireEvent.press(screen.getByRole("button", { name: "Event: Agent done" }));

    expect(screen.queryByRole("button", { name: "Event: Agent done" })).toBeNull();
    expect(token("Event")).toHaveTextContent("an agent is done");

    fireEvent.press(token("Priority"));
    expect(screen.getByText(PRIORITY_HINT)).toBeOnTheScreen();
    fireEvent.press(token("Topic"));
    expect(screen.queryByText(PRIORITY_HINT)).toBeNull();
    expect(screen.getByText(SUBTOPIC_HINT)).toBeOnTheScreen();
    fireEvent.press(token("Topic"));
    expect(screen.queryByLabelText("Topic")).toBeNull();
  });

  test("the editor is a sheet", async () => {
    await openNewFromSettings();

    // react-native-screens renders a modal presentation as its own host.
    const sheets = screen.UNSAFE_queryAllByType("RNSModalScreen" as never);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.stackPresentation).toBe("modal");
    expect(within(sheets[0] as never).getByRole("button", { name: "Action: Push" })).toBeTruthy();
  });

  test("Cancel with no edit leaves without asking", async () => {
    await openNewFromSettings();

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(sheet).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings/rules");
  });

  test("Cancel after an edit asks; Keep Editing stays and Discard Changes leaves without saving", async () => {
    await openNewFromSettings();
    fireEvent.changeText(topicInput(), "acme");

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.lastCall?.[0]).toMatchObject({
      options: ["Discard Changes", "Keep Editing"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    act(() => chooseInSheet("Keep Editing"));
    await settle();
    expect(screen).toHavePathname("/settings/rule/new");
    expect(topicInput().props.value).toBe("acme");

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    act(() => chooseInSheet("Discard Changes"));
    await settle();

    expect(screen).toHavePathname("/settings/rules");
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("a swipe down or back gesture after an edit asks too", async () => {
    await openNewFromSettings();
    fireEvent.press(choice("Action: Mute"));

    act(() => router.back());
    await settle();

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/settings/rule/new");
  });

  test("an edit put back as it was leaves without asking", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rules");
    fireEvent.press(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    await settle();
    fireEvent.changeText(topicInput(), "billing");
    fireEvent.changeText(topicInput(), "acme ");

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(sheet).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings/rules");
  });

  test("account setup finishes before the rules queries run", async () => {
    const pending = deferred<typeof account>();
    ensureAccount.mockReturnValueOnce(pending.promise);
    signInAs("sess_a");
    renderApp("/settings/rules");
    await act(async () => {});

    expect(queryCalls.map((call) => call.name)).not.toContain(listName);

    await act(async () => {
      pending.resolve(account);
    });
    act(() => jest.advanceTimersByTime(0));

    expect(queryCalls.map((call) => call.name)).toContain(listName);
  });
});

describe("list", () => {
  test("keeps the query's order and reads each rule as where and what, including an ended agent", async () => {
    setQuery(listName, [serverDone, acmeUrgent, endedMute]);
    await open("/settings/rules");

    expect(rowLabels()).toEqual([
      "Topic Any, Agent Codex on server (ended), Event Agent done, Priority Any, Action Digest",
      "Topic acme, Agent Claude on laptop, Event Decision created, Priority Urgent, Action Push",
      "Topic Any, Agent Ended agent, Event Any, Priority Any, Action Mute",
    ]);
    const first = within(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    expect(first.getByText("acme · Claude on laptop")).toBeOnTheScreen();
    expect(first.getByText("Urgent · Decision created → Push")).toBeOnTheScreen();
    const server = within(screen.getByRole("button", { name: /Agent Codex on server/ }));
    expect(server.getByText("Codex on server (ended)")).toBeOnTheScreen();
    expect(server.getByText("Agent done → Digest")).toBeOnTheScreen();
    const ended = within(screen.getByRole("button", { name: /Agent Ended agent/ }));
    expect(ended.getByText("Ended agent")).toBeOnTheScreen();
    expect(ended.getByText("Any event → Mute")).toBeOnTheScreen();
  });

  test("a rule naming no topic or agent applies to everything", async () => {
    setQuery(listName, [rule({ id: "r_all", event_kind: "agent.stale", action: "mute" })]);
    await open("/settings/rules");

    const row = within(screen.getByRole("button", { name: /^Rule: / }));
    expect(row.getByText("Everything")).toBeOnTheScreen();
    expect(row.getByText("Agent stale → Mute")).toBeOnTheScreen();
  });

  test("explains precedence under the rules", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rules");

    expect(screen.getByText(PRECEDENCE_EXPLANATION)).toBeOnTheScreen();
    expect(PRECEDENCE_EXPLANATION).toMatch(/most match fields set/);
    expect(PRECEDENCE_EXPLANATION).toMatch(/then the most recently saved/);
  });

  test("follows live changes to the rules", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rules");

    act(() => setQuery(listName, [endedMute, acmeUrgent]));

    expect(rowLabels()).toHaveLength(2);
    expect(rowLabels()[0]).toMatch(/Action Mute$/);
  });

  test("shows loading until every query returns, with New rule available", async () => {
    setQuery(recentName, loading);
    await open("/settings/rules");

    expect(screen.getByText("Loading rules")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "New rule" })).toBeOnTheScreen();

    act(() => setQuery(recentName, []));

    expect(screen.queryByText("Loading rules")).toBeNull();
    expect(screen.getByText("No rules yet")).toBeOnTheScreen();
  });

  test("an empty list shows the default routing as a table", async () => {
    await open("/settings/rules");

    expect(screen.getByText("No rules yet")).toBeOnTheScreen();
    expect(screen.getByText("Without a rule")).toBeOnTheScreen();
    for (const label of [
      "Decision created: Push",
      "Agent stale: Push",
      "Decision expired: Digest",
      "Agent done: Digest",
      "Agent status changed: Mute",
    ]) {
      expect(screen.getByLabelText(label)).toBeOnTheScreen();
    }
    // The table matches the backend's defaults (convex/notifications/route.ts).
    expect(Object.fromEntries(DEFAULT_ROUTING.map(({ kind, action }) => [kind, action]))).toEqual({
      "decision.created": "push",
      "agent.stale": "push",
      "decision.expired": "digest",
      "agent.done": "digest",
      "agent.status_changed": "mute",
    });
  });

  test("the default routing also shows under a list of rules", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rules");

    expect(screen.queryByText("No rules yet")).toBeNull();
    expect(screen.getByLabelText("Agent status changed: Mute")).toBeOnTheScreen();
  });

  test("a failed query shows a failure with a retry, never an empty list", async () => {
    setQuery(listName, new Error("Network request failed"));
    await open("/settings/rules");

    expect(screen.getByText("Could not load your rules.")).toBeOnTheScreen();
    expect(screen.queryByText("No rules yet")).toBeNull();
    expect(screen.getByRole("button", { name: "New rule" })).toBeOnTheScreen();

    setQuery(listName, [acmeUrgent]);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(screen.queryByText("Could not load your rules.")).toBeNull();
    expect(rowLabels()).toHaveLength(1);
  });

  test("binds no rules mutation while it loads or shows rows", async () => {
    setQuery(listName, loading);
    await open("/settings/rules");
    act(() => setQuery(listName, [acmeUrgent, endedMute]));
    act(() => setQuery(listName, [endedMute]));

    expect(rowLabels()).toHaveLength(1);
    expect(binds).toEqual([]);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe("create", () => {
  test("Save stays disabled until a match field is set", async () => {
    await open("/settings/rule/new");

    // A new rule reads the agents and no rule list.
    expect(queryCalls.map((call) => call.name)).toContain(recentName);
    expect(queryCalls.filter((call) => call.name === listName)).toEqual([]);
    expect(saveButton()).toBeDisabled();
    fireEvent.press(choice("Action: Mute"));
    expect(saveButton()).toBeDisabled();
    fireEvent.changeText(topicInput(), "   ");
    expect(saveButton()).toBeDisabled();
    await pressSave();
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByText(NO_MATCH)).toBeOnTheScreen();

    fireEvent.press(choice("Event: Agent stale"));
    expect(saveButton()).toBeEnabled();
    fireEvent.press(choice("Event: Any event"));
    expect(saveButton()).toBeDisabled();
  });

  test.each<[string, () => void, SaveArgs]>([
    [
      "a topic",
      () => fireEvent.changeText(topicInput(), "  Acme/Billing "),
      { topic: "Acme/Billing", action: "push" },
    ],
    [
      "a live agent",
      () => fireEvent.press(choice("Agent: Claude on laptop")),
      { agentSessionId: "a_laptop", action: "push" },
    ],
    [
      "a recent agent",
      () => fireEvent.press(choice("Agent: Codex on server (ended)")),
      { agentSessionId: "a_server", action: "push" },
    ],
    [
      "an event kind",
      () => {
        fireEvent.press(choice("Event: Agent status changed"));
        fireEvent.press(choice("Action: Mute"));
      },
      { eventKind: "agent.status_changed", action: "mute" },
    ],
    [
      "a priority",
      () => {
        fireEvent.press(choice("Priority: Normal"));
        fireEvent.press(choice("Action: Digest"));
      },
      { priority: "normal", action: "digest" },
    ],
  ])("creates a rule with %s and returns to the list", async (_label, fill, args) => {
    await openNewFromSettings();

    fill();
    await pressSave();

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(args);
    expect(screen).toHavePathname("/settings/rules");
  });

  test("creates a rule with every match field", async () => {
    await open("/settings/rule/new");

    for (const label of [
      "Event: Decision created",
      "Event: Decision expired",
      "Event: Agent stale",
      "Event: Agent status changed",
      "Event: Agent done",
      "Priority: Normal",
      "Priority: Urgent",
      "Action: Push",
      "Action: Digest",
      "Action: Mute",
    ]) {
      expect(choice(label)).toBeOnTheScreen();
    }

    fireEvent.changeText(topicInput(), "acme");
    fireEvent.press(choice("Agent: Claude on laptop"));
    fireEvent.press(choice("Event: Decision expired"));
    fireEvent.press(choice("Priority: Urgent"));
    fireEvent.press(choice("Action: Digest"));
    await pressSave();

    expect(mockSave).toHaveBeenCalledWith({
      topic: "acme",
      agentSessionId: "a_laptop",
      eventKind: "decision.expired",
      priority: "urgent",
      action: "digest",
    });
    // Opened directly, the editor has nothing to go back to and opens the list.
    expect(screen).toHavePathname("/settings/rules");
  });
});

describe("edit", () => {
  test("saves the edited rule and omits each cleared match field", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rules");
    fireEvent.press(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    await settle();

    fireEvent.changeText(topicInput(), "acme/ops");
    fireEvent.press(choice("Event: Any event"));
    fireEvent.press(choice("Priority: Any priority"));
    fireEvent.press(choice("Action: Digest"));
    await pressSave();

    expect(mockSave).toHaveBeenCalledWith({
      ruleId: "r_acme",
      topic: "acme/ops",
      agentSessionId: "a_laptop",
      action: "digest",
    });
    expect(screen).toHavePathname("/settings/rules");
  });

  test("clearing the topic and the agent omits both", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");

    fireEvent.changeText(topicInput(), "");
    fireEvent.press(choice("Agent: Any agent"));
    await pressSave();

    expect(mockSave).toHaveBeenCalledWith({
      ruleId: "r_acme",
      eventKind: "decision.created",
      priority: "urgent",
      action: "push",
    });
  });

  test("keeps an ended agent's match while other fields change", async () => {
    setQuery(listName, [endedMute]);
    await open("/settings/rule/r_ended");

    expect(isSelected("Agent: Ended agent")).toBe(true);
    fireEvent.press(choice("Action: Digest"));
    await pressSave();

    expect(mockSave).toHaveBeenCalledWith({
      ruleId: "r_ended",
      agentSessionId: "a_gone",
      action: "digest",
    });
  });

  test("a live change to the rule or the agents keeps the draft", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");

    fireEvent.changeText(topicInput(), "acme/draft");
    fireEvent.press(choice("Action: Mute"));
    act(() => {
      setQuery(listName, [{ ...acmeUrgent, topic: "elsewhere", action: "digest" }]);
      setQuery(liveName, [laptop, agent({ id: "a_new", display_name: "New agent" })]);
    });

    expect(topicInput().props.value).toBe("acme/draft");
    expect(isSelected("Action: Mute")).toBe(true);
    expect(choice("Agent: New agent")).toBeOnTheScreen();
  });

  test("a missing rule shows the not-found state", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_missing");

    expect(screen.getByText("Rule not found")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("a malformed id reads nothing and shows the not-found state", async () => {
    await open("/settings/rule/bad.id");

    expect(screen.getByText("Rule not found")).toBeOnTheScreen();
    expect(queryCalls.filter((call) => call.name === listName)).toEqual([]);
    expect(binds).toEqual([]);
  });

  test("a failed rule query offers a retry", async () => {
    setQuery(listName, new Error("Network request failed"));
    await open("/settings/rule/r_acme");

    expect(screen.getByText("Could not load the rule.")).toBeOnTheScreen();

    setQuery(listName, [acmeUrgent]);
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(topicInput().props.value).toBe("acme");
  });
});

describe("refusals and failures", () => {
  test.each<[string, Record<string, string>, string, string]>([
    ["topic", { field: "topic" }, INVALID_TOPIC, "Topic"],
    ["agentSessionId", { field: "agentSessionId" }, "Choose another agent.", "Agent"],
    ["eventKind", { field: "eventKind" }, "Choose another event kind.", "Event"],
    ["priority", { field: "priority" }, "Choose another priority.", "Priority"],
    ["action", { field: "action" }, "Choose another action.", "Action"],
  ])("an invalid %s shows on its field", async (_name, extra, message, group) => {
    mockSave.mockRejectedValueOnce(
      new ConvexError({ code: "invalid", message: "Invalid", ...extra }),
    );
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");

    await pressSave();

    // Each message belongs to one field and shows in that field's group.
    expect(within(screen.getByTestId(`field-${group}`)).getByText(message)).toBeOnTheScreen();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen).toHavePathname("/settings/rule/r_acme");
  });

  test("an invalid topic clears when the topic changes and keeps the draft", async () => {
    mockSave.mockRejectedValueOnce(
      new ConvexError({ code: "invalid", message: "Invalid topic", field: "topic" }),
    );
    await open("/settings/rule/new");
    fireEvent.changeText(topicInput(), "Bad Topic!");
    await pressSave();

    expect(screen.getByText(INVALID_TOPIC)).toBeOnTheScreen();
    expect(topicInput().props.value).toBe("Bad Topic!");

    fireEvent.changeText(topicInput(), "acme");

    expect(screen.queryByText(INVALID_TOPIC)).toBeNull();
  });

  test("an agent that no longer exists shows on the agent field", async () => {
    mockSave.mockRejectedValueOnce(
      new ConvexError({ code: "not_found", message: "Agent session not found" }),
    );
    await open("/settings/rule/new");
    fireEvent.press(choice("Agent: Claude on laptop"));
    await pressSave();

    expect(
      screen.getByText("This agent no longer exists. Choose another agent."),
    ).toBeOnTheScreen();
  });

  test("a refusal without a field shows on the form", async () => {
    mockSave.mockRejectedValueOnce(
      new ConvexError({ code: "invalid", message: "A rule needs at least one match field" }),
    );
    await open("/settings/rule/new");
    fireEvent.press(choice("Priority: Urgent"));
    await pressSave();

    expect(screen.getByText("Set at least one match field.")).toBeOnTheScreen();
  });

  test("a rule deleted elsewhere says so on save", async () => {
    mockSave.mockRejectedValueOnce(
      new ConvexError({ code: "not_found", message: "Notification rule not found" }),
    );
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    await pressSave();

    expect(screen.getByText("This rule was deleted elsewhere.")).toBeOnTheScreen();
  });

  test("a failed save keeps the form and its retry sends the same rule", async () => {
    mockSave.mockRejectedValueOnce(new Error("Network request failed"));
    await openNewFromSettings();
    fireEvent.changeText(topicInput(), "acme");
    fireEvent.press(choice("Action: Mute"));

    await pressSave();

    expect(screen.getByText("Could not save the rule. Try again.")).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith("Could not save the rule. Try again.");
    expect(topicInput().props.value).toBe("acme");
    expect(isSelected("Action: Mute")).toBe(true);
    expect(screen).toHavePathname("/settings/rule/new");

    await pressSave();

    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockSave).toHaveBeenLastCalledWith({ topic: "acme", action: "mute" });
    expect(screen).toHavePathname("/settings/rules");
  });
});

describe("one call at a time", () => {
  test("sends one save while it runs and disables every control", async () => {
    const pending = deferred<NotificationRule>();
    mockSave.mockReturnValueOnce(pending.promise);
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    reveal("Agent");

    fireEvent.press(saveButton());
    fireEvent.press(saveButton());

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete rule" })).toBeDisabled();
    expect(choice("Action: Mute")).toBeDisabled();
    expect(choice("Agent: Any agent")).toBeDisabled();
    for (const group of ["Event", "Agent", "Topic", "Priority"]) {
      expect(token(group)).toBeDisabled();
    }

    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    expect(sheet).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(acmeUrgent);
    });

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test("the topic field is read-only while a save runs", async () => {
    const pending = deferred<NotificationRule>();
    mockSave.mockReturnValueOnce(pending.promise);
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    reveal("Topic");

    fireEvent.press(saveButton());

    expect(screen.getByLabelText("Topic").props.editable).toBe(false);
    await act(async () => {
      pending.resolve(acmeUrgent);
    });
  });

  test("a running deletion refuses a save and a second deletion", async () => {
    const pending = deferred<null>();
    mockRemove.mockReturnValueOnce(pending.promise);
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));

    act(() => chooseInSheet("Delete Rule"));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    fireEvent.press(screen.getByRole("button", { name: "Deleting..." }));
    fireEvent.press(saveButton());

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();

    await act(async () => {
      pending.resolve(null);
    });
  });

  test("a result that settles after the editor closes changes nothing", async () => {
    const pending = deferred<NotificationRule>();
    mockSave.mockReturnValueOnce(pending.promise);
    await openNewFromSettings();
    fireEvent.changeText(topicInput(), "acme");
    fireEvent.press(saveButton());

    act(() => router.back());
    await settle();
    expect(screen).toHavePathname("/settings/rules");

    await act(async () => {
      pending.resolve(rule({ id: "r_new", topic: "acme" }));
    });
    act(() => jest.advanceTimersByTime(0));

    // A stale success would go back once more, to the inbox.
    expect(screen).toHavePathname("/settings/rules");
  });
});

describe("delete", () => {
  test("deletes the rule only after confirmation and returns to the list", async () => {
    setQuery(listName, [acmeUrgent, endedMute]);
    await open("/settings/rules");
    fireEvent.press(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    await settle();

    const success = jest.spyOn(haptic, "success");
    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.lastCall?.[0]).toEqual({
      title: "Delete this rule?",
      message: "Events it matched follow your other rules or the defaults.",
      options: ["Delete Rule", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(mockRemove).not.toHaveBeenCalled();

    await act(async () => {
      chooseInSheet("Delete Rule");
    });
    act(() => jest.advanceTimersByTime(0));

    expect(success).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith({ ruleId: "r_acme" });
    expect(screen).toHavePathname("/settings/rules");

    // The list drops the rule when the reactive query does.
    act(() => setQuery(listName, [endedMute]));
    expect(rowLabels()).toEqual([
      "Topic Any, Agent Ended agent, Event Any, Priority Any, Action Mute",
    ]);
  });

  test("a cancelled confirmation deletes nothing", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");

    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    act(() => chooseInSheet("Cancel"));

    expect(screen.getByRole("button", { name: "Delete rule" })).toBeEnabled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings/rule/r_acme");
  });

  test("a failed deletion shows and reads out its error and allows a retry", async () => {
    mockRemove.mockRejectedValueOnce(new Error("Network request failed"));
    const error = jest.spyOn(haptic, "error");
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));

    await act(async () => {
      chooseInSheet("Delete Rule");
    });

    expect(screen.getByText("Could not delete the rule. Try again.")).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith("Could not delete the rule. Try again.");
    expect(error).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete rule" })).toBeEnabled();
    expect(screen).toHavePathname("/settings/rule/r_acme");

    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    await act(async () => {
      chooseInSheet("Delete Rule");
    });
    act(() => jest.advanceTimersByTime(0));

    expect(mockRemove).toHaveBeenCalledTimes(2);
    expect(mockRemove).toHaveBeenLastCalledWith({ ruleId: "r_acme" });
    expect(screen).toHavePathname("/settings/rules");
  });

  test("a rule already deleted elsewhere returns to the list", async () => {
    mockRemove.mockRejectedValueOnce(
      new ConvexError({ code: "not_found", message: "Notification rule not found" }),
    );
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));

    await act(async () => {
      chooseInSheet("Delete Rule");
    });
    act(() => jest.advanceTimersByTime(0));

    expect(screen).toHavePathname("/settings/rules");
  });
});

describe("feedback and layout", () => {
  test("a save plays the success haptic and a refusal the error haptic, read out", async () => {
    const success = jest.spyOn(haptic, "success");
    const error = jest.spyOn(haptic, "error");
    mockSave.mockRejectedValueOnce(
      new ConvexError({ code: "invalid", message: "Invalid", field: "priority" }),
    );
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");

    await pressSave();
    expect(error).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Choose another priority.");
    expect(success).not.toHaveBeenCalled();

    await pressSave();
    expect(success).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/settings/rules");
  });

  test("the action buttons grow with the text and stack at the largest sizes", async () => {
    const window = Dimensions.get("window");
    try {
      act(() => Dimensions.set({ window: { ...window, fontScale: 1 } }));
      await open("/settings/rule/new");
      expect(choice("Action: Push")).toHaveStyle({ minHeight: 74, flex: 1 });
      expect(choice("Action: Push")).not.toHaveStyle({ height: 74 });

      act(() => Dimensions.set({ window: { ...window, fontScale: 2 } }));

      expect(choice("Action: Push")).toHaveStyle({ flexDirection: "row", flex: 0 });
    } finally {
      act(() => Dimensions.set({ window }));
    }
  });
});

describe("preview", () => {
  const blank = {
    topic: "",
    agent: null,
    eventKind: null,
    priority: null,
    action: "push",
  } as const;

  test("says nothing until a match field is set, and the editor shows why", async () => {
    expect(rulePreview(blank)).toBeNull();
    expect(rulePreview({ ...blank, topic: "  " })).toBeNull();

    await open("/settings/rule/new");
    expect(screen.getByText(NO_MATCH)).toBeOnTheScreen();
    fireEvent.press(choice("Action: Digest"));
    fireEvent.press(choice("Event: Decision expired"));
    expect(screen.queryByText(NO_MATCH)).toBeNull();
    expect(screen.getByText("Expired decisions will wait for the daily digest.")).toBeOnTheScreen();
  });

  test.each<[string, Parameters<typeof rulePreview>[0], string]>([
    [
      "a topic",
      { ...blank, topic: "acme" },
      "Every event in acme and its subtopics will push to this phone. Quiet hours still apply.",
    ],
    [
      "a priority",
      { ...blank, priority: "urgent", action: "mute" },
      "Every urgent decision event will not notify you.",
    ],
    [
      "an agent and an event",
      { ...blank, eventKind: "agent.stale", agent: "Codex", action: "digest" },
      "Stale agent alerts from Codex will wait for the daily digest.",
    ],
    [
      "a decision event with a priority",
      { ...blank, eventKind: "decision.created", priority: "normal" },
      "New normal decisions will push to this phone. Quiet hours still apply.",
    ],
    [
      "an agent event with a priority",
      { ...blank, eventKind: "agent.done", priority: "urgent" },
      "This rule never matches: agent events carry no priority.",
    ],
  ])("reads a rule with %s in plain words", (_label, rule, words) => {
    expect(rulePreview(rule)).toBe(words);
  });
});
