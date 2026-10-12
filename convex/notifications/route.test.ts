import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventKind } from "./events";
import { notifications } from "./refs";
import { compareRules } from "./route";
import { openSession, queued, register, type Setup, setup } from "./test.setup";

const START = Date.UTC(2026, 9, 11, 12, 0, 0);
const MINUTE = 60_000;

// Fake timers keep the push component's scheduled sender from running.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

type DecisionFields = Partial<
  Pick<Doc<"decisions">, "title" | "inputType" | "options" | "recommendation" | "priority">
>;

async function insertDecision(
  t: Setup["t"],
  userId: Id<"users">,
  agentSessionId: Id<"agentSessions">,
  fields: DecisionFields = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("decisions", {
      userId,
      agentSessionId,
      topic: "repo/x",
      title: "Ship it?",
      inputType: "approve_reject",
      priority: "normal",
      state: "pending",
      searchText: "Ship it?",
      ...fields,
    }),
  );
}

// An event of `kind` as `emit` stores it, without scheduling its route.
async function insertEvent(
  t: Setup["t"],
  userId: Id<"users">,
  kind: EventKind,
  ids: { decisionId?: Id<"decisions">; agentSessionId?: Id<"agentSessions"> },
  occurredAt = START,
) {
  return await t.run((ctx) =>
    ctx.db.insert("events", { userId, kind, topic: "repo/x", ...ids, occurredAt }),
  );
}

function route(t: Setup["t"], eventId: Id<"events">) {
  return t.mutation(notifications.route.run, { eventId });
}

function loadEvent(t: Setup["t"], eventId: Id<"events">) {
  return t.run((ctx) => ctx.db.get("events", eventId));
}

function deliveriesOf(t: Setup["t"], eventId: Id<"events">) {
  return t.run((ctx) =>
    ctx.db
      .query("pushDeliveries")
      .withIndex("by_event_device", (q) => q.eq("eventId", eventId))
      .collect(),
  );
}

