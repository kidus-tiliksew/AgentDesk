import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import { answerDecision } from "../decisions/model";
import { decisions } from "../decisions/refs";
import { notifications } from "./refs";
import {
  eventsOf,
  openSession,
  queued,
  register,
  type Setup,
  scheduledRoutes,
  setup,
} from "./test.setup";

// The emitters of component-decisions §State machine and
// component-agent-presence §Lifecycle and §Sweep, each raising exactly one
// event per transition through `emit`.

const START = Date.UTC(2026, 9, 11, 12, 0, 0);
const MINUTE = 60_000;

const approve = { title: "Ship it?", input_type: "approve_reject", topic: "repo/x" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

async function decisionSetup() {
  const base = await setup();
  const { t, userA } = base;
  const agentSessionId = await openSession(t, userA);
  const ask = (input: Record<string, unknown>) =>
    t.mutation(decisions.operations.create, { userId: userA, agentSessionId, input });
  const kinds = async () => (await eventsOf(t)).map((event) => event.kind);
  return { ...base, agentSessionId, ask, kinds };
}

describe("decision transitions", () => {
  test("create emits one decision.created and schedules its route", async () => {
    const { t, userA, agentSessionId, ask } = await decisionSetup();

    const decision = await ask({ ...approve, priority: "urgent" });

    const events = await eventsOf(t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: userA,
      kind: "decision.created",
      topic: "repo/x",
      decisionId: decision.id,
      agentSessionId,
      priority: "urgent",
      occurredAt: START,
    });
    expect(await scheduledRoutes(t)).toEqual([events[0]?._id]);
  });

  test("an idempotent retry emits nothing", async () => {
    const { ask, kinds } = await decisionSetup();
    const first = await ask({ ...approve, idempotency_key: "k1" });

    vi.setSystemTime(START + MINUTE);
    const retried = await ask({ ...approve, idempotency_key: "k1" });

    expect(retried.id).toBe(first.id);
    expect(await kinds()).toEqual(["decision.created"]);
  });

  test("answer emits one decision.answered with a null action", async () => {
    const { t, ask, kinds } = await decisionSetup();
    const decision = await ask(approve);

    vi.setSystemTime(START + MINUTE);
    await t.run(async (ctx) => {
      const doc = await ctx.db.get("decisions", decision.id as Id<"decisions">);
      if (doc === null) throw new Error("missing");
      await answerDecision(ctx, doc, { kind: "approve" }, undefined, "app", Date.now());
    });

    expect(await kinds()).toEqual(["decision.created", "decision.answered"]);
    const answered = (await eventsOf(t))[1];
    expect(answered).toMatchObject({ occurredAt: START + MINUTE, action: null });
    expect(await scheduledRoutes(t)).toHaveLength(1);
  });

  test("cancel emits one decision.cancelled with a null action", async () => {
    const { t, userA, ask, kinds } = await decisionSetup();
    const decision = await ask(approve);

    await t.mutation(decisions.operations.cancel, { userId: userA, decisionId: decision.id });

    expect(await kinds()).toEqual(["decision.created", "decision.cancelled"]);
    expect((await eventsOf(t))[1]?.action).toBeNull();
    expect(await scheduledRoutes(t)).toHaveLength(1);
  });

  test.each([
    ["with", { default: { kind: "reject" } }],
    ["without", {}],
  ])("expiry %s a default emits one decision.expired", async (_label, extra) => {
    const { t, ask, kinds } = await decisionSetup();
    const deadline = START + 10 * MINUTE;
    const decision = await ask({
      ...approve,
      ...extra,
      deadline: new Date(deadline).toISOString(),
    });

    vi.setSystemTime(deadline);
    await t.mutation(decisions.expire.run, { decisionId: decision.id as Id<"decisions"> });

    expect(await kinds()).toEqual(["decision.created", "decision.expired"]);
    const expired = (await eventsOf(t))[1];
    expect(expired).toMatchObject({ decisionId: decision.id, occurredAt: deadline });
    expect(await scheduledRoutes(t)).toEqual((await eventsOf(t)).map((event) => event._id));
  });

  test("a created decision reaches the owner's device through its route", async () => {
    const { t, asA, ask } = await decisionSetup();
    await register(asA, "install-1", "ExponentPushToken[1]");

    await ask(approve);
    // Runs the scheduled route alone; draining every scheduled job would also
    // start the push component's sender.
    for (const eventId of await scheduledRoutes(t)) {
      await t.mutation(notifications.route.run, { eventId });
    }

    const [push] = await queued(t, "install-1");
    expect(push).toMatchObject({
      title: "Claude Code · repo/x",
      body: "Ship it?",
      categoryId: "decision-approve-reject",
    });
    expect((await eventsOf(t))[0]?.action).toBe("push");
  });
});

describe("agent transitions", () => {
  function status(t: Setup["t"], userId: Id<"users">, agentSessionId: Id<"agentSessions">) {
    return (state: string) =>
      t.mutation(agents.sessions.status, {
        userId,
        agentSessionId,
        topic: "repo/x",
        state,
        line: `Now ${state}`,
      });
  }

  test("a status emits one agent.status_changed", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);

    vi.setSystemTime(START + MINUTE);
    await status(t, userA, agentSessionId)("working");

    const events = await eventsOf(t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: userA,
      kind: "agent.status_changed",
      topic: "repo/x",
      agentSessionId,
      occurredAt: START + MINUTE,
    });
    expect(events[0]?.priority).toBeUndefined();
    expect(events[0]?.decisionId).toBeUndefined();
  });

  test("a done status emits agent.status_changed, then agent.done, at one time", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);

    vi.setSystemTime(START + MINUTE);
    await status(t, userA, agentSessionId)("done");

    const events = await eventsOf(t);
    expect(events.map((event) => [event.kind, event.occurredAt])).toEqual([
      ["agent.status_changed", START + MINUTE],
      ["agent.done", START + MINUTE],
    ]);
    expect(await scheduledRoutes(t)).toEqual(events.map((event) => event._id));
  });

  test("a rejected status emits nothing", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);

    await expect(status(t, userA, agentSessionId)("sleeping")).rejects.toThrow();

    expect(await eventsOf(t)).toEqual([]);
  });

  // req-agent-status AC-3.2, AC-3.3
  test("the sweep emits one agent.stale per silence", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);
    const sweep = async (at: number) => {
      vi.setSystemTime(at);
      await t.mutation(agents.sweep.run, {});
    };
    const stale = async () => (await eventsOf(t)).filter((event) => event.kind === "agent.stale");

    await sweep(START + 29 * MINUTE);
    expect(await stale()).toEqual([]);
    await sweep(START + 30 * MINUTE);
    await sweep(START + 31 * MINUTE);
    await sweep(START + 45 * MINUTE);
    expect((await stale()).map((event) => event.occurredAt)).toEqual([START + 30 * MINUTE]);

    const touchedAt = START + 46 * MINUTE;
    await t.run((ctx) => touch(ctx, userA, agentSessionId, undefined, touchedAt));
    await sweep(touchedAt + 30 * MINUTE);
    await sweep(touchedAt + 31 * MINUTE);

    const events = await stale();
    expect(events.map((event) => event.occurredAt)).toEqual([
      START + 30 * MINUTE,
      touchedAt + 30 * MINUTE,
    ]);
    expect(events[0]).toMatchObject({ userId: userA, topic: "repo/x", agentSessionId });
  });
});
