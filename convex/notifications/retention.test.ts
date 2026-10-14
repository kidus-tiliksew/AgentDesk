import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { identity } from "../identity/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { CANCELLATION_STOPPED, COMPONENT_PAGE, HISTORY_READ_LIMIT } from "./accountPurge";
import { deliverPush, pushNotifications } from "./push";
import { notifications } from "./refs";
import {
  CHAIN_PAGES,
  pruneTokenPage,
  RETAIN_KEY_PREFIX,
  RETENTION_MS,
  SCAN_PAGE,
} from "./retention";
import {
  notification,
  pendingDrains,
  queued,
  queueHistory,
  register,
  type Setup,
  setup,
  tokenHistory,
  tokenRecords,
  tokenStatus,
} from "./test.setup";

// component-notifications §Push history retention, against the real push
// component: its sender runs on the scheduler under fake timers and sends to
// a fake Expo endpoint, so each notification reaches the state it would in
// production. Retention's own steps are scheduled with no delay and the
// component's coordinator 250 ms after a send, so `runRetention` runs
// retention without sending anything that is still queued.

const START = Date.UTC(2026, 9, 13, 12, 0, 0);
// A clock reading at which everything queued at START is old.
const LATER = START + RETENTION_MS + 60 * 60_000;

// Driving the real sender through more than 1,000 notifications takes about
// 2 s locally and about 1.6 times as long in CI (accountPurgeIsolation.test.ts).
const HEAVY_TEST_TIMEOUT_MS = 60_000;

// Every message Expo received.
let sent: { to: string; title?: string }[] = [];

// Expo's answer: a message whose title holds "[retry]" fails and is retried,
// a request holding one whose title holds "[500]" fails as a whole, so its
// notifications become `maybe_delivered`, and everything else is accepted.
function expo(init?: RequestInit) {
  const messages = JSON.parse(String(init?.body ?? "[]")) as { to: string; title?: string }[];
  if (messages.some((message) => message.title?.includes("[500]"))) {
    return new Response("unavailable", { status: 500 });
  }
  sent.push(...messages);
  return new Response(
    JSON.stringify({
      data: messages.map((message) =>
        message.title?.includes("[retry]")
          ? { status: "error", message: "DeviceNotRegistered", details: {} }
          : { status: "ok", id: "x" },
      ),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      String(url).startsWith("https://exp.host") ? expo(init) : new Response(null, { status: 200 }),
    ),
  );
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// Lets the scheduler run every job due within `ms`, then waits for the jobs
// it started.
async function runScheduled(t: Setup["t"], ms: number) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
}

// Runs the scheduler until `done` holds, for at most `rounds` rounds of
// `ms`.
async function runUntil(t: Setup["t"], done: () => Promise<boolean>, rounds = 200, ms = 300) {
  for (let i = 0; i < rounds && !(await done()); i++) {
    await runScheduled(t, ms);
  }
  expect(await done()).toBe(true);
}

function pendingRetention(t: Setup["t"]) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.name.startsWith("notifications/retention") && job.state.kind === "pending",
    ),
  );
}

// Runs every retention step that is due now and every step they schedule,
// without moving the clock, so the component's coordinator does not run.
async function runRetentionSteps(t: Setup["t"]) {
  for (let i = 0; i < 100 && (await pendingRetention(t)).length > 0; i++) {
    await runScheduled(t, 0);
  }
  expect(await pendingRetention(t)).toHaveLength(0);
}

// One hourly run: the cron's sweep, then every step it schedules.
async function runRetention(t: Setup["t"]) {
  await t.mutation(notifications.retention.sweep, {});
  await runRetentionSteps(t);
}

// Queues one event push to every current install of the account.
async function queuePush(t: Setup["t"], userId: Id<"users">, title: string) {
  await t.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      userId,
      kind: "agent.stale",
      occurredAt: Date.now(),
      action: "push",
    });
    await deliverPush(ctx, eventId, { title });
  });
}

