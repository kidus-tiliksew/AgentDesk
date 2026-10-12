import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { notifications } from "./refs";
import { openSession, type Setup, setup } from "./test.setup";

const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const MINUTE = 60_000;
const unauthenticated = { data: { code: "unauthenticated" } };
const ruleNotFound = { data: { code: "not_found", message: "Notification rule not found" } };
const sessionNotFound = { data: { code: "not_found", message: "Agent session not found" } };
const invalid = (field?: string) => ({ data: { code: "invalid", ...(field ? { field } : {}) } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

function rulesOf(t: Setup["t"]) {
  return t.run((ctx) => ctx.db.query("rules").collect());
}

// An id of `table` whose row no longer exists.
async function deletedId<T extends "rules" | "agentSessions">(
  t: Setup["t"],
  userId: Id<"users">,
  table: T,
): Promise<Id<T>> {
  if (table === "agentSessions") {
    const id = await openSession(t, userId);
    await t.run((ctx) => ctx.db.delete("agentSessions", id));
    return id as Id<T>;
  }
  const id = await t.run((ctx) =>
    ctx.db.insert("rules", { userId, topic: "gone", action: "mute", updatedAt: START }),
  );
  await t.run((ctx) => ctx.db.delete("rules", id));
  return id as Id<T>;
}

describe("save", () => {
  // req-notification-rules REQ-3
  test("creates a rule with a normalized topic and returns its read shape", async () => {
    const { t, userA, asA } = await setup();
    const agentSessionId = await openSession(t, userA);

    const rule = await asA.mutation(notifications.rules.save, {
      topic: "Acme/Billing",
      agentSessionId,
      eventKind: "decision.created",
      priority: "urgent",
      action: "push",
    });

    expect(rule).toEqual({
      id: expect.any(String),
      topic: "acme/billing",
      agent_session_id: agentSessionId,
      event_kind: "decision.created",
      priority: "urgent",
      action: "push",
      updated_at: new Date(START).toISOString(),
    });
    const [stored] = await rulesOf(t);
    expect(stored).toMatchObject({
      _id: rule.id,
      userId: userA,
      topic: "acme/billing",
      agentSessionId,
      updatedAt: START,
    });
  });

  test("returns null for each match field the rule leaves out", async () => {
    const { asA } = await setup();
    const rule = await asA.mutation(notifications.rules.save, {
      eventKind: "agent.done",
      action: "digest",
    });
    expect(rule).toMatchObject({
      topic: null,
      agent_session_id: null,
      event_kind: "agent.done",
      priority: null,
      action: "digest",
    });
  });

  // req-notification-rules AC-3.3
  test("refuses a rule with no match field", async () => {
    const { t, asA } = await setup();
    await expect(asA.mutation(notifications.rules.save, { action: "mute" })).rejects.toMatchObject(
      invalid(),
    );
    expect(await rulesOf(t)).toEqual([]);
  });

  test.each([
    [{ topic: "" }, "topic"],
    [{ topic: "has space" }, "topic"],
    [{ topic: "x".repeat(101) }, "topic"],
    [{ eventKind: "decision.answered" }, "eventKind"],
    [{ eventKind: "decision.cancelled" }, "eventKind"],
    [{ eventKind: "agent.started" }, "eventKind"],
    [{ topic: "repo", priority: "high" }, "priority"],
    [{ topic: "repo", action: "email" }, "action"],
    [{ topic: "repo", action: "" }, "action"],
    [{ agentSessionId: "not-an-id" }, "agentSessionId"],
    [{ topic: "repo", ruleId: "not-an-id" }, "ruleId"],
  ])("refuses %o as invalid naming %s", async (fields, field) => {
    const { t, asA } = await setup();
    await expect(
      asA.mutation(notifications.rules.save, { action: "push", ...fields }),
    ).rejects.toMatchObject(invalid(field));
    expect(await rulesOf(t)).toEqual([]);
  });

  // req-accounts-and-connections AC-1.1
  test("refuses a foreign and a missing agent session alike", async () => {
    const { t, userA, userB, asA } = await setup();
    const foreign = await openSession(t, userB);
    const missing = await deletedId(t, userA, "agentSessions");

    for (const agentSessionId of [foreign, missing]) {
      await expect(
        asA.mutation(notifications.rules.save, { agentSessionId, action: "mute" }),
      ).rejects.toMatchObject(sessionNotFound);
    }
    expect(await rulesOf(t)).toEqual([]);
  });

  test("saves priority with an agent-only kind", async () => {
    const { asA } = await setup();
    const rule = await asA.mutation(notifications.rules.save, {
      eventKind: "agent.done",
      priority: "urgent",
      action: "push",
    });
    expect(rule).toMatchObject({ event_kind: "agent.done", priority: "urgent" });
  });

  test("replaces an owned rule, clearing omitted match fields and stamping the save time", async () => {
    const { t, userA, asA } = await setup();
    const agentSessionId = await openSession(t, userA);
    const created = await asA.mutation(notifications.rules.save, {
      topic: "repo",
      agentSessionId,
      priority: "urgent",
      action: "push",
    });
    vi.advanceTimersByTime(MINUTE);

    const updated = await asA.mutation(notifications.rules.save, {
      ruleId: created.id,
      eventKind: "agent.stale",
      action: "mute",
    });

    expect(updated).toEqual({
      id: created.id,
      topic: null,
      agent_session_id: null,
      event_kind: "agent.stale",
      priority: null,
      action: "mute",
      updated_at: new Date(START + MINUTE).toISOString(),
    });
    const stored = await rulesOf(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty("topic");
    expect(stored[0]).not.toHaveProperty("agentSessionId");
    expect(stored[0]).not.toHaveProperty("priority");

    vi.advanceTimersByTime(MINUTE);
    const unchanged = await asA.mutation(notifications.rules.save, {
      ruleId: created.id,
      eventKind: "agent.stale",
      action: "mute",
    });
    expect(unchanged.updated_at).toBe(new Date(START + 2 * MINUTE).toISOString());
  });

  test("refuses to update a foreign and a missing rule alike", async () => {
    const { t, userA, asA, asB } = await setup();
    const foreign = await asB.mutation(notifications.rules.save, { topic: "b", action: "mute" });
    const missing = await deletedId(t, userA, "rules");

    for (const ruleId of [foreign.id, missing]) {
      await expect(
        asA.mutation(notifications.rules.save, { ruleId, topic: "a", action: "push" }),
      ).rejects.toMatchObject(ruleNotFound);
    }
    expect(await asB.query(notifications.rules.list, {})).toEqual([foreign]);
  });

  test("is unauthenticated without a signed-in person and writes nothing", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(notifications.rules.save, { topic: "repo", action: "push" }),
    ).rejects.toMatchObject(unauthenticated);
    expect(await rulesOf(t)).toEqual([]);
  });
});

describe("list", () => {
  test("returns only the person's rules, latest save first, then newest created", async () => {
    const { asA, asB } = await setup();
    const first = await asA.mutation(notifications.rules.save, { topic: "a", action: "push" });
    const second = await asA.mutation(notifications.rules.save, { topic: "b", action: "push" });
    vi.advanceTimersByTime(MINUTE);
    const third = await asA.mutation(notifications.rules.save, { topic: "c", action: "push" });
    await asB.mutation(notifications.rules.save, { topic: "d", action: "push" });

    const rules = await asA.query(notifications.rules.list, {});

    expect(rules.map((rule) => rule.id)).toEqual([third.id, second.id, first.id]);
    expect(rules[0]).toEqual(third);
  });

  test("moves a rule to the front when it is saved again", async () => {
    const { asA } = await setup();
    const first = await asA.mutation(notifications.rules.save, { topic: "a", action: "push" });
    const second = await asA.mutation(notifications.rules.save, { topic: "b", action: "push" });
    vi.advanceTimersByTime(MINUTE);
    await asA.mutation(notifications.rules.save, { ruleId: first.id, topic: "a", action: "mute" });

    const rules = await asA.query(notifications.rules.list, {});
    expect(rules.map((rule) => rule.id)).toEqual([first.id, second.id]);
  });

  test("is unauthenticated without a signed-in person", async () => {
    const { t } = await setup();
    await expect(t.query(notifications.rules.list, {})).rejects.toMatchObject(unauthenticated);
  });
});

describe("remove", () => {
  test("deletes an owned rule", async () => {
    const { t, asA } = await setup();
    const rule = await asA.mutation(notifications.rules.save, { topic: "a", action: "push" });

    expect(await asA.mutation(notifications.rules.remove, { ruleId: rule.id })).toBeNull();

    expect(await rulesOf(t)).toEqual([]);
  });

  test("refuses a foreign and a missing rule alike and a malformed id as invalid", async () => {
    const { t, userA, asA, asB } = await setup();
    const foreign = await asB.mutation(notifications.rules.save, { topic: "b", action: "mute" });
    const missing = await deletedId(t, userA, "rules");

    for (const ruleId of [foreign.id, missing]) {
      await expect(asA.mutation(notifications.rules.remove, { ruleId })).rejects.toMatchObject(
        ruleNotFound,
      );
    }
    await expect(
      asA.mutation(notifications.rules.remove, { ruleId: "not-an-id" }),
    ).rejects.toMatchObject(invalid("ruleId"));
    expect(await asB.query(notifications.rules.list, {})).toEqual([foreign]);
  });

  test("is unauthenticated without a signed-in person and deletes nothing", async () => {
    const { t, asA } = await setup();
    const rule = await asA.mutation(notifications.rules.save, { topic: "a", action: "push" });
    await expect(t.mutation(notifications.rules.remove, { ruleId: rule.id })).rejects.toMatchObject(
      unauthenticated,
    );
    expect(await rulesOf(t)).toHaveLength(1);
  });
});