describe("route", () => {
  // req-notification-rules REQ-4
  test.each<[EventKind, "push" | "digest" | "mute"]>([
    ["decision.created", "push"],
    ["agent.stale", "push"],
    ["decision.expired", "digest"],
    ["agent.done", "digest"],
    ["agent.status_changed", "mute"],
  ])("stores the default action for %s", async (kind, action) => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);
    const decisionId = await insertDecision(t, userA, agentSessionId);
    const eventId = await insertEvent(t, userA, kind, {
      agentSessionId,
      decisionId: kind.startsWith("decision.") ? decisionId : undefined,
    });

    await route(t, eventId);

    const event = await loadEvent(t, eventId);
    expect(event?.action).toBe(action);
    expect(event?.digestId).toBeUndefined();
  });

  // req-notification-rules REQ-7
  test.each<EventKind>(["decision.created", "agent.stale"])(
    "pushes %s to each device once across repeated and concurrent runs",
    async (kind) => {
      const { t, userA, asA, asB } = await setup();
      await register(asA, "install-1", "ExponentPushToken[1]");
      await register(asA, "install-2", "ExponentPushToken[2]");
      await register(asB, "install-3", "ExponentPushToken[3]");
      const agentSessionId = await openSession(t, userA);
      const decisionId = await insertDecision(t, userA, agentSessionId);
      const eventId = await insertEvent(t, userA, kind, {
        agentSessionId,
        decisionId: kind === "decision.created" ? decisionId : undefined,
      });

      await route(t, eventId);
      await route(t, eventId);
      await Promise.all([route(t, eventId), route(t, eventId)]);

      expect(await queued(t, "install-1")).toHaveLength(1);
      expect(await queued(t, "install-2")).toHaveLength(1);
      expect(await queued(t, "install-3")).toEqual([]);
      expect(await deliveriesOf(t, eventId)).toHaveLength(2);
    },
  );

  // req-notification-rules REQ-4, AC-1.2
  test.each<EventKind>(["decision.expired", "agent.done", "agent.status_changed"])(
    "sends nothing for %s and leaves the domain rows unchanged",
    async (kind) => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-1", "ExponentPushToken[1]");
      const agentSessionId = await openSession(t, userA);
      const decisionId = await insertDecision(t, userA, agentSessionId);
      const before = await t.run(async (ctx) => ({
        decision: await ctx.db.get("decisions", decisionId),
        session: await ctx.db.get("agentSessions", agentSessionId),
      }));
      const eventId = await insertEvent(t, userA, kind, {
        agentSessionId,
        decisionId: kind.startsWith("decision.") ? decisionId : undefined,
      });

      await route(t, eventId);

      expect(await queued(t, "install-1")).toEqual([]);
      expect(await deliveriesOf(t, eventId)).toEqual([]);
      const after = await t.run(async (ctx) => ({
        decision: await ctx.db.get("decisions", decisionId),
        session: await ctx.db.get("agentSessions", agentSessionId),
      }));
      expect(after).toEqual(before);
    },
  );

  test("leaves a webhook-only event unrouted", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA);
    const decisionId = await insertDecision(t, userA, agentSessionId);
    const eventId = await t.run((ctx) =>
      ctx.db.insert("events", {
        userId: userA,
        kind: "decision.answered",
        decisionId,
        occurredAt: START,
        action: null,
      }),
    );

    await route(t, eventId);

    expect((await loadEvent(t, eventId))?.action).toBeNull();
    expect(await queued(t, "install-1")).toEqual([]);
  });

  test("a failed push stores no action, and a later run delivers", async () => {
    const { t, userA, asA } = await setup();
    const agentSessionId = await openSession(t, userA);
    const decisionId = await insertDecision(t, userA, agentSessionId);
    const eventId = await insertEvent(t, userA, "decision.created", { decisionId, agentSessionId });
    // A device row whose install never gave the component a token makes the
    // send throw.
    await t.run((ctx) =>
      ctx.db.insert("devices", {
        userId: userA,
        deviceId: "install-1",
        name: "Phone",
        platform: "ios",
      }),
    );

    await expect(route(t, eventId)).rejects.toThrow();
    expect((await loadEvent(t, eventId))?.action).toBeUndefined();
    expect(await deliveriesOf(t, eventId)).toEqual([]);

    await register(asA, "install-1", "ExponentPushToken[1]");
    await route(t, eventId);
    expect((await loadEvent(t, eventId))?.action).toBe("push");
    expect(await queued(t, "install-1")).toHaveLength(1);
  });
});

