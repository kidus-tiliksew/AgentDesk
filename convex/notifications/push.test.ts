import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { deliverDigestPush, deliverPush } from "./push";
import { notifications } from "./refs";
import { queued, register, type Setup, setup } from "./test.setup";

const START = Date.UTC(2026, 9, 11, 12, 0, 0);

// Fake timers keep the push component's scheduled sender from running.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

// A decision event and an agent event owned by `userId`, with the session and
// decision rows they point at.
async function insertEvents(t: Setup["t"], userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const credentialId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: "0".repeat(64),
    });
    const agentSessionId = await ctx.db.insert("agentSessions", {
      userId,
      credentialId,
      mcpSessionId: "1".repeat(64),
      clientName: "Claude Code",
      clientVersion: "2.1.0",
      lastActivityAt: START,
    });
    const decisionId = await ctx.db.insert("decisions", {
      userId,
      agentSessionId,
      topic: "repo/x",
      title: "Ship it?",
      inputType: "approve_reject",
      priority: "normal",
      state: "pending",
      searchText: "Ship it?",
    });
    const decisionEventId = await ctx.db.insert("events", {
      userId,
      kind: "decision.created",
      topic: "repo/x",
      decisionId,
      agentSessionId,
      priority: "normal",
      occurredAt: START,
    });
    const agentEventId = await ctx.db.insert("events", {
      userId,
      kind: "agent.stale",
      topic: "repo/x",
      agentSessionId,
      occurredAt: START,
    });
    return { agentSessionId, decisionId, decisionEventId, agentEventId };
  });
}

function deliver(t: Setup["t"], eventId: Id<"events">, title = "Ship it?") {
  return t.run((ctx) => deliverPush(ctx, eventId, { title }));
}

function deliveriesOf(t: Setup["t"], eventId: Id<"events">) {
  return t.run((ctx) =>
    ctx.db
      .query("pushDeliveries")
      .withIndex("by_event_device", (q) => q.eq("eventId", eventId))
      .collect(),
  );
}

