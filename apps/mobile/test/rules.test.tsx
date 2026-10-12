import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { router } from "expo-router";
import { act, fireEvent, screen, within } from "expo-router/testing-library";
import type { NotificationRule } from "../../../convex/notifications/rules";
import { INVALID_TOPIC } from "../src/history-filters";
import { DEFAULTS_EXPLANATION, PRECEDENCE_EXPLANATION } from "../src/rules/format";
import { agent } from "./data";
import { account, deferred, ensureAccount, loading, queryCalls, setQuery, signInAs } from "./fakes";
import { renderApp } from "./render";

// component-mobile-app §Screens, rules: settings/rules lists the person's
// notification rules and settings/rule/[id] creates, edits, and deletes one
// (req-mobile-app REQ-5; req-notification-rules REQ-2 to REQ-4).

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

function choice(name: string) {
  return screen.getByRole("button", { name });
}

function isSelected(name: string) {
  return choice(name).props.accessibilityState?.selected === true;
}

function saveButton() {
  return screen.getByRole("button", { name: /^(Save rule|Saving\.\.\.)$/ });
}

async function pressSave() {
  await act(async () => {
    fireEvent.press(saveButton());
  });
  act(() => jest.advanceTimersByTime(0));
}

// Inbox, then Rules, then New rule, so a finished editor goes back to the
// list and a second back would reach the inbox.
async function openNewFromInbox() {
  await open("/");
  fireEvent.press(screen.getByText("Rules"));
  await settle();
  fireEvent.press(screen.getByText("New rule"));
  await settle();
  expect(screen).toHavePathname("/settings/rule/new");
}