describe("push messages", () => {
  async function pushDecision(fields: DecisionFields, displayName?: string) {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA, displayName);
    const decisionId = await insertDecision(t, userA, agentSessionId, fields);
    const eventId = await insertEvent(t, userA, "decision.created", { decisionId, agentSessionId });
    await route(t, eventId);
    const [push] = await queued(t, "install-1");
    return { t, push, eventId, decisionId, agentSessionId };
  }

  const options = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `o${i + 1}`, label: `Option ${i + 1}` }));

  test("an approve-or-reject decision: title, topic and agent, category, data", async () => {
    const { push, eventId, decisionId, agentSessionId } = await pushDecision(
      { title: "Ship it?" },
      "Release bot",
    );
    expect(push).toMatchObject({
      title: "Ship it?",
      body: "repo/x · Release bot",
      categoryId: "decision-approve-reject",
    });
    expect(push?.data).toEqual({ eventId, kind: "decision.created", decisionId, agentSessionId });
  });

  test("numbers the options and marks the recommendation", async () => {
    const { push } = await pushDecision({
      title: "Which database?",
      inputType: "single_choice",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "sq", label: "SQLite" },
      ],
      recommendation: { kind: "option", option_id: "sq" },
    });
    expect(push?.title).toBe("Which database?");
    expect(push?.body).toBe(
      ["repo/x · Claude Code · repo/x", "1. Postgres", "2. SQLite (recommended)"].join("\n"),
    );
    expect(push?.categoryId).toBe("decision-choice-2");
  });

  test("marks every recommended option of a multiple choice and sets no category", async () => {
    const { push } = await pushDecision({
      inputType: "multiple_choice",
      options: options(3),
      recommendation: { kind: "options", option_ids: ["o1", "o3"] },
    });
    expect(push?.body).toBe(
      [
        "repo/x · Claude Code · repo/x",
        "1. Option 1 (recommended)",
        "2. Option 2",
        "3. Option 3 (recommended)",
      ].join("\n"),
    );
    expect(push?.categoryId).toBeUndefined();
  });

  test.each<[Doc<"decisions">["inputType"], number, string | undefined]>([
    ["single_choice", 3, "decision-choice-3"],
    ["single_choice", 4, undefined],
    ["single_choice_or_text", 2, undefined],
  ])("a %s decision with %i options has category %s", async (inputType, count, category) => {
    const { push } = await pushDecision({ inputType, options: options(count) });
    expect(push?.categoryId).toBe(category);
    expect(push?.body?.split("\n")).toHaveLength(count + 1);
  });

  test("a free-text decision lists no options", async () => {
    const { push } = await pushDecision({ inputType: "free_text" });
    expect(push?.body).toBe("repo/x · Claude Code · repo/x");
    expect(push?.categoryId).toBeUndefined();
  });

  test("a decision whose asking session is gone still pushes", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA);
    const decisionId = await insertDecision(t, userA, agentSessionId);
    const eventId = await insertEvent(t, userA, "decision.created", { decisionId, agentSessionId });
    await t.run((ctx) => ctx.db.delete("agentSessions", agentSessionId));

    await route(t, eventId);

    const [push] = await queued(t, "install-1");
    expect(push).toMatchObject({ title: "Ship it?", body: "repo/x · Ended agent" });
  });

  test("a stale agent: name, last status line, and minutes of silence", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA, "Release bot");
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", agentSessionId, {
        state: "working",
        line: "Running migrations",
        lastActivityAt: START,
      }),
    );
    const eventId = await insertEvent(
      t,
      userA,
      "agent.stale",
      { agentSessionId },
      START + 30 * MINUTE + 59_000,
    );

    await route(t, eventId);

    const [push] = await queued(t, "install-1");
    expect(push).toMatchObject({
      title: "Release bot looks stuck",
      body: "Running migrations\nSilent for 30 min",
    });
    expect(push?.categoryId).toBeUndefined();
    expect(push?.data).toEqual({ eventId, kind: "agent.stale", agentSessionId });
  });

  test("reads only rows the event's owner owns", async () => {
    const { t, userA, userB, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const foreignSession = await openSession(t, userB, "Other bot");
    const eventId = await insertEvent(t, userA, "agent.stale", { agentSessionId: foreignSession });

    await route(t, eventId);

    const [push] = await queued(t, "install-1");
    expect(push?.title).toBe("Ended agent looks stuck");
    expect(push?.body).toBeUndefined();
  });
});

// An event of `kind` with exactly `fields`, without scheduling its route.
async function insertEventWith(
  t: Setup["t"],
  userId: Id<"users">,
  kind: EventKind,
  fields: Partial<Pick<Doc<"events">, "topic" | "decisionId" | "agentSessionId" | "priority">>,
) {
  return await t.run((ctx) =>
    ctx.db.insert("events", { userId, kind, occurredAt: START, ...fields }),
  );
}

type RuleEventKind = NonNullable<Doc<"rules">["eventKind"]>;

type RuleFields = Partial<
  Pick<Doc<"rules">, "topic" | "agentSessionId" | "eventKind" | "priority" | "updatedAt">
> &
  Pick<Doc<"rules">, "action">;

// A rule stored directly, so a test controls `updatedAt`.
function insertRule(t: Setup["t"], userId: Id<"users">, fields: RuleFields) {
  return t.run((ctx) => ctx.db.insert("rules", { userId, updatedAt: START, ...fields }));
}

async function routedAction(t: Setup["t"], eventId: Id<"events">) {
  await route(t, eventId);
  return (await loadEvent(t, eventId))?.action;
}

