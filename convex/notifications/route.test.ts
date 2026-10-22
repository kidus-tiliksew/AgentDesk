import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { decisions } from "../decisions/refs";
import type { EventKind } from "./events";
import { notifications } from "./refs";
import { compareRules, INTERACTIVE_HOLD_MS } from "./route";
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
  Pick<
    Doc<"decisions">,
    | "title"
    | "inputType"
    | "options"
    | "recommendation"
    | "priority"
    | "interactive"
    | "deadline"
    | "default"
  >
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
  async function pushDecision(fields: DecisionFields, displayName?: string, occurredAt = START) {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA, displayName);
    const decisionId = await insertDecision(t, userA, agentSessionId, fields);
    const eventId = await insertEvent(
      t,
      userA,
      "decision.created",
      { decisionId, agentSessionId },
      occurredAt,
    );
    await route(t, eventId);
    const [push] = await queued(t, "install-1");
    return { t, push, eventId, decisionId, agentSessionId };
  }

  const options = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `o${i + 1}`, label: `Option ${i + 1}` }));

  test("an approve-or-reject decision: agent title, question body, category, data", async () => {
    const { push, eventId, decisionId, agentSessionId } = await pushDecision(
      { title: "Ship it?" },
      "Release bot",
    );
    expect(push).toMatchObject({
      title: "Release bot",
      body: "Ship it?",
      categoryId: "decision-approve-reject",
      sound: "default",
    });
    expect(push?.interruptionLevel).toBeUndefined();
    expect(push?.data).toEqual({ eventId, kind: "decision.created", decisionId, agentSessionId });
  });

  test("a session without a display name is titled with the card name", async () => {
    const { push } = await pushDecision({ title: "Ship it?" });
    expect(push).toMatchObject({ title: "Claude Code · repo/x", body: "Ship it?" });
  });

  test("numbers the options after the question and marks the recommendation", async () => {
    const { push } = await pushDecision({
      title: "Which database?",
      inputType: "single_choice",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "sq", label: "SQLite" },
      ],
      recommendation: { kind: "option", option_id: "sq" },
    });
    expect(push?.title).toBe("Claude Code · repo/x");
    expect(push?.body).toBe(
      ["Which database?", "1. Postgres", "2. SQLite (recommended)"].join("\n"),
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
      ["Ship it?", "1. Option 1 (recommended)", "2. Option 2", "3. Option 3 (recommended)"].join(
        "\n",
      ),
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

  test("keeps every option of a long list in order", async () => {
    const { push } = await pushDecision({ inputType: "single_choice", options: options(7) });
    expect(push?.body?.split("\n")).toEqual([
      "Ship it?",
      ...options(7).map((o, i) => `${i + 1}. ${o.label}`),
    ]);
    expect(push?.categoryId).toBeUndefined();
  });

  test("a 120-character question is the whole first body line", async () => {
    const title = `${"Should the release pipeline wait for the canary? ".repeat(3).slice(0, 119)}?`;
    expect(title).toHaveLength(120);
    const { push } = await pushDecision({ title }, "Release bot");
    expect(push?.title).toBe("Release bot");
    expect(push?.body).toBe(title);
  });

  // The body for each input type, with and without a recommendation and with
  // and without a deadline and default. The event occurs at START and the
  // deadline is 25 minutes later.
  type Shape = {
    fields: DecisionFields;
    options: string[];
    recommendation: Pick<DecisionFields, "recommendation">;
    recommendedOptions: string[];
    recommendationLine: string[];
    default: Pick<DecisionFields, "default">;
    defaultText: string;
  };
  const shapes: Record<Doc<"decisions">["inputType"], Shape> = {
    approve_reject: {
      fields: { inputType: "approve_reject" },
      options: [],
      recommendation: { recommendation: { kind: "approve" } },
      recommendedOptions: [],
      recommendationLine: ["Recommended: Approve"],
      default: { default: { kind: "reject" } },
      defaultText: "Reject",
    },
    free_text: {
      fields: { inputType: "free_text" },
      options: [],
      recommendation: { recommendation: { kind: "text", text: "Use the cache" } },
      recommendedOptions: [],
      recommendationLine: ["Recommended: Use the cache"],
      default: { default: { kind: "text", text: "Skip the cache" } },
      defaultText: "Skip the cache",
    },
    single_choice: {
      fields: { inputType: "single_choice", options: options(2) },
      options: ["1. Option 1", "2. Option 2"],
      recommendation: { recommendation: { kind: "option", option_id: "o2" } },
      recommendedOptions: ["1. Option 1", "2. Option 2 (recommended)"],
      recommendationLine: [],
      default: { default: { kind: "option", option_id: "o1" } },
      defaultText: "Option 1",
    },
    multiple_choice: {
      fields: { inputType: "multiple_choice", options: options(3) },
      options: ["1. Option 1", "2. Option 2", "3. Option 3"],
      recommendation: { recommendation: { kind: "options", option_ids: ["o1", "o3"] } },
      recommendedOptions: ["1. Option 1 (recommended)", "2. Option 2", "3. Option 3 (recommended)"],
      recommendationLine: [],
      default: { default: { kind: "options", option_ids: ["o3", "o1"] } },
      defaultText: "Option 3, Option 1",
    },
    single_choice_or_text: {
      fields: { inputType: "single_choice_or_text", options: options(2) },
      options: ["1. Option 1", "2. Option 2"],
      recommendation: { recommendation: { kind: "option", option_id: "o1" } },
      recommendedOptions: ["1. Option 1 (recommended)", "2. Option 2"],
      recommendationLine: [],
      default: { default: { kind: "text", text: "Decide later" } },
      defaultText: "Decide later",
    },
  };
  const matrix = Object.keys(shapes).flatMap((inputType) =>
    [true, false].flatMap((recommended) =>
      [true, false].map(
        (defaulted) =>
          [inputType as Doc<"decisions">["inputType"], recommended, defaulted] as const,
      ),
    ),
  );

  test.each(matrix)(
    "a %s decision body (recommendation %s, deadline and default %s)",
    async (inputType, recommended, defaulted) => {
      const shape = shapes[inputType];
      const { push } = await pushDecision({
        ...shape.fields,
        ...(recommended ? shape.recommendation : {}),
        ...(defaulted ? { deadline: START + 25 * MINUTE, ...shape.default } : {}),
      });
      expect(push?.title).toBe("Claude Code · repo/x");
      expect(push?.body?.split("\n")).toEqual([
        "Ship it?",
        ...(recommended ? shape.recommendedOptions : shape.options),
        ...(recommended ? shape.recommendationLine : []),
        ...(defaulted ? [`Defaults to ${shape.defaultText} in 25 min`] : []),
      ]);
    },
  );

  test("the target urgent single choice: agent, question, options, default", async () => {
    const { push } = await pushDecision(
      {
        title: "Set up Firebase before the first Android production build?",
        inputType: "single_choice",
        priority: "urgent",
        options: [
          { id: "firebase", label: "Set up Firebase first, then build" },
          { id: "build", label: "Build now, add Firebase later" },
        ],
        recommendation: { kind: "option", option_id: "firebase" },
        deadline: START + 25 * MINUTE,
        default: { kind: "option", option_id: "firebase" },
      },
      "First Android production build",
    );
    expect(push).toMatchObject({
      title: "First Android production build",
      body: [
        "Set up Firebase before the first Android production build?",
        "1. Set up Firebase first, then build (recommended)",
        "2. Build now, add Firebase later",
        "Defaults to Set up Firebase first, then build in 25 min",
      ].join("\n"),
      categoryId: "decision-choice-2",
      interruptionLevel: "time-sensitive",
      sound: "default",
    });
  });

  test.each<[string, DecisionFields]>([
    ["a deadline without a default", { deadline: START + 25 * MINUTE }],
    ["a default without a deadline", { default: { kind: "approve" } }],
  ])("%s adds no default line", async (_, fields) => {
    const { push } = await pushDecision(fields);
    expect(push?.body).toBe("Ship it?");
  });

  // The time left counts from the event's occurredAt: minutes rounded up below
  // an hour, whole hours rounded down from an hour on, and 0 min for a
  // deadline at or before the event.
  test.each<[number, string]>([
    [-5 * MINUTE, "0 min"],
    [0, "0 min"],
    [1, "1 min"],
    [30_000, "1 min"],
    [25 * MINUTE, "25 min"],
    [59 * MINUTE + 59_000, "60 min"],
    [60 * MINUTE, "1 h"],
    [119 * MINUTE, "1 h"],
    [120 * MINUTE, "2 h"],
  ])("a deadline %i ms after the event defaults in %s", async (delta, text) => {
    const { push } = await pushDecision({ deadline: START + delta, default: { kind: "approve" } });
    expect(push?.body).toBe(`Ship it?\nDefaults to Approve in ${text}`);
  });

  test("a later route counts the time left from the event, not the clock", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA);
    const decisionId = await insertDecision(t, userA, agentSessionId, {
      deadline: START + 25 * MINUTE,
      default: { kind: "approve" },
    });
    const eventId = await insertEvent(t, userA, "decision.created", { decisionId, agentSessionId });
    vi.setSystemTime(START + 20 * MINUTE);

    await route(t, eventId);

    const [push] = await queued(t, "install-1");
    expect(push?.body).toBe("Ship it?\nDefaults to Approve in 25 min");
  });

  test.each<["normal" | "urgent", string | undefined]>([
    ["normal", undefined],
    ["urgent", "time-sensitive"],
  ])("a %s decision has interruption level %s", async (priority, level) => {
    const { push } = await pushDecision({ priority });
    expect(push?.interruptionLevel).toBe(level);
    expect(push?.sound).toBe("default");
  });

  test("a decision whose asking session is gone or foreign is titled Ended agent", async () => {
    const { t, userA, userB, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const gone = await openSession(t, userA, "Release bot");
    const foreign = await openSession(t, userB, "Other bot");
    for (const agentSessionId of [gone, foreign]) {
      const decisionId = await insertDecision(t, userA, gone);
      const eventId = await insertEvent(t, userA, "decision.created", {
        decisionId,
        agentSessionId,
      });
      if (agentSessionId === gone) {
        await t.run((ctx) => ctx.db.delete("agentSessions", gone));
      }
      await route(t, eventId);
    }

    const pushes = await queued(t, "install-1");
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(push).toMatchObject({ title: "Ended agent", body: "Ship it?" });
    }
  });

  async function pushStale(line: string | undefined) {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const agentSessionId = await openSession(t, userA, "Release bot");
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", agentSessionId, {
        state: "working",
        line,
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
    return { push, eventId, agentSessionId };
  }

  test("a stale agent: agent title, minutes of silence, then the last status line", async () => {
    const { push, eventId, agentSessionId } = await pushStale("Running migrations");
    expect(push).toMatchObject({
      title: "Release bot",
      body: "Looks stuck · silent for 30 min\nRunning migrations",
    });
    expect(push?.categoryId).toBeUndefined();
    expect(push?.interruptionLevel).toBeUndefined();
    expect(push?.data).toEqual({ eventId, kind: "agent.stale", agentSessionId });
  });

  test("a stale agent without a status line has the silence line only", async () => {
    const { push } = await pushStale(undefined);
    expect(push).toMatchObject({ title: "Release bot", body: "Looks stuck · silent for 30 min" });
  });

  test("reads only rows the event's owner owns; a gone or foreign stale agent is Ended agent", async () => {
    const { t, userA, userB, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const foreignSession = await openSession(t, userB, "Other bot");
    await t.run((ctx) => ctx.db.patch("agentSessions", foreignSession, { line: "Secret work" }));
    const gone = await openSession(t, userA, "Release bot");
    await t.run((ctx) => ctx.db.delete("agentSessions", gone));

    for (const agentSessionId of [foreignSession, gone]) {
      await route(t, await insertEvent(t, userA, "agent.stale", { agentSessionId }));
    }

    const pushes = await queued(t, "install-1");
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(push).toMatchObject({ title: "Ended agent", body: "Looks stuck" });
      expect(push.interruptionLevel).toBeUndefined();
    }
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

  test("an expired decision with no applied answer: agent title, Expired body, no category, data", async () => {
    const { push, eventId, decisionId, agentSessionId } = await pushExpired({});
    expect(push).toMatchObject({ title: "Claude Code · repo/x", body: "Expired: Ship it?" });
    expect(push?.categoryId).toBeUndefined();
    expect(push?.interruptionLevel).toBeUndefined();
    expect(push?.data).toEqual({ eventId, kind: "decision.expired", decisionId, agentSessionId });
  });

  test.each<"normal" | "urgent">(["normal", "urgent"])(
    "an expired %s decision sets no interruption level",
    async (priority) => {
      const { push } = await pushExpired({
        priority,
        appliedByDefault: true,
        answer: { kind: "approve" },
      });
      expect(push).toMatchObject({
        title: "Claude Code · repo/x",
        body: "Decided by default: Ship it?\nApprove",
        sound: "default",
      });
      expect(push?.interruptionLevel).toBeUndefined();
    },
  );

  test("an expired decision whose asking session is gone or foreign is titled Ended agent", async () => {
    const { t, userA, userB, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await insertRule(t, userA, { eventKind: "decision.expired", action: "push" });
    const gone = await openSession(t, userA, "Release bot");
    const foreign = await openSession(t, userB, "Other bot");
    const decisionId = await insertDecision(t, userA, gone);
    await t.run(async (ctx) => {
      await ctx.db.patch("decisions", decisionId, { state: "expired", settledAt: START });
      await ctx.db.delete("agentSessions", gone);
    });

    for (const agentSessionId of [gone, foreign]) {
      await route(
        t,
        await insertEvent(t, userA, "decision.expired", { decisionId, agentSessionId }),
      );
    }

    const pushes = await queued(t, "install-1");
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(push).toMatchObject({ title: "Ended agent", body: "Expired: Ship it?" });
    }
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
    expect(push).toMatchObject({
      title: "Claude Code · repo/x",
      body: `Decided by default: Ship it?\n${answer}`,
    });
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
      expect(push?.interruptionLevel).toBeUndefined();
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

// Step 3 (req-notification-rules REQ-5, AC-5.1, AC-5.3) runs at the routing
// mutation's own time, so each test sets the clock to a fixed UTC instant
// before routing.
describe("quiet hours", () => {
  type Quiet = { timeZone: string; quietStart: string; quietEnd: string; urgentOverride?: boolean };

  async function quietSetup(quiet: Quiet) {
    const s = await setup();
    await register(s.asA, "install-1", "ExponentPushToken[1]");
    await s.asA.mutation(notifications.settings.updateSettings, quiet);
    const agentSessionId = await openSession(s.t, s.userA);
    return { ...s, agentSessionId };
  }

  // A `decision.created` event for a new decision of `priority`, routed at
  // `at`. Returns the stored action.
  async function routeDecisionAt(
    s: Awaited<ReturnType<typeof quietSetup>>,
    at: number,
    priority: "normal" | "urgent" = "normal",
  ) {
    vi.setSystemTime(at);
    const decisionId = await insertDecision(s.t, s.userA, s.agentSessionId, { priority });
    const eventId = await s.t.run((ctx) =>
      ctx.db.insert("events", {
        userId: s.userA,
        kind: "decision.created",
        topic: "repo/x",
        decisionId,
        agentSessionId: s.agentSessionId,
        priority,
        occurredAt: at,
      }),
    );
    return await routedAction(s.t, eventId);
  }

  const NY_DAY: Quiet = { timeZone: "America/New_York", quietStart: "09:00", quietEnd: "17:00" };
  const BERLIN_NIGHT: Quiet = {
    timeZone: "Europe/Berlin",
    quietStart: "22:00",
    quietEnd: "07:00",
  };

  // 2026-10-12 is EDT (UTC-4).
  test.each([
    ["08:59 EDT", Date.UTC(2026, 9, 12, 12, 59), "push"],
    ["09:00 EDT, the start", Date.UTC(2026, 9, 12, 13, 0), "digest"],
    ["16:59 EDT", Date.UTC(2026, 9, 12, 20, 59), "digest"],
    ["17:00 EDT, the end", Date.UTC(2026, 9, 12, 21, 0), "push"],
  ])("a window inside one day in New York at %s gives %s", async (_name, at, action) => {
    const s = await quietSetup(NY_DAY);
    expect(await routeDecisionAt(s, at)).toBe(action);
  });

  // 2026-10-12 is CEST (UTC+2).
  test.each([
    ["21:59 CEST", Date.UTC(2026, 9, 12, 19, 59), "push"],
    ["22:00 CEST, the start", Date.UTC(2026, 9, 12, 20, 0), "digest"],
    ["00:30 CEST, past midnight", Date.UTC(2026, 9, 12, 22, 30), "digest"],
    ["06:59 CEST", Date.UTC(2026, 9, 13, 4, 59), "digest"],
    ["07:00 CEST, the end", Date.UTC(2026, 9, 13, 5, 0), "push"],
  ])("a window across midnight in Berlin at %s gives %s", async (_name, at, action) => {
    const s = await quietSetup(BERLIN_NIGHT);
    expect(await routeDecisionAt(s, at)).toBe(action);
  });

  test("follows New York's offset on both sides of its spring change", async () => {
    const s = await quietSetup({
      timeZone: "America/New_York",
      quietStart: "07:00",
      quietEnd: "08:00",
    });
    // 11:30Z is 06:30 EST on 2026-03-07 and 07:30 EDT on 2026-03-09.
    expect(await routeDecisionAt(s, Date.UTC(2026, 2, 7, 11, 30))).toBe("push");
    expect(await routeDecisionAt(s, Date.UTC(2026, 2, 9, 11, 30))).toBe("digest");
  });

  test("follows Berlin's offset on both sides of its autumn change", async () => {
    const s = await quietSetup({
      timeZone: "Europe/Berlin",
      quietStart: "22:00",
      quietEnd: "23:00",
    });
    // 20:30Z is 22:30 CEST on 2026-10-24 and 21:30 CET on 2026-10-26.
    expect(await routeDecisionAt(s, Date.UTC(2026, 9, 24, 20, 30))).toBe("digest");
    expect(await routeDecisionAt(s, Date.UTC(2026, 9, 26, 20, 30))).toBe("push");
  });

  test("both occurrences of a repeated local time are quiet", async () => {
    const s = await quietSetup({
      timeZone: "America/New_York",
      quietStart: "01:00",
      quietEnd: "02:00",
    });
    // 01:30 EDT, then 01:30 EST, on 2026-11-01.
    expect(await routeDecisionAt(s, Date.UTC(2026, 10, 1, 5, 30))).toBe("digest");
    expect(await routeDecisionAt(s, Date.UTC(2026, 10, 1, 6, 30))).toBe("digest");
  });

  // req-notification-rules AC-5.1, AC-5.2
  test("an urgent decision is pushed during quiet hours while the override is on", async () => {
    const s = await quietSetup(BERLIN_NIGHT);
    const at = Date.UTC(2026, 9, 12, 22, 30);
    expect(await routeDecisionAt(s, at, "urgent")).toBe("push");
    expect(await routeDecisionAt(s, at, "normal")).toBe("digest");
    expect(await queued(s.t, "install-1")).toHaveLength(1);
  });

  test("an urgent decision goes to the digest during quiet hours with the override off", async () => {
    const s = await quietSetup({ ...BERLIN_NIGHT, urgentOverride: false });
    expect(await routeDecisionAt(s, Date.UTC(2026, 9, 12, 22, 30), "urgent")).toBe("digest");
    expect(await queued(s.t, "install-1")).toEqual([]);
  });

  test("a pushed agent event goes to the digest during quiet hours and sends nothing", async () => {
    const s = await quietSetup(BERLIN_NIGHT);
    vi.setSystemTime(Date.UTC(2026, 9, 12, 22, 30));
    const eventId = await insertEvent(s.t, s.userA, "agent.stale", {
      agentSessionId: s.agentSessionId,
    });
    expect(await routedAction(s.t, eventId)).toBe("digest");
    expect((await loadEvent(s.t, eventId))?.digestId).toBeUndefined();
    expect(await deliveriesOf(s.t, eventId)).toEqual([]);
    expect(await queued(s.t, "install-1")).toEqual([]);
  });

  test("digest and mute pass through unchanged, including an urgent decision's", async () => {
    const s = await quietSetup(BERLIN_NIGHT);
    const at = Date.UTC(2026, 9, 12, 22, 30);
    vi.setSystemTime(at);
    for (const [kind, action] of [
      ["decision.expired", "digest"],
      ["agent.done", "digest"],
      ["agent.status_changed", "mute"],
    ] as const) {
      const eventId = await insertEvent(s.t, s.userA, kind, { agentSessionId: s.agentSessionId });
      expect(await routedAction(s.t, eventId)).toBe(action);
    }

    await insertRule(s.t, s.userA, { priority: "urgent", action: "mute" });
    expect(await routeDecisionAt(s, at, "urgent")).toBe("mute");
    await insertRule(s.t, s.userA, {
      priority: "urgent",
      eventKind: "decision.created",
      action: "digest",
    });
    expect(await routeDecisionAt(s, at, "urgent")).toBe("digest");
    expect(await queued(s.t, "install-1")).toEqual([]);
  });

  test("a rule's push is downgraded the same way as a default push", async () => {
    const s = await quietSetup(BERLIN_NIGHT);
    await insertRule(s.t, s.userA, { eventKind: "agent.done", action: "push" });
    vi.setSystemTime(Date.UTC(2026, 9, 12, 22, 30));
    const quiet = await insertEvent(s.t, s.userA, "agent.done", {
      agentSessionId: s.agentSessionId,
    });
    expect(await routedAction(s.t, quiet)).toBe("digest");

    vi.setSystemTime(Date.UTC(2026, 9, 13, 10, 0));
    const loud = await insertEvent(s.t, s.userA, "agent.done", {
      agentSessionId: s.agentSessionId,
    });
    expect(await routedAction(s.t, loud)).toBe("push");
    expect(await queued(s.t, "install-1")).toHaveLength(1);
  });

  test("only the event owner's settings govern routing", async () => {
    const s = await setup();
    await register(s.asA, "install-1", "ExponentPushToken[1]");
    await s.asB.mutation(notifications.settings.updateSettings, {
      quietStart: "00:00",
      quietEnd: "23:59",
    });
    const agentSessionId = await openSession(s.t, s.userA);
    const decisionId = await insertDecision(s.t, s.userA, agentSessionId);
    const eventId = await insertEvent(s.t, s.userA, "decision.created", {
      agentSessionId,
      decisionId,
    });
    expect(await routedAction(s.t, eventId)).toBe("push");
    expect(await queued(s.t, "install-1")).toHaveLength(1);
  });
});

// component-notifications §Tables: `route` calls ensureSettings, so every
// account with a routed event has a row and a `nextDigestAt`
// (req-notification-rules REQ-6).
describe("settings from routing", () => {
  function settingsOf(t: Setup["t"]) {
    return t.run((ctx) => ctx.db.query("settings").collect());
  }

  test("creates the owner's default row with a next digest, for every action", async () => {
    const { t, userA, userB } = await setup();
    const agentSessionId = await openSession(t, userA);
    const eventId = await insertEvent(t, userA, "agent.status_changed", { agentSessionId });

    expect(await routedAction(t, eventId)).toBe("mute");

    const rows = await settingsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: userA,
      timeZone: "UTC",
      timeZoneSource: "default",
      digestTime: "09:00",
      // START is 12:00Z on 2026-10-11.
      nextDigestAt: Date.UTC(2026, 9, 12, 9, 0),
    });
    expect(rows.some((row) => row.userId === userB)).toBe(false);
  });

  test("later routes keep the row and its schedule, even when overdue", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);
    await route(t, await insertEvent(t, userA, "agent.done", { agentSessionId }));
    const [created] = await settingsOf(t);

    vi.setSystemTime(START + 3 * 24 * 60 * MINUTE);
    await route(t, await insertEvent(t, userA, "agent.done", { agentSessionId }));
    await route(t, await insertEvent(t, userA, "decision.expired", { agentSessionId }));

    expect(await settingsOf(t)).toEqual([created]);
  });

  test("an unrouted event creates no row", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);
    const routed = await insertEvent(t, userA, "agent.done", { agentSessionId });
    await route(t, routed);
    for (const row of await settingsOf(t)) {
      await t.run((ctx) => ctx.db.delete("settings", row._id));
    }

    // Already routed, and webhook-only: neither reaches step 4.
    await route(t, routed);
    await route(t, await insertEvent(t, userA, "decision.cancelled", { agentSessionId }));
    expect(await settingsOf(t)).toEqual([]);
  });

  test("a failed push rolls back a newly created row with the action", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);
    const eventId = await insertEvent(t, userA, "agent.stale", { agentSessionId });
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
    expect(await settingsOf(t)).toEqual([]);
  });
});