describe("deliverPush", () => {
  test("queues one notification per device per event across repeated calls", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await register(asA, "install-2", "ExponentPushToken[2]");
    const { decisionEventId, agentEventId } = await insertEvents(t, userA);

    await deliver(t, decisionEventId);
    await deliver(t, decisionEventId);
    await Promise.all([deliver(t, decisionEventId), deliver(t, decisionEventId)]);

    for (const deviceId of ["install-1", "install-2"]) {
      expect(await queued(t, deviceId)).toHaveLength(1);
    }
    expect(await deliveriesOf(t, decisionEventId)).toHaveLength(2);

    // A different event reaches each device once more.
    await deliver(t, agentEventId, "Agent looks stuck");
    await deliver(t, agentEventId, "Agent looks stuck");
    for (const deviceId of ["install-1", "install-2"]) {
      expect(await queued(t, deviceId)).toHaveLength(2);
    }
    expect(await deliveriesOf(t, agentEventId)).toHaveLength(2);
  });

  test("carries the routing fields and keeps the caller's presentation", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const { agentSessionId, decisionId, decisionEventId, agentEventId } = await insertEvents(
      t,
      userA,
    );

    await t.run((ctx) =>
      deliverPush(ctx, decisionEventId, {
        title: "Ship it?",
        body: "repo/x · Claude Code",
        categoryId: "decision-approve-reject",
        data: {
          eventId: "spoofed",
          kind: "agent.done",
          decisionId: "spoofed",
          digestId: "spoofed",
          extra: 1,
        },
      }),
    );
    await t.run((ctx) =>
      deliverPush(ctx, agentEventId, {
        title: "Claude Code looks stuck",
        data: { decisionId: "spoofed" },
      }),
    );

    const [agentPush, decisionPush] = await queued(t, "install-1");
    expect(decisionPush).toMatchObject({
      title: "Ship it?",
      body: "repo/x · Claude Code",
      categoryId: "decision-approve-reject",
      sound: "default",
      state: "awaiting_delivery",
    });
    expect(decisionPush?.data).toEqual({
      eventId: decisionEventId,
      kind: "decision.created",
      decisionId,
      agentSessionId,
      extra: 1,
    });
    expect(agentPush?.title).toBe("Claude Code looks stuck");
    expect(agentPush?.body).toBeUndefined();
    expect(agentPush?.categoryId).toBeUndefined();
    expect(agentPush?.sound).toBe("default");
    expect(agentPush?.data).toEqual({ eventId: agentEventId, kind: "agent.stale", agentSessionId });
  });

  test("passes an interruption level through and sets none when the caller gives none", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    const { decisionEventId, agentEventId } = await insertEvents(t, userA);

    await t.run((ctx) =>
      deliverPush(ctx, decisionEventId, {
        title: "Release bot",
        body: "Ship it?",
        interruptionLevel: "time-sensitive",
      }),
    );
    await deliver(t, agentEventId, "Release bot");

    const [agentPush, decisionPush] = await queued(t, "install-1");
    expect(decisionPush).toMatchObject({
      title: "Release bot",
      interruptionLevel: "time-sensitive",
      sound: "default",
    });
    expect(agentPush?.sound).toBe("default");
    expect(agentPush).not.toHaveProperty("interruptionLevel");
  });

  test("sends to the install's replacement token", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[old]");
    const { decisionEventId, agentEventId } = await insertEvents(t, userA);
    await deliver(t, decisionEventId);
    expect(await queued(t, "install-1")).toHaveLength(1);

    await register(asA, "install-1", "ExponentPushToken[new]");
    // The component lists the queue for the current token only.
    expect(await queued(t, "install-1")).toHaveLength(0);
    await deliver(t, agentEventId);
    const pushes = await queued(t, "install-1");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.data).toMatchObject({ eventId: agentEventId });
  });

  test("sends nothing to an unregistered install", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await register(asA, "install-2", "ExponentPushToken[2]");
    const { decisionEventId } = await insertEvents(t, userA);
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-2" });

    await deliver(t, decisionEventId);

    expect(await queued(t, "install-1")).toHaveLength(1);
    expect(await deliveriesOf(t, decisionEventId)).toEqual([
      expect.objectContaining({ deviceId: "install-1" }),
    ]);
    // Registering again later does not replay the event to the install.
    await register(asA, "install-2", "ExponentPushToken[2]");
    expect(await queued(t, "install-2")).toHaveLength(0);
  });

  test("an install moved to another account receives only that account's events", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    const eventsA = await insertEvents(t, userA);
    const eventsB = await insertEvents(t, userB);
    await register(asB, "install-1", "ExponentPushToken[b]");

    await deliver(t, eventsA.decisionEventId);
    expect(await deliveriesOf(t, eventsA.decisionEventId)).toHaveLength(0);
    expect(await queued(t, "install-1")).toHaveLength(0);

    await deliver(t, eventsB.decisionEventId);
    const pushes = await queued(t, "install-1");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.data).toMatchObject({ eventId: eventsB.decisionEventId });
  });

  test("a failed send commits no delivery row and no queued send", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    // A device row without a component token makes the component's send
    // throw. Its id sorts after install-1, so install-1's send is queued
    // first within the failing call.
    await t.run((ctx) =>
      ctx.db.insert("devices", {
        userId: userA,
        deviceId: "install-2",
        name: "No token",
        platform: "android",
      }),
    );
    const { decisionEventId } = await insertEvents(t, userA);

    await expect(deliver(t, decisionEventId)).rejects.toMatchObject({
      data: { code: "NoPushToken" },
    });
    expect(await deliveriesOf(t, decisionEventId)).toHaveLength(0);
    expect(await queued(t, "install-1")).toHaveLength(0);

    await register(asA, "install-2", "ExponentPushToken[2]");
    await deliver(t, decisionEventId);
    expect(await deliveriesOf(t, decisionEventId)).toHaveLength(2);
    expect(await queued(t, "install-1")).toHaveLength(1);
    expect(await queued(t, "install-2")).toHaveLength(1);
  });
});

describe("deliverDigestPush", () => {
  test("queues the digest to each device with the default sound and digest routing", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await register(asA, "install-2", "ExponentPushToken[2]");
    const { decisionId, decisionEventId } = await insertEvents(t, userA);

    const digestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("digests", {
        userId: userA,
        eventIds: [decisionEventId],
        pendingDecisionIds: [decisionId],
        sentAt: START,
      });
      const digest = await ctx.db.get("digests", id);
      if (digest === null) {
        throw new Error("Inserted digest is missing");
      }
      await deliverDigestPush(ctx, digest, {
        title: "AgentDesk digest",
        body: "1 event · 1 pending decision",
        data: { eventId: "spoofed", kind: "agent.done", extra: 1 },
      });
      return id;
    });

    for (const deviceId of ["install-1", "install-2"]) {
      const pushes = await queued(t, deviceId);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        title: "AgentDesk digest",
        body: "1 event · 1 pending decision",
        sound: "default",
        state: "awaiting_delivery",
      });
      expect(pushes[0]?.categoryId).toBeUndefined();
      expect(pushes[0]).not.toHaveProperty("interruptionLevel");
      expect(pushes[0]?.data).toEqual({ kind: "digest", digestId, extra: 1 });
    }
  });
});