describe("rule matching", () => {
  // req-notification-rules AC-3.1
  test.each([
    ["acme", "mute"],
    ["acme/billing", "mute"],
    ["acme/billing/eu", "mute"],
    ["acmecorp", "push"],
    ["acm", "push"],
  ])("a rule on topic acme routes a %s event to %s", async (topic, action) => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { topic: "acme", action: "mute" });
    const eventId = await insertEventWith(t, userA, "decision.created", { topic });
    expect(await routedAction(t, eventId)).toBe(action);
  });

  test("matches the agent session by equality", async () => {
    const { t, userA } = await setup();
    const matched = await openSession(t, userA);
    const other = await openSession(t, userA);
    await insertRule(t, userA, { agentSessionId: matched, action: "mute" });

    const own = await insertEventWith(t, userA, "agent.stale", { agentSessionId: matched });
    const foreign = await insertEventWith(t, userA, "agent.stale", { agentSessionId: other });

    expect(await routedAction(t, own)).toBe("mute");
    expect(await routedAction(t, foreign)).toBe("push");
  });

  test("matches the event kind by equality", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { eventKind: "agent.status_changed", action: "push" });

    const changed = await insertEventWith(t, userA, "agent.status_changed", {});
    const done = await insertEventWith(t, userA, "agent.done", {});

    expect(await routedAction(t, changed)).toBe("push");
    expect(await routedAction(t, done)).toBe("digest");
  });

  test("an event without the field a rule sets does not match it", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);
    await insertRule(t, userA, { topic: "repo", action: "mute" });
    await insertRule(t, userA, { agentSessionId, action: "mute" });

    const eventId = await insertEventWith(t, userA, "decision.created", {});

    expect(await routedAction(t, eventId)).toBe("push");
  });

  test("requires every match field the rule sets", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { topic: "repo", eventKind: "agent.stale", action: "mute" });

    const otherKind = await insertEventWith(t, userA, "decision.created", { topic: "repo" });
    const otherTopic = await insertEventWith(t, userA, "agent.stale", { topic: "web" });
    const both = await insertEventWith(t, userA, "agent.stale", { topic: "repo/x" });

    expect(await routedAction(t, otherKind)).toBe("push");
    expect(await routedAction(t, otherTopic)).toBe("push");
    expect(await routedAction(t, both)).toBe("mute");
  });

  // component-notifications §Emitting and routing step 1
  test("a rule that sets priority matches decision events of that priority only", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { priority: "urgent", action: "mute" });

    const urgent = await insertEventWith(t, userA, "decision.created", { priority: "urgent" });
    const normal = await insertEventWith(t, userA, "decision.created", { priority: "normal" });
    const expired = await insertEventWith(t, userA, "decision.expired", { priority: "urgent" });
    // An agent event never carries a priority; one stored with it still does
    // not match.
    const agent = await insertEventWith(t, userA, "agent.stale", { priority: "urgent" });

    expect(await routedAction(t, urgent)).toBe("mute");
    expect(await routedAction(t, normal)).toBe("push");
    expect(await routedAction(t, expired)).toBe("mute");
    expect(await routedAction(t, agent)).toBe("push");
  });

  test("a rule combining priority with an agent kind never matches", async () => {
    const { t, userA, asA } = await setup();
    await asA.mutation(notifications.rules.save, {
      eventKind: "agent.done",
      priority: "urgent",
      action: "push",
    });

    const eventId = await insertEventWith(t, userA, "agent.done", { priority: "urgent" });

    expect(await routedAction(t, eventId)).toBe("digest");
  });

  test("ignores another account's rules", async () => {
    const { t, userA, userB } = await setup();
    await insertRule(t, userB, { topic: "repo", action: "mute" });

    const eventId = await insertEventWith(t, userA, "decision.created", { topic: "repo" });

    expect(await routedAction(t, eventId)).toBe("push");
  });

  // req-notification-rules REQ-4
  test("uses the default action when rules exist but none matches", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { topic: "web", action: "mute" });

    const eventId = await insertEventWith(t, userA, "decision.expired", { topic: "repo" });

    expect(await routedAction(t, eventId)).toBe("digest");
  });

  test("leaves a webhook-only event unrouted even when a rule matches it", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await insertRule(t, userA, { topic: "repo", action: "push" });

    const eventId = await insertEventWith(t, userA, "decision.answered", { topic: "repo" });

    expect(await routedAction(t, eventId)).toBeUndefined();
    expect(await queued(t, "install-1")).toEqual([]);
  });
});