// The install's current history, by state.
async function states(t: Setup["t"], deviceId: string) {
  return (await queued(t, deviceId)).map((row) => row.state);
}

// Runs the sender until every notification of the install has `state`.
async function settleAs(t: Setup["t"], deviceId: string, state: string, rounds = 200) {
  await runUntil(
    t,
    async () => (await queued(t, deviceId)).every((row) => row.state === state),
    rounds,
  );
}

async function deviceRow(t: Setup["t"], deviceId: string) {
  const row = await t.run((ctx) =>
    ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique(),
  );
  if (row === null) {
    throw new Error(`No device ${deviceId}`);
  }
  return row;
}

// The account's registration record for the install's token.
async function registration(t: Setup["t"], userId: Id<"users">, token: string) {
  const record = (await tokenRecords(t, userId)).find(
    (row) => row.token === token && row.drainScheduledAt === undefined,
  );
  if (record === undefined) {
    throw new Error(`No registration record for ${token}`);
  }
  return record;
}

// One pruning step for the account's registration record of `token` on
// `deviceId`, with an explicit cutoff.
async function pruneOnce(
  t: Setup["t"],
  userId: Id<"users">,
  deviceId: string,
  token: string,
  cutoff: number,
  pages = 0,
) {
  const record = await registration(t, userId, token);
  const device = await deviceRow(t, deviceId);
  await t.mutation(notifications.retention.pruneToken, {
    generationId: record._id,
    deviceRowId: device._id,
    cutoff,
    pages,
  });
}

function sendsOf(t: Setup["t"], userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db
      .query("pushSends")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

describe("the retention window", () => {
  test("deletes an old settled history and keeps one created since the cutoff", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-old", "ExponentPushToken[old]");
    await queueHistory(t, userA, "install-old", 3);
    await settleAs(t, "install-old", "delivered");
    vi.setSystemTime(LATER - 2 * 60 * 60_000);
    await register(asA, "install-new", "ExponentPushToken[new]");
    await queueHistory(t, userA, "install-new", 2);
    await settleAs(t, "install-new", "delivered");
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await queued(t, "install-old")).toHaveLength(0);
    expect(await states(t, "install-new")).toEqual(["delivered", "delivered"]);
    // Retention deletes no token record and no send record.
    expect(await tokenRecords(t, userA)).toHaveLength(2);
    expect(await sendsOf(t, userA)).toHaveLength(5);
    // The private key is gone, so the component's continuation finds no
    // token.
    const record = await registration(t, userA, "ExponentPushToken[old]");
    expect(await tokenStatus(t, `${RETAIN_KEY_PREFIX}${record._id}`)).toMatchObject({
      hasToken: false,
    });
  });

  test("a notification created exactly at the cutoff stays; one created before it goes", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 1);
    await settleAs(t, "install-a", "delivered");
    const [row] = await queued(t, "install-a");
    if (row === undefined) {
      throw new Error("No notification");
    }

    await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", row._creationTime);
    expect(await notification(t, row.id)).not.toBeNull();

    await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", row._creationTime + 1);
    expect(await notification(t, row.id)).toBeNull();
  });

  test("the sweep's cutoff is its start time minus 24 hours", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 1);
    await settleAs(t, "install-a", "delivered");
    const [row] = await queued(t, "install-a");
    if (row === undefined) {
      throw new Error("No notification");
    }

    vi.setSystemTime(Math.ceil(row._creationTime) + RETENTION_MS - 1);
    await runRetention(t);
    expect(await notification(t, row.id)).not.toBeNull();

    vi.setSystemTime(Math.ceil(row._creationTime) + RETENTION_MS + 1);
    await runRetention(t);
    expect(await notification(t, row.id)).toBeNull();
  });

  test(
    "deletes the oldest full page of old settled notifications and keeps the recent ones after it",
    async () => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueHistory(t, userA, "install-a", COMPONENT_PAGE);
      await settleAs(t, "install-a", "delivered");
      vi.setSystemTime(LATER - 60_000);
      await queueHistory(t, userA, "install-a", 5);
      await settleAs(t, "install-a", "delivered");
      vi.setSystemTime(LATER);

      await runRetention(t);

      const left = await queued(t, "install-a");
      expect(left).toHaveLength(5);
      expect(left.every((row) => row._creationTime >= LATER - 60_000)).toBe(true);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );
});

