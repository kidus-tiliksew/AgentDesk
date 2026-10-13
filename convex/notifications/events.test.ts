import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { insertDecision } from "../decisions/model";
import { type EventKind, emit } from "./events";
import { eventsOf, openSession, scheduledRoutes, setup } from "./test.setup";

const START = Date.UTC(2026, 9, 11, 12, 0, 0);

// Fake timers keep scheduled routes and the push component's sender from
// running, so each test inspects what `emit` stored and scheduled.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("emit", () => {
  // req-notification-rules REQ-2
  test.each<EventKind>([
    "decision.created",
    "decision.expired",
    "agent.stale",
    "agent.status_changed",
    "agent.done",
  ])("stores %s without an action and schedules its route", async (kind) => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);

    const eventId = await t.run((ctx) =>
      emit(ctx, { userId: userA, kind, topic: "repo/x", agentSessionId, occurredAt: START }),
    );

    const [event, ...rest] = await eventsOf(t);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      _id: eventId,
      userId: userA,
      kind,
      topic: "repo/x",
      agentSessionId,
      occurredAt: START,
    });
    expect(event?.action).toBeUndefined();
    expect(event?.digestId).toBeUndefined();
    expect(await scheduledRoutes(t)).toEqual([eventId]);
  });

  test.each<EventKind>(["decision.answered", "decision.cancelled"])(
    "stores %s with a null action and schedules no route",
    async (kind) => {
      const { t, userA } = await setup();

      await t.run((ctx) => emit(ctx, { userId: userA, kind, topic: "repo/x", occurredAt: START }));

      const events = await eventsOf(t);
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBeNull();
      expect(await scheduledRoutes(t)).toEqual([]);
    },
  );

  test("an emitter that rolls back leaves no event and no route", async () => {
    const { t, userA } = await setup();
    const agentSessionId = await openSession(t, userA);

    await expect(
      t.run(async (ctx) => {
        await insertDecision(
          ctx,
          userA,
          agentSessionId,
          {
            title: "Ship it?",
            input_type: "approve_reject",
            topic: "repo/x",
            priority: "normal",
            interactive: false,
          },
          START,
        );
        throw new Error("emitter failed");
      }),
    ).rejects.toThrow("emitter failed");

    expect(await t.run((ctx) => ctx.db.query("decisions").collect())).toEqual([]);
    expect(await eventsOf(t)).toEqual([]);
    expect(await scheduledRoutes(t)).toEqual([]);
  });
});