describe("rule selection", () => {
  // req-notification-rules AC-3.2
  test("picks the rule with the most match fields over a later one", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, {
      topic: "repo",
      eventKind: "decision.created",
      action: "mute",
      updatedAt: START,
    });
    await insertRule(t, userA, { topic: "repo", action: "digest", updatedAt: START + MINUTE });

    const eventId = await insertEventWith(t, userA, "decision.created", { topic: "repo/x" });

    expect(await routedAction(t, eventId)).toBe("mute");
  });

  test("breaks a count tie by the latest updatedAt", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { topic: "repo", action: "digest", updatedAt: START + MINUTE });
    await insertRule(t, userA, { eventKind: "decision.created", action: "mute", updatedAt: START });

    const eventId = await insertEventWith(t, userA, "decision.created", { topic: "repo" });

    expect(await routedAction(t, eventId)).toBe("digest");
  });

  test("breaks a count and updatedAt tie by the newest creation", async () => {
    const { t, userA } = await setup();
    await insertRule(t, userA, { topic: "repo", action: "digest" });
    await insertRule(t, userA, { eventKind: "decision.created", action: "mute" });

    const eventId = await insertEventWith(t, userA, "decision.created", { topic: "repo" });

    expect(await routedAction(t, eventId)).toBe("mute");
  });

  test("breaks a full tie by the lexically smallest id", () => {
    const rule = (id: string, action: Doc<"rules">["action"]) =>
      ({
        _id: id as Id<"rules">,
        _creationTime: START,
        userId: "u" as Id<"users">,
        topic: "repo",
        action,
        updatedAt: START,
      }) satisfies Doc<"rules">;
    const sorted = [rule("b", "mute"), rule("a", "digest"), rule("c", "push")].sort(compareRules);
    expect(sorted.map((r) => r._id)).toEqual(["a", "b", "c"]);
  });

  // req-notification-rules AC-1.1
  test("reads rules at routing time: a later save governs later events only", async () => {
    const { t, userA, asA } = await setup();
    const before = await insertEventWith(t, userA, "decision.created", { topic: "repo" });
    expect(await routedAction(t, before)).toBe("push");

    const rule = await asA.mutation(notifications.rules.save, { topic: "repo", action: "mute" });
    await route(t, before);
    expect((await loadEvent(t, before))?.action).toBe("push");

    const after = await insertEventWith(t, userA, "decision.created", { topic: "repo" });
    expect(await routedAction(t, after)).toBe("mute");

    await asA.mutation(notifications.rules.save, {
      ruleId: rule.id,
      topic: "repo",
      action: "digest",
    });
    const edited = await insertEventWith(t, userA, "decision.created", { topic: "repo" });
    expect(await routedAction(t, edited)).toBe("digest");
    expect((await loadEvent(t, after))?.action).toBe("mute");

    await asA.mutation(notifications.rules.remove, { ruleId: rule.id });
    const removed = await insertEventWith(t, userA, "decision.created", { topic: "repo" });
    expect(await routedAction(t, removed)).toBe("push");
  });
});