describe("states", () => {
  test("delivered, maybe-delivered, and undeliverable notifications are deleted", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-ok", "ExponentPushToken[ok]");
    await queueHistory(t, userA, "install-ok", 1);
    await settleAs(t, "install-ok", "delivered");
    await register(asA, "install-500", "ExponentPushToken[500]");
    await t.run(async (ctx) => {
      const id = await pushNotifications.sendPushNotification(ctx, {
        userId: "install-500",
        notification: { title: "Lost [500]" },
      });
      await ctx.db.insert("pushSends", { userId: userA, notificationId: id as string });
    });
    await settleAs(t, "install-500", "maybe_delivered");
    await register(asA, "install-gone", "ExponentPushToken[gone]");
    await t.run(async (ctx) => {
      const id = await pushNotifications.sendPushNotification(ctx, {
        userId: "install-gone",
        notification: { title: "Gone [retry]" },
      });
      await ctx.db.insert("pushSends", { userId: userA, notificationId: id as string });
    });
    await settleAs(t, "install-gone", "unable_to_deliver", 400);
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await queued(t, "install-ok")).toHaveLength(0);
    expect(await queued(t, "install-500")).toHaveLength(0);
    expect(await queued(t, "install-gone")).toHaveLength(0);
  });

  // Push component 0.3.1 never stores `failed`; its sender turns a failure
  // into `needs_retry`. The schema still allows the state, so the read
  // reports a real row as `failed` here.
  test("a failed notification is deleted", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 1);
    await settleAs(t, "install-a", "delivered");
    const rows = await queued(t, "install-a");
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(
      rows.map((row) => ({ ...row, state: "failed" as const })),
    );

    await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", LATER);

    expect(await queued(t, "install-a")).toHaveLength(0);
  });

  test("queued, retrying, and unknown-state notifications are kept", async () => {
    const { t, userA, asA } = await setup();
    const info = vi.mocked(console.info);
    const warn = vi.mocked(console.warn);
    await register(asA, "install-q", "ExponentPushToken[q]");
    await queueHistory(t, userA, "install-q", 2);
    await register(asA, "install-r", "ExponentPushToken[r]");
    await t.run(async (ctx) => {
      const id = await pushNotifications.sendPushNotification(ctx, {
        userId: "install-r",
        notification: { title: "Again [retry]" },
      });
      await ctx.db.insert("pushSends", { userId: userA, notificationId: id as string });
    });
    // One sender round: the queued pair is delivered by then too, so queue
    // it again afterwards.
    await runUntil(t, async () => (await states(t, "install-r")).includes("needs_retry"));
    for (const row of await queued(t, "install-q")) {
      expect(row.state).toBe("delivered");
    }
    await register(asA, "install-q2", "ExponentPushToken[q2]");
    await queueHistory(t, userA, "install-q2", 2);
    await register(asA, "install-u", "ExponentPushToken[u]");
    await queueHistory(t, userA, "install-u", 1);
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await states(t, "install-q2")).toEqual(["awaiting_delivery", "awaiting_delivery"]);
    expect(await states(t, "install-r")).toEqual(["needs_retry"]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("unsettled"));

    // A state retention does not know is kept and logged as a warning.
    const rows = await queued(t, "install-u");
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(
      rows.map((row) => ({ ...row, state: "archived" as unknown as "delivered" })),
    );
    await pruneOnce(t, userA, "install-u", "ExponentPushToken[u]", LATER - RETENTION_MS);
    expect(await queued(t, "install-u")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknownState"));
  });

  test("a page mixing old settled notifications with a retrying one stays whole", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 3);
    await t.run(async (ctx) => {
      const id = await pushNotifications.sendPushNotification(ctx, {
        userId: "install-a",
        notification: { title: "Again [retry]" },
      });
      await ctx.db.insert("pushSends", { userId: userA, notificationId: id as string });
    });
    await runUntil(t, async () => (await states(t, "install-a")).includes("needs_retry"));
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await states(t, "install-a")).toEqual([
      "needs_retry",
      "delivered",
      "delivered",
      "delivered",
    ]);
  });

  test("a send in flight is kept, settles normally, and goes in the next run", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asB, "install-b", "ExponentPushToken[b]");
    await register(asA, "install-a", "ExponentPushToken[a]");
    // B's push shares the held batch.
    await queuePush(t, userB, "For B");
    await queuePush(t, userA, "For A");
    let release: () => void = () => undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => expo(init));
    fetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(expo(init));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runScheduled(t, 300);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await states(t, "install-a")).toEqual(["in_progress"]);
    vi.setSystemTime(LATER);

    // The step runs directly: the scheduler would wait for the held send.
    await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", LATER - RETENTION_MS);

    expect(await states(t, "install-a")).toEqual(["in_progress"]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("inFlight"));

    // The sender records the batch's outcome with every row still there.
    release();
    await t.finishInProgressScheduledFunctions();
    expect(await states(t, "install-a")).toEqual(["delivered"]);
    expect(await states(t, "install-b")).toEqual(["delivered"]);
    expect(sent.map((message) => message.title).sort()).toEqual(["For A", "For B"]);

    await runRetention(t);
    expect(await queued(t, "install-a")).toHaveLength(0);
    expect(await queued(t, "install-b")).toHaveLength(0);
  });
});

