import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  COMPONENT_PAGE,
  DRAIN_FAST_LOOKS,
  DRAIN_SLOW_RETRY_MS,
  HISTORY_READ_LIMIT,
  purgeNotifications,
} from "./accountPurge";
import { removeAllDevices } from "./devices";
import { deliverDigestPush, deliverPush, pushNotifications } from "./push";
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

// Removes every device of the install's owner and cancels the owner's
// pushes, as deleteAccount does.
function removeAndCancel(t: Setup["t"], deviceId: string) {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (row === null) {
      throw new Error(`No device ${deviceId}`);
    }
    await removeAllDevices(ctx, row.userId);
  });
}

// The account's token records that still wait for their cancellation.
function tokenRecords(t: Setup["t"], userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

// Runs one drain look for the account's only token record.
async function drainOnce(t: Setup["t"], userId: Id<"users">, attempt: number) {
  const [record] = await tokenRecords(t, userId);
  if (record === undefined) {
    throw new Error("No token record");
  }
  await t.mutation(notifications.accountPurge.drainTokenPushes, {
    generationId: record._id,
    attempt,
  });
}

function drains(t: Setup["t"]) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) =>
        job.name.startsWith("notifications/accountPurge:drainTokenPushes") &&
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

  test("cancels a queued digest push in the deletion transaction", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    for (const userId of [userA, userB]) {
      await t.run(async (ctx) => {
        const digestId = await ctx.db.insert("digests", {
          userId,
          eventIds: [],
          pendingDecisionIds: [],
          sentAt: Date.now(),
        });
        const digest = await ctx.db.get("digests", digestId);
        if (digest === null) {
          throw new Error("No digest");
        }
        await deliverDigestPush(ctx, digest, { title: "Daily digest" });
      });
    }
    const [digestA] = await queued(t, "install-a");
    const [digestB] = await queued(t, "install-b");
    if (digestA === undefined || digestB === undefined) {
      throw new Error("No queued digest push");
    }

    await removeAndCancel(t, "install-a");

    expect(await notification(t, digestA.id)).toBeNull();
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
    expect(await notification(t, digestB.id)).toMatchObject({
      state: "awaiting_delivery",
      data: { kind: "digest" },
    });
  });

  test("keeps a send in flight, then drains every notification once the send settles", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    await queuePush(t, userA, "Second");
    const rows = await queued(t, "install-a");
    const read = vi.spyOn(pushNotifications, "getNotificationsForUser");
    read.mockResolvedValueOnce(inFlight(rows));

    await removeAndCancel(t, "install-a");

    // Nothing is deleted while a row is in the sender's hands. The install's
    // own token is gone, so nothing new is queued for it.
    for (const row of rows) {
      expect(await notification(t, row.id)).not.toBeNull();
    }
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
    const [record] = await tokenRecords(t, userA);
    const [first] = await drains(t);
    expect(first?.args[0]).toEqual({ generationId: record?._id, attempt: 1 });

    // Still in flight on the first look: the drain looks again.
    read.mockResolvedValueOnce(inFlight(rows));
    await drainOnce(t, userA, 1);
    expect(await tokenRecords(t, userA)).toHaveLength(1);

    // Settled: the drain deletes everything and drops the token record.
    await drainOnce(t, userA, 2);
    for (const row of rows) {
      expect(await notification(t, row.id)).toBeNull();
    }
    expect(await tokenRecords(t, userA)).toHaveLength(0);
  });

  test("a history longer than one look can check is left alone", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const rows = await queued(t, "install-a");
    const read = vi.spyOn(pushNotifications, "getNotificationsForUser");
    read.mockResolvedValueOnce(inFlight(rows));
    await removeAndCancel(t, "install-a");
    const long = Array.from({ length: HISTORY_READ_LIMIT + 1 }, () => rows[0]).filter(
      (row) => row !== undefined,
    );
    read.mockResolvedValueOnce(long);
    const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drainOnce(t, userA, 1);

    expect(deleteSpy).not.toHaveBeenCalled();
    for (const row of rows) {
      expect(await notification(t, row.id)).not.toBeNull();
    }
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await drains(t)).toHaveLength(1);
  });

  test("a cancellation in the deletion transaction never deletes a long history", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const rows = await queued(t, "install-a");
    const page = Array.from({ length: COMPONENT_PAGE }, () => rows[0]).filter(
      (row) => row !== undefined,
    );
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(page);
    const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");

    await removeAndCancel(t, "install-a");

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await tokenRecords(t, userA)).toHaveLength(1);
    expect(await drains(t)).toHaveLength(1);
  });

  test("a token another account also used is left alone with both accounts' notifications", async () => {
    // One phone, one Expo token: A signs out and B signs in on the install.
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userA, "For A");
    const [forA] = await queued(t, "install-1");
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });
    await register(asB, "install-1", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");
    const forB = (await queued(t, "install-1")).find((row) => row.title === "For B");
    if (forA === undefined || forB === undefined) {
      throw new Error("No queued push");
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await t.run((ctx) => removeAllDevices(ctx, userA));

    // The page holds B's notification, so nothing on the token is deleted.
    expect(await notification(t, forB.id)).toMatchObject({ state: "awaiting_delivery" });
    expect(await notification(t, forA.id)).not.toBeNull();
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await tokenStatus(t, "install-1")).toMatchObject({ hasToken: true });
    expect(await tokenRecords(t, userB)).toHaveLength(1);
  });

  test("a send still in flight after many looks is waited for, never deleted", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const rows = await queued(t, "install-a");
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValue(inFlight(rows));
    await removeAndCancel(t, "install-a");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drainOnce(t, userA, DRAIN_FAST_LOOKS);

    for (const row of rows) {
      expect(await notification(t, row.id)).not.toBeNull();
    }
    const [record] = await tokenRecords(t, userA);
    const next = await drains(t);
    expect(next.map((job) => job.args[0])).toContainEqual({
      generationId: record?._id,
      attempt: DRAIN_FAST_LOOKS + 1,
    });
    expect(next.some((job) => job.scheduledTime - Date.now() >= DRAIN_SLOW_RETRY_MS - 1)).toBe(
      true,
    );
  });
});