describe("rule-driven delivery", () => {
  // req-notification-rules REQ-7
  test.each<RuleEventKind>(["decision.expired", "agent.status_changed", "agent.done"])(
    "pushes %s routed to push to each device once across repeated and concurrent runs",
    async (kind) => {
      const { t, userA, asA, asB } = await setup();
      await register(asA, "install-1", "ExponentPushToken[1]");
      await register(asA, "install-2", "ExponentPushToken[2]");
      await register(asB, "install-3", "ExponentPushToken[3]");
      await insertRule(t, userA, { eventKind: kind, action: "push" });
      const agentSessionId = await openSession(t, userA);
      const decisionId = await insertDecision(t, userA, agentSessionId);
      const eventId = await insertEvent(t, userA, kind, {
        agentSessionId,
        decisionId: kind === "decision.expired" ? decisionId : undefined,
      });

      await route(t, eventId);
      await route(t, eventId);
      await Promise.all([route(t, eventId), route(t, eventId)]);

      expect((await loadEvent(t, eventId))?.action).toBe("push");
      expect(await queued(t, "install-1")).toHaveLength(1);
      expect(await queued(t, "install-2")).toHaveLength(1);
      expect(await queued(t, "install-3")).toEqual([]);
      expect(await deliveriesOf(t, eventId)).toHaveLength(2);
    },
  );

  // req-notification-rules AC-1.2
  test.each<[RuleEventKind, "digest" | "mute"]>([
    ["decision.created", "digest"],
    ["decision.created", "mute"],
    ["agent.stale", "digest"],
    ["agent.stale", "mute"],
  ])(
    "sends nothing for %s routed to %s and leaves the domain rows unchanged",
    async (kind, action) => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-1", "ExponentPushToken[1]");
      await insertRule(t, userA, { eventKind: kind, action });
      const agentSessionId = await openSession(t, userA);
      const decisionId = await insertDecision(t, userA, agentSessionId);
      const before = await t.run(async (ctx) => ({
        decision: await ctx.db.get("decisions", decisionId),
        session: await ctx.db.get("agentSessions", agentSessionId),
      }));
      const eventId = await insertEvent(t, userA, kind, {
        agentSessionId,
        decisionId: kind === "decision.created" ? decisionId : undefined,
      });

      await route(t, eventId);

      const event = await loadEvent(t, eventId);
      expect(event?.action).toBe(action);
      expect(event?.digestId).toBeUndefined();
      expect(await queued(t, "install-1")).toEqual([]);
      expect(await deliveriesOf(t, eventId)).toEqual([]);
      const after = await t.run(async (ctx) => ({
        decision: await ctx.db.get("decisions", decisionId),
        session: await ctx.db.get("agentSessions", agentSessionId),
      }));
      expect(after).toEqual(before);
    },
  );

  test("a failed rule-driven push stores no action, and a later run delivers", async () => {
    const { t, userA, asA } = await setup();
    await insertRule(t, userA, { eventKind: "agent.done", action: "push" });
    const agentSessionId = await openSession(t, userA);
    const eventId = await insertEvent(t, userA, "agent.done", { agentSessionId });
    await t.run((ctx) =>
      ctx.db.insert("devices", {
        userId: userA,
        deviceId: "install-1",
        name: "Phone",
        platform: "ios",
      }),
    );

    await expect(route(t, eventId)).rejects.toThrow();
    expect((await loadEvent(t, eventId))?.action).toBeUndefined();
    expect(await deliveriesOf(t, eventId)).toEqual([]);

    await register(asA, "install-1", "ExponentPushToken[1]");
    await route(t, eventId);
    expect((await loadEvent(t, eventId))?.action).toBe("push");
    expect(await queued(t, "install-1")).toHaveLength(1);
  });
});