describe("ownership", () => {
  test("another account's notifications on a shared token keep both accounts' pages whole", async () => {
    // Two installs report one Expo token, so its history holds both
    // accounts' notifications.
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[shared]");
    await register(asB, "install-2", "ExponentPushToken[shared]");
    await queuePush(t, userA, "For A");
    await queuePush(t, userB, "For B");
    await settleAs(t, "install-1", "delivered");
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For B",
      "For A",
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("foreign"));
  });

  test("a notification without a send record keeps its page whole", async () => {
    const { t, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await t.run((ctx) =>
      pushNotifications.sendPushNotification(ctx, {
        userId: "install-a",
        notification: { title: "Unrecorded" },
      }),
    );
    await settleAs(t, "install-a", "delivered");
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await queued(t, "install-a")).toHaveLength(1);
  });

  test("each account's installs follow their own history", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 2);
    await settleAs(t, "install-a", "delivered");
    vi.setSystemTime(LATER - 60_000);
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queueHistory(t, userB, "install-b", 2);
    await settleAs(t, "install-b", "delivered");
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await queued(t, "install-a")).toHaveLength(0);
    expect(await states(t, "install-b")).toEqual(["delivered", "delivered"]);
    expect(await sendsOf(t, userB)).toHaveLength(2);
  });

  test("a token an earlier registration of the install held is pruned too", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[first]");
    await queueHistory(t, userA, "install-a", 2);
    await settleAs(t, "install-a", "delivered");
    await register(asA, "install-a", "ExponentPushToken[second]");
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await tokenHistory(t, "ExponentPushToken[first]")).toHaveLength(0);
    expect(await tokenRecords(t, userA)).toHaveLength(2);
  });
});

