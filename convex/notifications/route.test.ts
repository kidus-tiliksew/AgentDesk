import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventKind } from "./events";
import { notifications } from "./refs";
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