describe("interactive hold", () => {
  // The held push runs from the scheduler, and advancing the fake timers also
  // runs the push component's sender, so Expo is a fake that accepts every
  // message.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const messages = JSON.parse(String(init?.body ?? "[]")) as unknown[];
        return new Response(
          JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "x" })) }),
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Person A with two installs and a pending decision created at START, with
  // its `decision.created` event, not yet routed.
  async function holdSetup(fields: DecisionFields = { interactive: true }) {
    const s = await setup();
    await register(s.asA, "install-1", "ExponentPushToken[1]");
    await register(s.asA, "install-2", "ExponentPushToken[2]");
    const agentSessionId = await openSession(s.t, s.userA);
    const decisionId = await insertDecision(s.t, s.userA, agentSessionId, fields);
    const eventId = await insertEventWith(s.t, s.userA, "decision.created", {
      topic: "repo/x",
      decisionId,
      agentSessionId,
      priority: fields.priority ?? "normal",
    });
    return { ...s, agentSessionId, decisionId, eventId };
  }

  // Lets the scheduler run every job due within `ms`, then waits for the jobs
  // it started.
  async function runScheduled(t: Setup["t"], ms: number) {
    vi.advanceTimersByTime(ms);
    await t.finishInProgressScheduledFunctions();
  }

  // Every scheduled `deliverHeld` run, oldest first.
  async function heldRuns(t: Setup["t"]) {
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    return jobs
      .filter((job) => job.name.endsWith(":deliverHeld"))
      .map((job) => ({
        eventId: (job.args[0] as { eventId: Id<"events"> }).eventId,
        at: job.scheduledTime,
        state: job.state.kind,
      }));
  }

  // The pushes queued for both installs.
  async function queuedBoth(t: Setup["t"]) {
    return [(await queued(t, "install-1")).length, (await queued(t, "install-2")).length];
  }

  function deliverHeld(t: Setup["t"], eventId: Id<"events">) {
    return t.mutation(notifications.route.deliverHeld, { eventId });
  }

  // req-notification-rules AC-8.1
  test("queues nothing at routing and pushes once per device two minutes after creation", async () => {
    const { t, eventId } = await holdSetup();

    await route(t, eventId);

    expect((await loadEvent(t, eventId))?.action).toBe("push");
    expect(await queuedBoth(t)).toEqual([0, 0]);
    expect(await deliveriesOf(t, eventId)).toEqual([]);
    expect(await heldRuns(t)).toEqual([
      { eventId, at: START + INTERACTIVE_HOLD_MS, state: "pending" },
    ]);

    await runScheduled(t, INTERACTIVE_HOLD_MS - 1);
    expect(await queuedBoth(t)).toEqual([0, 0]);

    await runScheduled(t, 1);
    expect(await queuedBoth(t)).toEqual([1, 1]);
    expect(await deliveriesOf(t, eventId)).toHaveLength(2);
    expect((await loadEvent(t, eventId))?.action).toBe("push");
    expect((await heldRuns(t)).map((run) => run.state)).toEqual(["success"]);
  });

  test("the held push carries the same message and data as an immediate one", async () => {
    const { t, eventId, decisionId, agentSessionId } = await holdSetup();
    await route(t, eventId);
    await runScheduled(t, INTERACTIVE_HOLD_MS);

    const [push] = await queued(t, "install-1");
    expect(push).toMatchObject({
      title: "Claude Code · repo/x",
      body: "Ship it?",
      categoryId: "decision-approve-reject",
    });
    expect(push?.interruptionLevel).toBeUndefined();
    expect(push?.data).toEqual({ eventId, kind: "decision.created", decisionId, agentSessionId });
  });

  test("a held urgent push is time-sensitive and counts its default from the event", async () => {
    const { t, eventId } = await holdSetup({
      interactive: true,
      priority: "urgent",
      deadline: START + 25 * MINUTE,
      default: { kind: "reject" },
    });
    await route(t, eventId);
    expect(await queuedBoth(t)).toEqual([0, 0]);
    await runScheduled(t, INTERACTIVE_HOLD_MS);

    for (const deviceId of ["install-1", "install-2"]) {
      const [push] = await queued(t, deviceId);
      expect(push).toMatchObject({
        title: "Claude Code · repo/x",
        body: "Ship it?\nDefaults to Reject in 25 min",
        categoryId: "decision-approve-reject",
        interruptionLevel: "time-sensitive",
        sound: "default",
      });
    }
  });

  // req-notification-rules AC-8.1; req-decision-requests AC-8.1
  type HoldSetup = Awaited<ReturnType<typeof holdSetup>>;
  test.each<[string, (s: HoldSetup) => Promise<unknown>]>([
    [
      "an answer from the app",
      (s) =>
        s.asA.mutation(decisions.app.answer, {
          decisionId: s.decisionId,
          answer: { kind: "approve" },
        }),
    ],
    [
      "an answer from a notification",
      (s) =>
        s.asA.mutation(decisions.app.answerFromNotification, {
          decisionId: s.decisionId,
          action: "approve",
        }),
    ],
    [
      "an answer relayed from chat",
      (s) =>
        s.t.mutation(decisions.operations.resolve, {
          userId: s.userA,
          agentSessionId: s.agentSessionId,
          decisionId: s.decisionId,
          answer: { kind: "approve" },
          chatMessage: "yes, ship it",
        }),
    ],
    [
      "a cancellation",
      (s) =>
        s.t.mutation(decisions.operations.cancel, { userId: s.userA, decisionId: s.decisionId }),
    ],
    ["an expiry", (s) => s.t.mutation(decisions.expire.run, { decisionId: s.decisionId })],
    [
      "an answer and a removal",
      async (s) => {
        await s.asA.mutation(decisions.app.answer, {
          decisionId: s.decisionId,
          answer: { kind: "reject" },
        });
        await s.asA.mutation(decisions.app.remove, { decisionId: s.decisionId });
      },
    ],
  ])("sends nothing after %s within the hold, and the action stays push", async (_, settle) => {
    const s = await holdSetup({ interactive: true, deadline: START + MINUTE });
    await route(s.t, s.eventId);

    await runScheduled(s.t, MINUTE);
    await settle(s);
    await runScheduled(s.t, INTERACTIVE_HOLD_MS);

    expect(await queuedBoth(s.t)).toEqual([0, 0]);
    expect(await deliveriesOf(s.t, s.eventId)).toEqual([]);
    const event = await loadEvent(s.t, s.eventId);
    expect(event?.action).toBe("push");
    expect(event?.digestId).toBeUndefined();
    expect((await heldRuns(s.t)).map((run) => run.state)).toEqual(["success"]);
  });

  // req-notification-rules AC-8.2
  test.each<[string, DecisionFields]>([
    ["false", { interactive: false }],
    ["unset", {}],
  ])("pushes a decision whose interactive flag is %s at once", async (_, fields) => {
    const { t, eventId } = await holdSetup(fields);

    await route(t, eventId);

    expect(await queuedBoth(t)).toEqual([1, 1]);
    expect(await heldRuns(t)).toEqual([]);
  });

  test.each<"digest" | "mute">(["digest", "mute"])(
    "a rule's %s routes an interactive decision with no hold",
    async (action) => {
      const { t, userA, eventId } = await holdSetup();
      await insertRule(t, userA, { eventKind: "decision.created", action });

      expect(await routedAction(t, eventId)).toBe(action);
      await runScheduled(t, INTERACTIVE_HOLD_MS);

      expect(await heldRuns(t)).toEqual([]);
      expect(await queuedBoth(t)).toEqual([0, 0]);
    },
  );

  // req-notification-rules REQ-5, AC-8.1. START is 12:00Z; Berlin is UTC+2, so
  // a 13:00–15:00 window there holds START.
  const QUIET = { timeZone: "Europe/Berlin", quietStart: "13:00", quietEnd: "15:00" };

  test("quiet hours send an interactive decision to the digest with no hold", async () => {
    const s = await holdSetup();
    await s.asA.mutation(notifications.settings.updateSettings, QUIET);

    expect(await routedAction(s.t, s.eventId)).toBe("digest");
    await runScheduled(s.t, INTERACTIVE_HOLD_MS);

    expect(await heldRuns(s.t)).toEqual([]);
    expect(await queuedBoth(s.t)).toEqual([0, 0]);
  });

  test.each<[string, boolean, "push" | "digest"]>([
    ["holds an urgent decision the override keeps as push", true, "push"],
    ["sends an urgent decision to the digest with the override off", false, "digest"],
  ])("during quiet hours, %s", async (_, urgentOverride, action) => {
    const s = await holdSetup({ interactive: true, priority: "urgent" });
    await s.asA.mutation(notifications.settings.updateSettings, { ...QUIET, urgentOverride });

    expect(await routedAction(s.t, s.eventId)).toBe(action);
    expect(await queuedBoth(s.t)).toEqual([0, 0]);
    await runScheduled(s.t, INTERACTIVE_HOLD_MS);

    expect(await queuedBoth(s.t)).toEqual(action === "push" ? [1, 1] : [0, 0]);
    expect(await heldRuns(s.t)).toHaveLength(action === "push" ? 1 : 0);
  });

  test("a quiet window that starts during the hold leaves the held push sent", async () => {
    const s = await holdSetup();
    // Berlin 14:01 is 12:01Z, one minute into the hold.
    await s.asA.mutation(notifications.settings.updateSettings, {
      timeZone: "Europe/Berlin",
      quietStart: "14:01",
      quietEnd: "15:00",
    });

    expect(await routedAction(s.t, s.eventId)).toBe("push");
    await runScheduled(s.t, INTERACTIVE_HOLD_MS);

    expect(await queuedBoth(s.t)).toEqual([1, 1]);
  });

  // req-notification-rules REQ-7
  test("a repeated route holds once, and a repeated held run sends once", async () => {
    const { t, eventId } = await holdSetup();

    await route(t, eventId);
    await route(t, eventId);
    await Promise.all([route(t, eventId), route(t, eventId)]);
    expect(await heldRuns(t)).toHaveLength(1);

    await runScheduled(t, INTERACTIVE_HOLD_MS);
    await deliverHeld(t, eventId);
    await Promise.all([deliverHeld(t, eventId), deliverHeld(t, eventId)]);

    expect(await queuedBoth(t)).toEqual([1, 1]);
    expect(await deliveriesOf(t, eventId)).toHaveLength(2);
  });

  test("a late route still ends the hold two minutes after creation", async () => {
    const { t, eventId } = await holdSetup();

    vi.setSystemTime(START + MINUTE);
    await route(t, eventId);
    expect((await heldRuns(t)).map((run) => run.at)).toEqual([START + INTERACTIVE_HOLD_MS]);

    await runScheduled(t, MINUTE - 1);
    expect(await queuedBoth(t)).toEqual([0, 0]);
    await runScheduled(t, 1);
    expect(await queuedBoth(t)).toEqual([1, 1]);
  });

  test("a route after the hold has ended pushes at once from the scheduler", async () => {
    const { t, eventId } = await holdSetup();

    vi.setSystemTime(START + 3 * MINUTE);
    await route(t, eventId);
    expect(await queuedBoth(t)).toEqual([0, 0]);

    await runScheduled(t, 0);
    expect(await queuedBoth(t)).toEqual([1, 1]);
  });

  // component-notifications §Account deletion
  test.each<[string, (s: HoldSetup) => Promise<unknown>]>([
    [
      "an owner being deleted",
      (s) => s.t.run((ctx) => ctx.db.patch("users", s.userA, { deletingAt: Date.now() })),
    ],
    ["a deleted owner", (s) => s.t.run((ctx) => ctx.db.delete("users", s.userA))],
    ["a purged event", (s) => s.t.run((ctx) => ctx.db.delete("events", s.eventId))],
  ])("sends nothing for %s", async (_, remove) => {
    const s = await holdSetup();
    await route(s.t, s.eventId);

    await remove(s);
    await runScheduled(s.t, INTERACTIVE_HOLD_MS);

    expect(await queuedBoth(s.t)).toEqual([0, 0]);
    expect(await deliveriesOf(s.t, s.eventId)).toEqual([]);
  });

  test("sends nothing for an event whose stored action is not push or whose decision is foreign", async () => {
    const s = await holdSetup();
    await route(s.t, s.eventId);
    await s.t.run((ctx) => ctx.db.patch("events", s.eventId, { action: "digest" }));
    await deliverHeld(s.t, s.eventId);

    const sessionB = await openSession(s.t, s.userB);
    const foreign = await insertDecision(s.t, s.userB, sessionB, { interactive: true });
    const misfiled = await insertEventWith(s.t, s.userA, "decision.created", {
      decisionId: foreign,
      agentSessionId: s.agentSessionId,
    });
    await s.t.run((ctx) => ctx.db.patch("events", misfiled, { action: "push" }));
    await deliverHeld(s.t, misfiled);

    expect(await queuedBoth(s.t)).toEqual([0, 0]);
  });

  test("a failed held send stores no delivery, and a later run delivers", async () => {
    const { t, userA, asA, eventId } = await holdSetup();
    // A device row whose install never gave the component a token makes the
    // send throw.
    await t.run((ctx) =>
      ctx.db.insert("devices", {
        userId: userA,
        deviceId: "install-3",
        name: "Phone",
        platform: "ios",
      }),
    );
    await route(t, eventId);
    vi.setSystemTime(START + INTERACTIVE_HOLD_MS);

    await expect(deliverHeld(t, eventId)).rejects.toThrow();
    expect(await deliveriesOf(t, eventId)).toEqual([]);
    expect(await queuedBoth(t)).toEqual([0, 0]);

    await register(asA, "install-3", "ExponentPushToken[3]");
    await deliverHeld(t, eventId);
    expect(await deliveriesOf(t, eventId)).toHaveLength(3);
    expect(await queued(t, "install-3")).toHaveLength(1);
    expect((await loadEvent(t, eventId))?.action).toBe("push");
  });
});