describe("paths that cross retention", () => {
  test(
    "a pending sign-out drain on a re-registered install: no double deletion, nothing protected lost",
    async () => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueHistory(t, userA, "install-a", COMPONENT_PAGE + 100);
      await settleAs(t, "install-a", "delivered");
      vi.setSystemTime(LATER);
      // The history is too long for the sign-out transaction, so its drain is
      // pending when A signs in again on the same install and token.
      await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });
      expect(await pendingDrains(t)).toHaveLength(1);
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queuePush(t, userA, "New");
      const drainRecord = (await tokenRecords(t, userA)).find(
        (row) => row.drainScheduledAt !== undefined,
      );
      expect(drainRecord).toBeDefined();

      // Retention runs while the drain is still pending. Its install scan
      // schedules a step for the registration record only.
      const device = await deviceRow(t, "install-a");
      await t.mutation(notifications.retention.scanInstall, {
        deviceRowId: device._id,
        cutoff: LATER - RETENTION_MS,
      });
      const prunes = (await pendingRetention(t)).filter(
        (job) => job.name === "notifications/retention:pruneToken",
      );
      expect(prunes).toHaveLength(1);
      expect(prunes[0]?.args[0].generationId).not.toBe(drainRecord?._id);
      // Its steps delete the oldest page, all old, settled, and A's; the 100
      // old notifications left sit beside the new queued push, so the next
      // page stays whole.
      await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", LATER - RETENTION_MS);
      await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", LATER - RETENTION_MS, 1);
      expect(await queued(t, "install-a")).toHaveLength(101);
      expect(await pendingDrains(t)).toHaveLength(1);

      // The drain then ends as superseded and deletes nothing more.
      await runUntil(t, async () => (await pendingDrains(t)).length === 0, 20, 100);
      const records = await tokenRecords(t, userA);
      expect(records).toHaveLength(1);
      expect(records[0]?.drainScheduledAt).toBeUndefined();
      const rows = await queued(t, "install-a");
      expect(rows.find((row) => row.title === "New")).toBeDefined();
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("a stopped record is left to its cancellation", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-1", "ExponentPushToken[shared]");
    await register(asB, "install-2", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");
    await queuePush(t, userA, "For A");
    await settleAs(t, "install-1", "delivered");
    // A signs out of install 1. B's notification is on the token's oldest
    // page, so A's cancellation stops and keeps its record, marked stopped.
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-1" });
    await register(asA, "install-3", "ExponentPushToken[other]");
    await t.run(async (ctx) => {
      const [record] = await ctx.db
        .query("deviceTokens")
        .withIndex("by_user_device_token", (q) => q.eq("userId", userA).eq("deviceId", "install-1"))
        .collect();
      expect(record?.drainScheduledAt).toBe(CANCELLATION_STOPPED);
    });
    vi.setSystemTime(LATER);

    await runRetention(t);

    // Retention reaches only installs in `devices`, and only registration
    // records: nothing under the shared token is touched.
    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For A",
      "For B",
    ]);
    expect((await tokenRecords(t, userA)).map((row) => row.drainScheduledAt).sort()).toEqual([
      CANCELLATION_STOPPED,
      undefined,
    ]);
  });

  test("after a handoff on a shared Expo token the new owner's history is pruned", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-x", "ExponentPushToken[shared]");
    await queueHistory(t, userA, "install-x", 3);
    await settleAs(t, "install-x", "delivered");
    // The handoff deletes A's settled history in its own transaction.
    await register(asB, "install-x", "ExponentPushToken[shared]");
    expect(await tokenHistory(t, "ExponentPushToken[shared]")).toHaveLength(0);
    await queueHistory(t, userB, "install-x", 2);
    await settleAs(t, "install-x", "delivered");
    vi.setSystemTime(LATER);

    await runRetention(t);

    expect(await tokenHistory(t, "ExponentPushToken[shared]")).toHaveLength(0);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await tokenRecords(t, userB)).toHaveLength(1);
  });

  test("after a handoff whose cleanup stopped, the former owner's notification keeps the new owner's page whole", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-x", "ExponentPushToken[shared]");
    await queuePush(t, userA, "For A");
    let release: () => void = () => undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => expo(init));
    fetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(expo(init));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runScheduled(t, 300);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A's send is in flight when B takes the install with the same token,
    // and B's push lands before A's drain runs (the accepted window).
    await register(asB, "install-x", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");
    release();
    await t.finishInProgressScheduledFunctions();
    await runUntil(t, async () =>
      (await tokenRecords(t, userA)).every((row) => row.drainScheduledAt === CANCELLATION_STOPPED),
    );
    await settleAs(t, "install-x", "delivered");
    vi.setSystemTime(LATER);

    await runRetention(t);

    // B's page holds A's notification, so nothing is deleted.
    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For B",
      "For A",
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("foreign"));
    expect(await tokenRecords(t, userB)).toHaveLength(1);
    expect(await sendsOf(t, userB)).toHaveLength(1);
  });

  test("a step scheduled before the install moved to another account deletes nothing", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-x", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-x", 2);
    await settleAs(t, "install-x", "delivered");
    vi.setSystemTime(LATER);
    await t.mutation(notifications.retention.sweep, {});
    await runScheduled(t, 0);
    expect((await pendingRetention(t)).map((job) => job.name)).toEqual([
      "notifications/retention:pruneToken",
    ]);
    const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");

    // B takes the install with a new token before the step runs; the
    // handoff cancels A's history itself.
    await register(asB, "install-x", "ExponentPushToken[b]");
    deleteSpy.mockClear();
    await queueHistory(t, userB, "install-x", 1);
    await runRetentionSteps(t);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await states(t, "install-x")).toEqual(["awaiting_delivery"]);
  });

  test("a step scheduled before the install took a new token prunes only its own token", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[first]");
    await queueHistory(t, userA, "install-a", 2);
    await settleAs(t, "install-a", "delivered");
    vi.setSystemTime(LATER);
    await t.mutation(notifications.retention.sweep, {});
    await runScheduled(t, 0);
    expect((await pendingRetention(t)).map((job) => job.name)).toEqual([
      "notifications/retention:pruneToken",
    ]);

    // The install refreshes its token and queues a push under the new one
    // before the step runs.
    await register(asA, "install-a", "ExponentPushToken[second]");
    await queueHistory(t, userA, "install-a", 1);
    await runRetentionSteps(t);

    expect(await tokenHistory(t, "ExponentPushToken[first]")).toHaveLength(0);
    expect(await states(t, "install-a")).toEqual(["awaiting_delivery"]);
  });

  test(
    "a step that runs after account deletion started deletes nothing",
    async () => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueHistory(t, userA, "install-a", COMPONENT_PAGE + 1);
      await settleAs(t, "install-a", "delivered");
      vi.setSystemTime(LATER);
      await t.mutation(notifications.retention.sweep, {});
      await runScheduled(t, 0);
      const [step] = await pendingRetention(t);
      expect(step?.name).toBe("notifications/retention:pruneToken");

      // Account deletion starts and its purge is still draining when the
      // retention step runs.
      await asA.mutation(identity.accountDeletion.deleteAccount, {});
      const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");
      await t.mutation(notifications.retention.pruneToken, step?.args[0] as never);
      expect(deleteSpy).not.toHaveBeenCalled();

      // A record whose account is being deleted is skipped even while its
      // install row still exists.
      await t.run(async (ctx) => {
        await ctx.db.insert("devices", {
          userId: userA,
          deviceId: "install-a",
          name: "Phone",
          platform: "ios",
        });
      });
      await runRetention(t);
      expect(deleteSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: expect.stringContaining(RETAIN_KEY_PREFIX) }),
      );
    },
    HEAVY_TEST_TIMEOUT_MS,
  );
});