// The mixed-batch test drives the real component through more than 1,000
// notifications. CI run 38402284935 measured 3,231 ms for it, about 1.5 times
// its local duration, against Vitest's 5,000 ms default. Its setup now skips
// the event rows, and 30 s leaves several times the slowest CI measurement
// while a hang still fails within a minute.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

// Answers every message of an Expo send request as accepted.
function accepted(init?: RequestInit) {
  const messages = JSON.parse(String(init?.body ?? "[]")) as unknown[];
  return new Response(JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "x" })) }));
}

// Lets the scheduler run every job due within `ms`, then waits for the jobs
// it started.
async function runScheduled(t: Setup["t"], ms: number) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
}

// Every component row of the install's current token, newest first.
function history(t: Setup["t"], deviceId: string) {
  return t.run((ctx) =>
    pushNotifications.getNotificationsForUser(ctx, { userId: deviceId, limit: 5000 }),
  );
}

// Review round 1, finding 2: cancellation never deletes a row the
// component's sender owns, whichever page of a long history it is on.
describe("cancelDevicePushes with a long history and a send in flight", () => {
  test(
    "keeps every in-flight row, lets a mixed-account batch record its results, then drains",
    async () => {
      const { t, userA, userB, asA, asB } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await register(asB, "install-b", "ExponentPushToken[b]");
      // Another account's push is queued first, so the sender's first batch
      // holds both accounts' notifications.
      await queuePush(t, userB, "Other account");
      const [otherRow] = await queued(t, "install-b");
      if (otherRow === undefined) {
        throw new Error("No queued push for the other account");
      }
      // 1,100 distinct notifications for the deleted account's install, queued
      // the way `queueToDevice` queues them: the component's send and the
      // account's `pushSends` record.
      await t.run(async (ctx) => {
        for (let i = 0; i < 1100; i++) {
          const notificationId = await pushNotifications.sendPushNotification(ctx, {
            userId: "install-a",
            notification: { title: `Push ${i}` },
          });
          if (notificationId !== null) {
            await ctx.db.insert("pushSends", { userId: userA, notificationId });
          }
        }
      });

      // The first Expo request hangs, so its batch stays in the sender's hands.
      let release: (response: Response) => void = () => undefined;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => accepted(init));
      fetchMock.mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            release = () => resolve(accepted(init));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      // The coordinator hands the oldest 100 notifications to a sender.
      await runScheduled(t, 300);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const inFlightRows = (await history(t, "install-a")).filter(
        (row) => row.state === "in_progress",
      );
      expect(inFlightRows.length).toBeGreaterThan(0);
      expect(await notification(t, otherRow.id)).toMatchObject({ state: "in_progress" });

      await removeAndCancel(t, "install-a");

      // No row the sender holds is deleted.
      for (const row of inFlightRows) {
        expect(await notification(t, row.id)).toMatchObject({ state: "in_progress" });
      }
      // The batch records its results, including the other account's.
      release(new Response());
      await t.finishInProgressScheduledFunctions();
      expect(await notification(t, otherRow.id)).toMatchObject({ state: "delivered" });
      for (const row of inFlightRows) {
        expect(await notification(t, row.id)).toMatchObject({ state: "delivered" });
      }

      // Once nothing is left in flight, the drain deletes the whole history
      // and removes the token.
      for (let i = 0; i < 200 && (await tokenRecords(t, userA)).length > 0; i++) {
        await runScheduled(t, 1000);
      }
      expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
      for (const row of inFlightRows) {
        expect(await notification(t, row.id)).toBeNull();
      }
      expect(await notification(t, otherRow.id)).toMatchObject({ state: "delivered" });
      expect(await tokenStatus(t, "install-b")).toMatchObject({ hasToken: true });
      vi.unstubAllGlobals();
    },
    HEAVY_TEST_TIMEOUT_MS,
  );
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
