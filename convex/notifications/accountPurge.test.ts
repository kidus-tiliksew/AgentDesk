import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  COMPONENT_PAGE,
  cancelDevicePushes,
  DRAIN_MAX_ATTEMPTS,
  purgeNotifications,
} from "./accountPurge";
import { deliverPush, pushNotifications } from "./push";
import { notifications } from "./refs";
import { queued, register, type Setup, setup, tokenStatus } from "./test.setup";

// component-notifications §Account deletion: cancelling an install's sends
// in the push component, draining an install with a send in flight, and
// this domain's purge. The real push component is mounted; fake timers keep
// its sender from running, so nothing contacts Expo.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Queues one push to every current install of the account.
async function queuePush(t: Setup["t"], userId: Id<"users">, title: string) {
  const eventId = await t.run((ctx) =>
    ctx.db.insert("events", {
      userId,
      kind: "agent.stale",
      occurredAt: Date.now(),
      action: "push",
    }),
  );
  await t.run((ctx) => deliverPush(ctx, eventId, { title }));
  return eventId;
}

function notification(t: Setup["t"], id: string) {
  return t.run((ctx) => pushNotifications.getNotification(ctx, { id }));
}

// Removes the install's row, as deleteAccount does, and cancels its sends.
function removeAndCancel(t: Setup["t"], deviceId: string) {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (row !== null) {
      await ctx.db.delete("devices", row._id);
    }
    await cancelDevicePushes(ctx, deviceId);
  });
}

function drains(t: Setup["t"]) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) =>
        job.name.startsWith("notifications/accountPurge:drainDevicePushes") &&
        job.state.kind === "pending",
    ),
  );
}

// The component's rows for the install, with one shown as in the sender's
// hands.
function inFlight(rows: Awaited<ReturnType<typeof queued>>) {
  return rows.map((row, index) => (index === 0 ? { ...row, state: "in_progress" as const } : row));
}

describe("cancelDevicePushes", () => {
  test("deletes every queued send and the token in one transaction", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queuePush(t, userA, "First");
    await queuePush(t, userA, "Second");
    await queuePush(t, userB, "Other");
    const ids = (await queued(t, "install-a")).map((row) => row.id);
    const other = (await queued(t, "install-b")).map((row) => row.id);
    expect(ids).toHaveLength(2);

    await removeAndCancel(t, "install-a");

    for (const id of ids) {
      expect(await notification(t, id)).toBeNull();
    }
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
    expect(await drains(t)).toHaveLength(0);
    for (const id of other) {
      expect(await notification(t, id)).toMatchObject({ state: "awaiting_delivery" });
    }
    expect(await tokenStatus(t, "install-b")).toMatchObject({ hasToken: true });
  });

  test("keeps a send in flight and the token, then drains them once the send settles", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    await queuePush(t, userA, "Second");
    const rows = await queued(t, "install-a");
    const read = vi.spyOn(pushNotifications, "getNotificationsForUser");
    read.mockResolvedValueOnce(inFlight(rows));

    await removeAndCancel(t, "install-a");

    // Nothing is deleted while a row is in the sender's hands.
    for (const row of rows) {
      expect(await notification(t, row.id)).not.toBeNull();
    }
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: true });
    const [first] = await drains(t);
    expect(first?.args[0]).toEqual({ deviceId: "install-a", attempt: 1 });

    // Still in flight on the first look: the drain looks again.
    read.mockResolvedValueOnce(inFlight(rows));
    await t.mutation(notifications.accountPurge.drainDevicePushes, {
      deviceId: "install-a",
      attempt: 1,
    });
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: true });

    // Settled: the drain deletes everything and removes the token.
    await t.mutation(notifications.accountPurge.drainDevicePushes, {
      deviceId: "install-a",
      attempt: 2,
    });
    for (const row of rows) {
      expect(await notification(t, row.id)).toBeNull();
    }
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
  });

  test("a long history is drained page by page", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const rows = await queued(t, "install-a");
    const page = Array.from({ length: COMPONENT_PAGE }, () => rows[0]).filter(
      (row) => row !== undefined,
    );
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(page);

    await removeAndCancel(t, "install-a");

    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: true });
    expect(await drains(t)).toHaveLength(1);
    await t.mutation(notifications.accountPurge.drainDevicePushes, {
      deviceId: "install-a",
      attempt: 1,
    });
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
  });

  test("a drain stops when another account has registered the install", async () => {
    const { t, userA, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const rows = await queued(t, "install-1");
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(inFlight(rows));
    await removeAndCancel(t, "install-1");
    vi.restoreAllMocks();
    await register(asB, "install-1", "ExponentPushToken[b]");

    await t.mutation(notifications.accountPurge.drainDevicePushes, {
      deviceId: "install-1",
      attempt: 1,
    });

    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: true });
    expect(await drains(t)).toHaveLength(1);
  });

  test("a send in flight past the last look is treated as settled", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const rows = await queued(t, "install-a");
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(inFlight(rows));
    await removeAndCancel(t, "install-a");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await t.mutation(notifications.accountPurge.drainDevicePushes, {
      deviceId: "install-a",
      attempt: DRAIN_MAX_ATTEMPTS,
    });

    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
    for (const row of rows) {
      expect(await notification(t, row.id)).toBeNull();
    }
  });
});

describe("purgeNotifications", () => {
  test("deletes deliveries before their events within the budget and leaves other accounts", async () => {
    const { t, userA, userB, asB } = await setup();
    await register(asB, "install-b", "ExponentPushToken[b]");
    const eventB = await queuePush(t, userB, "Other");
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        const eventId = await ctx.db.insert("events", {
          userId: userA,
          kind: "agent.done",
          occurredAt: 0,
          action: "push",
        });
        await ctx.db.insert("pushDeliveries", { eventId, deviceId: "gone-1" });
        await ctx.db.insert("pushDeliveries", { eventId, deviceId: "gone-2" });
      }
      await ctx.db.insert("rules", { userId: userA, topic: "repo", action: "mute", updatedAt: 0 });
      await ctx.db.insert("digests", {
        userId: userA,
        eventIds: [],
        pendingDecisionIds: [],
        sentAt: 0,
      });
    });

    // 9 event rows and 2 more; a budget of 4 cuts an event's deliveries off.
    const steps = [];
    for (let i = 0; i < 5; i++) {
      const step = await t.run((ctx) => purgeNotifications(ctx, userA, 4));
      steps.push(step);
      const orphans = await t.run(async (ctx) => {
        let count = 0;
        for (const row of await ctx.db.query("pushDeliveries").collect()) {
          if ((await ctx.db.get("events", row.eventId)) === null) {
            count++;
          }
        }
        return count;
      });
      expect(orphans).toBe(0);
      if (step.done) {
        break;
      }
    }

    expect(steps.every((step) => step.deleted <= 4)).toBe(true);
    expect(steps[steps.length - 1]?.done).toBe(true);
    const left = await t.run(async (ctx) => ({
      events: await ctx.db.query("events").collect(),
      rules: await ctx.db.query("rules").collect(),
      digests: await ctx.db.query("digests").collect(),
      deliveries: await ctx.db.query("pushDeliveries").collect(),
    }));
    expect(left.events.map((event) => event._id)).toEqual([eventB]);
    expect(left.rules).toHaveLength(0);
    expect(left.digests).toHaveLength(0);
    expect(left.deliveries.map((row) => row.eventId)).toEqual([eventB]);
  });
});