describe("bounded work", () => {
  test("the sweep reads SCAN_PAGE installs per step and every install is reached", async () => {
    const { t, userA, asA } = await setup();
    for (let i = 0; i < SCAN_PAGE + 3; i++) {
      await register(asA, `install-${i}`, `ExponentPushToken[${i}]`);
      await queueHistory(t, userA, `install-${i}`, 1);
    }
    await runUntil(t, async () => sent.length === SCAN_PAGE + 3);
    vi.setSystemTime(LATER);

    await t.mutation(notifications.retention.sweep, {});
    const first = await pendingRetention(t);
    expect(first.filter((job) => job.name === "notifications/retention:scanInstall")).toHaveLength(
      SCAN_PAGE,
    );
    expect(first.filter((job) => job.name === "notifications/retention:sweep")).toEqual([
      expect.objectContaining({
        args: [expect.objectContaining({ cutoff: LATER - RETENTION_MS })],
      }),
    ]);
    await runRetentionSteps(t);

    for (let i = 0; i < SCAN_PAGE + 3; i++) {
      expect(await queued(t, `install-${i}`)).toHaveLength(0);
    }
  });

  test("a step carries no token in its arguments", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[secret]");
    await queueHistory(t, userA, "install-a", 1);
    vi.setSystemTime(LATER);
    await t.mutation(notifications.retention.sweep, {});
    await runScheduled(t, 0);
    const jobs = await pendingRetention(t);
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs.map((job) => job.args))).not.toContain("secret");
  });

  test(
    "a long readable history is pruned one page per mutation within Convex's transaction limits",
    async () => {
      const { t, userA, asA } = await limitedSetup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueLong(t, userA, "install-a", 2100);
      await runUntil(t, async () => sent.length === 2100, 400);
      vi.setSystemTime(LATER);
      const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");

      await runRetention(t);

      // 1,000, 1,000, then 100, each in its own transaction.
      expect(deleteSpy).toHaveBeenCalledTimes(3);
      expect(await queued(t, "install-a")).toHaveLength(0);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test(
    "one step reads 4,000 notifications and deletes 1,000 within the limits",
    async () => {
      const { t, userA, asA } = await limitedSetup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueLong(t, userA, "install-a", HISTORY_READ_LIMIT);
      await runUntil(t, async () => sent.length === HISTORY_READ_LIMIT, 800);
      vi.setSystemTime(LATER);

      const record = await registration(t, userA, "ExponentPushToken[a]");
      const device = await deviceRow(t, "install-a");

      const { result, metrics } = await t.run(async (ctx) => {
        const result = await pruneTokenPage(ctx, record, device, LATER - RETENTION_MS);
        return { result, metrics: await ctx.meta.getTransactionMetrics() };
      });

      expect(result).toEqual({ outcome: "deleted", more: true });
      expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(
        HISTORY_READ_LIMIT - COMPONENT_PAGE,
      );
      // Measured locally: 7,278,370 bytes and 7,005 documents read (4,000
      // notifications of about 1.1 KB, the 1,000 the component re-reads to
      // delete them, and one `pushSends` record per notification on the page),
      // 1,002 documents written, and 1,007 index ranges.
      expect(metrics.bytesRead.used).toBeLessThan(8 * 1024 * 1024);
      expect(metrics.documentsWritten.used).toBeLessThanOrEqual(COMPONENT_PAGE + 4);
      expect(metrics.databaseQueries.used).toBeLessThanOrEqual(COMPONENT_PAGE + 20);
      expect(metrics.documentsRead.used).toBeLessThan(HISTORY_READ_LIMIT + 3 * COMPONENT_PAGE + 50);
      process.stdout.write(`retention step metrics: ${JSON.stringify(metrics)}\n`);
    },
    4 * HEAVY_TEST_TIMEOUT_MS,
  );

  test(
    `one record's chain stops after ${CHAIN_PAGES} pages per sweep`,
    async () => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueHistory(t, userA, "install-a", COMPONENT_PAGE + 2);
      await settleAs(t, "install-a", "delivered");
      vi.setSystemTime(LATER);

      await pruneOnce(
        t,
        userA,
        "install-a",
        "ExponentPushToken[a]",
        LATER - RETENTION_MS,
        CHAIN_PAGES - 1,
      );

      expect(await queued(t, "install-a")).toHaveLength(2);
      expect(await pendingRetention(t)).toHaveLength(0);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("a history longer than one read can see is left alone and logged", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 1);
    await settleAs(t, "install-a", "delivered");
    const rows = await queued(t, "install-a");
    const long = Array.from({ length: HISTORY_READ_LIMIT + 1 }, () => rows[0]).filter(
      (row) => row !== undefined,
    );
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockResolvedValueOnce(long);
    const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");

    await pruneOnce(t, userA, "install-a", "ExponentPushToken[a]", LATER);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await queued(t, "install-a")).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("more than 4000"));
  });
});