describe("rule-driven push messages", () => {
  async function pushExpired(fields: Partial<Doc<"decisions">>) {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await insertRule(t, userA, { eventKind: "decision.expired", action: "push" });
    const agentSessionId = await openSession(t, userA);
    const decisionId = await insertDecision(t, userA, agentSessionId);
    await t.run((ctx) =>
      ctx.db.patch("decisions", decisionId, { state: "expired", settledAt: START, ...fields }),
    );
    const eventId = await insertEvent(t, userA, "decision.expired", { decisionId, agentSessionId });
    await route(t, eventId);
    const [push] = await queued(t, "install-1");
    return { push, eventId, decisionId, agentSessionId };
  }

  const choices = [
    { id: "pg", label: "Postgres" },
    { id: "sq", label: "SQLite" },
    { id: "my", label: "MySQL" },
  ];

  test("an expired decision with no applied answer: Expired, title, no category, data", async () => {
    const { push, eventId, decisionId, agentSessionId } = await pushExpired({});
    expect(push).toMatchObject({ title: "Expired", body: "Ship it?" });
    expect(push?.categoryId).toBeUndefined();
    expect(push?.data).toEqual({ eventId, kind: "decision.expired", decisionId, agentSessionId });
  });

  test.each<[string, Partial<Doc<"decisions">>, string]>([
    ["approve", { answer: { kind: "approve" } }, "Approve"],
    ["reject", { answer: { kind: "reject" } }, "Reject"],
    [
      "option",
      { inputType: "single_choice", options: choices, answer: { kind: "option", option_id: "sq" } },
      "SQLite",
    ],
    [
      "option without a label",
      { inputType: "single_choice", options: choices, answer: { kind: "option", option_id: "zz" } },
      "zz",
    ],
    [
      "options",
      {
        inputType: "multiple_choice",
        options: choices,
        answer: { kind: "options", option_ids: ["my", "pg"] },
      },
      "MySQL, Postgres",
    ],
    [
      "text",
      { inputType: "free_text", answer: { kind: "text", text: "Use the cache" } },
      "Use the cache",
    ],
  ])("a decision decided by default with an %s answer", async (_, fields, answer) => {
    const { push } = await pushExpired({ appliedByDefault: true, ...fields });
    expect(push).toMatchObject({ title: "Decided by default", body: `Ship it?\n${answer}` });
    expect(push?.categoryId).toBeUndefined();
  });

  test("an expired event whose decision is missing or foreign stores push and sends nothing", async () => {
    const { t, userA, userB, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await insertRule(t, userA, { eventKind: "decision.expired", action: "push" });
    const agentSessionId = await openSession(t, userA);
    const gone = await insertDecision(t, userA, agentSessionId);
    await t.run((ctx) => ctx.db.delete("decisions", gone));
    const foreign = await insertDecision(t, userB, await openSession(t, userB));

    for (const decisionId of [gone, foreign]) {
      const eventId = await insertEvent(t, userA, "decision.expired", {
        decisionId,
        agentSessionId,
      });
      expect(await routedAction(t, eventId)).toBe("push");
      expect(await deliveriesOf(t, eventId)).toEqual([]);
    }
    expect(await queued(t, "install-1")).toEqual([]);
  });

  test.each<RuleEventKind>(["agent.status_changed", "agent.done"])(
    "%s: the agent name and status line, no category, data",
    async (kind) => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-1", "ExponentPushToken[1]");
      await insertRule(t, userA, { eventKind: kind, action: "push" });
      const agentSessionId = await openSession(t, userA, "Release bot");
      await t.run((ctx) =>
        ctx.db.patch("agentSessions", agentSessionId, { state: "done", line: "Shipped v2" }),
      );
      const eventId = await insertEvent(t, userA, kind, { agentSessionId });

      await route(t, eventId);

      const [push] = await queued(t, "install-1");
      expect(push).toMatchObject({ title: "Release bot", body: "Shipped v2" });
      expect(push?.categoryId).toBeUndefined();
      expect(push?.data).toEqual({ eventId, kind, agentSessionId });
    },
  );

  test("an agent event without a status line has no body; a missing or foreign session is Ended agent", async () => {
    const { t, userA, userB, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await insertRule(t, userA, { eventKind: "agent.status_changed", action: "push" });
    const quiet = await openSession(t, userA);
    const gone = await openSession(t, userA);
    await t.run((ctx) => ctx.db.delete("agentSessions", gone));
    const foreign = await openSession(t, userB, "Other bot");

    for (const agentSessionId of [quiet, gone, foreign]) {
      await route(t, await insertEvent(t, userA, "agent.status_changed", { agentSessionId }));
    }

    const pushes = await queued(t, "install-1");
    expect(pushes).toHaveLength(3);
    const byTitle = pushes.map((push) => [push.title, push.body]);
    expect(byTitle).toEqual(
      expect.arrayContaining([
        ["Claude Code · repo/x", undefined],
        ["Ended agent", undefined],
        ["Ended agent", undefined],
      ]),
    );
  });
});