describe("navigation", () => {
  test("the inbox header opens the rules list", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/");

    fireEvent.press(screen.getByText("Rules"));
    await settle();

    expect(screen).toHavePathname("/settings/rules");
    expect(rowLabels()).toHaveLength(1);
  });

  test("New rule opens an empty editor at settings/rule/new", async () => {
    await open("/settings/rules");

    fireEvent.press(screen.getByText("New rule"));
    await settle();

    expect(screen).toHavePathname("/settings/rule/new");
    expect(screen.getByLabelText("Topic").props.value).toBe("");
    expect(isSelected("Agent: Any agent")).toBe(true);
    expect(isSelected("Event: Any event")).toBe(true);
    expect(isSelected("Priority: Any priority")).toBe(true);
    expect(isSelected("Action: Push")).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  test("a row opens its rule in the editor", async () => {
    setQuery(listName, [acmeUrgent, endedMute]);
    await open("/settings/rules");

    fireEvent.press(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    await settle();

    expect(screen).toHavePathname("/settings/rule/r_acme");
    expect(screen.getByLabelText("Topic").props.value).toBe("acme");
    expect(isSelected("Agent: Claude on laptop")).toBe(true);
    expect(isSelected("Event: Decision created")).toBe(true);
    expect(isSelected("Priority: Urgent")).toBe(true);
    expect(isSelected("Action: Push")).toBe(true);
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
  test("keeps the query's order and summarizes each rule, including an ended agent", async () => {
    setQuery(listName, [serverDone, acmeUrgent, endedMute]);
    await open("/settings/rules");

    expect(rowLabels()).toEqual([
      "Topic Any, Agent Codex on server (ended), Event Agent done, Priority Any, Action Digest",
      "Topic acme, Agent Claude on laptop, Event Decision created, Priority Urgent, Action Push",
      "Topic Any, Agent Ended agent, Event Any, Priority Any, Action Mute",
    ]);
    const first = within(screen.getByRole("button", { name: /^Rule: Topic acme,/ }));
    expect(first.getByText("Push")).toBeOnTheScreen();
    expect(first.getByText("Topic: acme")).toBeOnTheScreen();
    expect(first.getByText("Agent: Claude on laptop")).toBeOnTheScreen();
    expect(first.getByText("Event: Decision created")).toBeOnTheScreen();
    expect(first.getByText("Priority: Urgent")).toBeOnTheScreen();
    const ended = within(screen.getByRole("button", { name: /Agent Ended agent/ }));
    expect(ended.getByText("Mute")).toBeOnTheScreen();
    expect(ended.getByText("Agent: Ended agent")).toBeOnTheScreen();
    expect(ended.getByText("Topic: Any")).toBeOnTheScreen();
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
    expect(screen.getByText("New rule")).toBeOnTheScreen();

    act(() => setQuery(recentName, []));

    expect(screen.queryByText("Loading rules")).toBeNull();
    expect(screen.getByText("No rules yet.")).toBeOnTheScreen();
  });

  test("an empty list explains the defaults", async () => {
    await open("/settings/rules");

    expect(screen.getByText("No rules yet.")).toBeOnTheScreen();
    expect(screen.getByText(DEFAULTS_EXPLANATION)).toBeOnTheScreen();
    expect(DEFAULTS_EXPLANATION).toMatch(/decision created and agent stale events push/);
    expect(DEFAULTS_EXPLANATION).toMatch(
      /decision expired and agent done events go to the daily digest/,
    );
    expect(DEFAULTS_EXPLANATION).toMatch(/agent status changes are muted/);
  });

  test("a failed query shows a failure with a retry, never an empty list", async () => {
    setQuery(listName, new Error("Network request failed"));
    await open("/settings/rules");

    expect(screen.getByText("Could not load your rules.")).toBeOnTheScreen();
    expect(screen.queryByText("No rules yet.")).toBeNull();
    expect(screen.getByText("New rule")).toBeOnTheScreen();

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
    fireEvent.changeText(screen.getByLabelText("Topic"), "   ");
    expect(saveButton()).toBeDisabled();
    await pressSave();
    expect(mockSave).not.toHaveBeenCalled();
    expect(
      screen.getByText("Set at least one of topic, agent, event, or priority."),
    ).toBeOnTheScreen();

    fireEvent.press(choice("Event: Agent stale"));
    expect(saveButton()).toBeEnabled();
    fireEvent.press(choice("Event: Any event"));
    expect(saveButton()).toBeDisabled();
  });

  test.each<[string, (s: typeof screen) => void, SaveArgs]>([
    [
      "a topic",
      (s) => fireEvent.changeText(s.getByLabelText("Topic"), "  Acme/Billing "),
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
    await openNewFromInbox();

    fill(screen);
    await pressSave();

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(args);
    expect(screen).toHavePathname("/settings/rules");
  });

  test("creates a rule with every match field and explains precedence", async () => {
    await open("/settings/rule/new");

    expect(screen.getByText(PRECEDENCE_EXPLANATION)).toBeOnTheScreen();
    expect(PRECEDENCE_EXPLANATION).toMatch(/most match fields set wins/);
    expect(PRECEDENCE_EXPLANATION).toMatch(/most recently saved rule wins/);
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

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme");
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

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme/ops");
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

    fireEvent.changeText(screen.getByLabelText("Topic"), "");
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

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme/draft");
    fireEvent.press(choice("Action: Mute"));
    act(() => {
      setQuery(listName, [{ ...acmeUrgent, topic: "elsewhere", action: "digest" }]);
      setQuery(liveName, [laptop, agent({ id: "a_new", display_name: "New agent" })]);
    });

    expect(screen.getByLabelText("Topic").props.value).toBe("acme/draft");
    expect(isSelected("Action: Mute")).toBe(true);
    expect(choice("Agent: New agent")).toBeOnTheScreen();
  });

  test("a missing rule shows the not-found state", async () => {
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_missing");

    expect(screen.getByText("Rule not found")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Save rule" })).toBeNull();
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

    expect(screen.getByLabelText("Topic").props.value).toBe("acme");
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
    fireEvent.changeText(screen.getByLabelText("Topic"), "Bad Topic!");
    await pressSave();

    expect(screen.getByText(INVALID_TOPIC)).toBeOnTheScreen();
    expect(screen.getByLabelText("Topic").props.value).toBe("Bad Topic!");

    fireEvent.changeText(screen.getByLabelText("Topic"), "acme");

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
    await openNewFromInbox();
    fireEvent.changeText(screen.getByLabelText("Topic"), "acme");
    fireEvent.press(choice("Action: Mute"));

    await pressSave();

    expect(screen.getByText("Could not save the rule. Try again.")).toBeOnTheScreen();
    expect(screen.getByLabelText("Topic").props.value).toBe("acme");
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

    fireEvent.press(saveButton());
    fireEvent.press(saveButton());

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(choice("Action: Mute")).toBeDisabled();
    expect(choice("Agent: Any agent")).toBeDisabled();
    expect(screen.getByLabelText("Topic").props.editable).toBe(false);

    fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("button", { name: "Delete rule" })).toBeNull();

    await act(async () => {
      pending.resolve(acmeUrgent);
    });

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test("a running deletion refuses a save and a second deletion", async () => {
    const pending = deferred<null>();
    mockRemove.mockReturnValueOnce(pending.promise);
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    fireEvent.press(screen.getByRole("button", { name: "Delete" }));

    fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    fireEvent.press(screen.getByRole("button", { name: "Deleting..." }));
    fireEvent.press(saveButton());

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => {
      pending.resolve(null);
    });
  });

  test("a result that settles after the editor closes changes nothing", async () => {
    const pending = deferred<NotificationRule>();
    mockSave.mockReturnValueOnce(pending.promise);
    await openNewFromInbox();
    fireEvent.changeText(screen.getByLabelText("Topic"), "acme");
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

    fireEvent.press(screen.getByRole("button", { name: "Delete" }));

    expect(
      screen.getByText(
        "Delete this rule? Events it matched follow your other rules or the defaults.",
      ),
    ).toBeOnTheScreen();
    expect(mockRemove).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    });
    act(() => jest.advanceTimersByTime(0));

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

    fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Delete rule" })).toBeNull();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(screen).toHavePathname("/settings/rule/r_acme");
  });

  test("a failed deletion keeps the confirmation and allows a retry", async () => {
    mockRemove.mockRejectedValueOnce(new Error("Network request failed"));
    setQuery(listName, [acmeUrgent]);
    await open("/settings/rule/r_acme");
    fireEvent.press(screen.getByRole("button", { name: "Delete" }));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    });

    expect(screen.getByText("Could not delete the rule. Try again.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Delete rule" })).toBeEnabled();
    expect(screen).toHavePathname("/settings/rule/r_acme");

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
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
    fireEvent.press(screen.getByRole("button", { name: "Delete" }));

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Delete rule" }));
    });
    act(() => jest.advanceTimersByTime(0));

    expect(screen).toHavePathname("/settings/rules");
  });
});