describe("failures and overlapping runs", () => {
  test("a failed step rolls back, holds up no other install, and the next run finishes it", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-1", "ExponentPushToken[1]");
    await queueHistory(t, userA, "install-1", 2);
    await register(asA, "install-2", "ExponentPushToken[2]");
    await queueHistory(t, userA, "install-2", 2);
    await runUntil(t, async () => sent.length === 4);
    vi.setSystemTime(LATER);
    const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");
    deleteSpy.mockRejectedValueOnce(new Error("transaction limit"));

    await runRetention(t);

    // One install's step failed and rolled back; the other's deleted its page.
    const left = [(await queued(t, "install-1")).length, (await queued(t, "install-2")).length];
    expect(left.sort()).toEqual([0, 2]);
    // The failed step's private key went with its rollback.
    for (const record of await tokenRecords(t, userA)) {
      expect(await tokenStatus(t, `${RETAIN_KEY_PREFIX}${record._id}`)).toMatchObject({
        hasToken: false,
      });
    }

    await runRetention(t);
    expect(await queued(t, "install-1")).toHaveLength(0);
    expect(await queued(t, "install-2")).toHaveLength(0);
  });

  test(
    "overlapping sweeps inspect what remains and delete each page once",
    async () => {
      const { t, userA, asA } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await queueHistory(t, userA, "install-a", COMPONENT_PAGE + 500);
      await settleAs(t, "install-a", "delivered");
      vi.setSystemTime(LATER + 60_000);
      await queueHistory(t, userA, "install-a", 1);
      const deleteSpy = vi.spyOn(pushNotifications, "deleteNotificationsForUser");

      await t.mutation(notifications.retention.sweep, {});
      await t.mutation(notifications.retention.sweep, {});
      await runRetentionSteps(t);

      // Two workers ran for one record. The first deleted the oldest page; the
      // second found the remaining 500 next to the queued push and kept them.
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      const rows = await queued(t, "install-a");
      expect(rows).toHaveLength(501);
      expect(rows[0]?.state).toBe("awaiting_delivery");
    },
    HEAVY_TEST_TIMEOUT_MS,
  );
});

// Queues `count` notifications with long titles and bodies, as decision
// pushes carry, at most 1,000 per transaction.
async function queueLong(t: Setup["t"], userId: Id<"users">, deviceId: string, count: number) {
  for (let start = 0; start < count; start += 1000) {
    await t.run(async (ctx) => {
      for (let i = start; i < Math.min(count, start + 1000); i++) {
        const notificationId = await pushNotifications.sendPushNotification(ctx, {
          userId: deviceId,
          notification: { title: `${"T".repeat(120)} ${i}`, body: "B".repeat(900) },
        });
        await ctx.db.insert("pushSends", { userId, notificationId: notificationId as string });
      }
    });
  }
}

// A backend that enforces Convex's default per-transaction limits, with the
// real push component mounted the way ./test.setup.ts mounts it.
async function limitedSetup() {
  const PUSH_TEST_ENTRY: string = "@convex-dev/expo-push-notifications/test";
  const t = convexTest({ schema, modules, transactionLimits: true });
  const pushTest: { register(t: TestConvex<typeof schema>): void } = (await import(PUSH_TEST_ENTRY))
    .default;
  pushTest.register(t);
  const userA = await t.run((ctx) =>
    ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
  );
  return { t, userA, asA: t.withIdentity({ subject: "user_a" }) };
}
