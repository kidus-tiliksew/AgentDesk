import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { identity } from "../identity/refs";
import { CANCELLATION_STOPPED } from "./accountPurge";
import { deliverPush, pushNotifications } from "./push";
import { notifications } from "./refs";
import {
  pendingDrains,
  queued,
  register,
  type Setup,
  setup,
  tokenHistory,
  tokenStatus,
} from "./test.setup";

// component-notifications §Account deletion, review round 2. Push component
// 0.3.1 copies an install's token into each notification and finds and
// deletes notifications only through the token that a key currently holds,
// and `deleteNotificationsForUser` schedules its own continuation that looks
// the key up again. These tests drive account deletion against the real
// component, with the scheduler run by fake timers and a fake Expo endpoint
// that accepts every message, and check that the cancellation follows the
// deleted account's own notifications and nothing else.

const START = Date.UTC(2026, 9, 13, 12, 0, 0);

// The heavy tests drive the real component through more than 1,000
// notifications. CI run 38402284935 measured 5,537 ms for the reassigned
// install test before its setup was cut, against Vitest's 5,000 ms default,
// and about 1.6 times the local duration in general. After the cut the test
// takes about 2 s locally, so 30 s leaves more than five times the slowest
// CI measurement while a hang still fails within a minute.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

// Queues `count` notifications to the account's install the way
// `queueToDevice` in ./push.ts does, through the component's send and the
// account's `pushSends` record, without the event rows that the deletion's
// purge would also have to delete.
async function queueHistory(t: Setup["t"], userId: Id<"users">, deviceId: string, count: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      const notificationId = await pushNotifications.sendPushNotification(ctx, {
        userId: deviceId,
        notification: { title: `History ${i}` },
      });
      if (notificationId !== null) {
        await ctx.db.insert("pushSends", { userId, notificationId });
      }
    }
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

// Every message body Expo received, as parsed JSON.
let sent: { to: string; title?: string }[] = [];

function accepted(init?: RequestInit) {
  const messages = JSON.parse(String(init?.body ?? "[]")) as { to: string; title?: string }[];
  sent.push(...messages);
  return new Response(JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "x" })) }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      String(url).startsWith("https://exp.host")
        ? accepted(init)
        : new Response(null, { status: 200 }),
    ),
  );
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// Queues one event push to every current install of the account, through
// AgentDesk's own delivery path.
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

// Lets the scheduler run every job due within `ms`, then waits for the jobs
// it started.
async function runScheduled(t: Setup["t"], ms: number) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
}

function notification(t: Setup["t"], id: string) {
  return t.run((ctx) => pushNotifications.getNotification(ctx, { id }));
}

describe("account deletion and the push component", () => {
  // Finding 1: the component's deletion continuation looks the install up
  // again, so it must never be able to reach an install that another
  // account registers before it runs.
  test(
    "a reassigned install keeps the new account's notification, token, and send",
    async () => {
      const { t, userA, userB, asA, asB } = await setup();
      await register(asA, "install-x", "ExponentPushToken[a]");
      await queueHistory(t, userA, "install-x", 1100);
      // Expo accepts all 1,100 sends, so every row of A's history is settled.
      for (let i = 0; i < 100 && sent.length < 1100; i++) {
        await runScheduled(t, 300);
      }
      expect(sent).toHaveLength(1100);

      await asA.mutation(identity.accountDeletion.deleteAccount, {});
      // The cancellation's first step runs and deletes the first page.
      await runScheduled(t, 1);

      // Before anything else runs, B registers the same install and queues a
      // push to it.
      await register(asB, "install-x", "ExponentPushToken[b]");
      await queuePush(t, userB, "For B");
      const [forB] = await queued(t, "install-x");
      if (forB === undefined) {
        throw new Error("No queued push for B");
      }

      // Everything scheduled runs until A's cancellation has finished and B's
      // push went out.
      for (let i = 0; i < 200; i++) {
        await runScheduled(t, 1000);
        const settled = (await notification(t, forB.id))?.state === "delivered";
        if (settled && (await tokenRecords(t, userA)).length === 0) {
          break;
        }
      }

      expect(await tokenRecords(t, userA)).toHaveLength(0);
      expect(await tokenStatus(t, "install-x")).toMatchObject({ hasToken: true });
      expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });
      expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  // Finding 2: a token the account registered earlier for the same install
  // still holds its queued notifications.
  test("a push queued under an earlier token of the install is cancelled", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a1]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queuePush(t, userA, "Under the first token");
    await queuePush(t, userB, "For B");
    const [early] = await queued(t, "install-a");
    const [forB] = await queued(t, "install-b");
    if (early === undefined || forB === undefined) {
      throw new Error("No queued push");
    }
    // The app reports a new token for the same install.
    await register(asA, "install-a", "ExponentPushToken[a2]");

    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    for (let i = 0; i < 100; i++) {
      await runScheduled(t, 1000);
    }

    expect(await notification(t, early.id)).toBeNull();
    expect(sent.some((message) => message.to === "ExponentPushToken[a1]")).toBe(false);
    expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });
    expect(sent.filter((message) => message.to === "ExponentPushToken[b]")).toHaveLength(1);
  });

  // Finding 2: an install the account unregistered earlier still holds its
  // queued notifications under its last token.
  test("a push queued to an install the account unregistered earlier is cancelled", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a1]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queuePush(t, userA, "Before sign-out");
    await queuePush(t, userB, "For B");
    const [early] = await queued(t, "install-a");
    const [forB] = await queued(t, "install-b");
    if (early === undefined || forB === undefined) {
      throw new Error("No queued push");
    }
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });

    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    for (let i = 0; i < 100; i++) {
      await runScheduled(t, 1000);
    }

    expect(await notification(t, early.id)).toBeNull();
    expect(sent.some((message) => message.to === "ExponentPushToken[a1]")).toBe(false);
    expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });
  });
});

// Holds the next Expo request open until `release` runs, so the batch it
// carries stays in the sender's hands.
function holdNextSend() {
  let release: () => void = () => undefined;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => accepted(init));
  fetchMock.mockImplementationOnce(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(accepted(init));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, release: () => release() };
}

// Lets the coordinator hand the queued notifications to a sender whose Expo
// request is held open.
async function startHeldSend(t: Setup["t"], fetchMock: ReturnType<typeof vi.fn>) {
  await runScheduled(t, 300);
  vi.advanceTimersByTime(1);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
}

// Runs the scheduler until `done` holds, for at most `rounds` seconds.
async function runUntil(t: Setup["t"], done: () => Promise<boolean>, rounds = 200) {
  for (let i = 0; i < rounds && !(await done()); i++) {
    await runScheduled(t, 1000);
  }
}

// component-notifications §Devices: the sign-out cutoff and the handoff of an
// install between accounts, against the component's real sender.
describe("sign-out and the push component's sender", () => {
  test("a notification queued before sign-out never reaches Expo", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    await queuePush(t, userA, "First");
    await queuePush(t, userA, "Second");
    await queuePush(t, userB, "For B");

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });
    await runUntil(t, async () => sent.length > 0, 20);
    await runScheduled(t, 5000);

    expect(sent.filter((message) => message.to === "ExponentPushToken[a]")).toHaveLength(0);
    expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
    expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(0);
  });

  test("finished notifications are deleted at sign-out", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queuePush(t, userA, "First");
    const [row] = await queued(t, "install-a");
    if (row === undefined) {
      throw new Error("No queued push");
    }
    await runUntil(t, async () => (await notification(t, row.id))?.state === "delivered", 20);
    expect(await notification(t, row.id)).toMatchObject({ state: "delivered" });

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });

    expect(await notification(t, row.id)).toBeNull();
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await pendingDrains(t)).toHaveLength(0);
  });

  test("a send in flight at sign-out settles with another account's batch, then drains", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await register(asB, "install-b", "ExponentPushToken[b]");
    // The other account's push is queued first, so the batch holds both.
    await queuePush(t, userB, "For B");
    await queuePush(t, userA, "First");
    await queuePush(t, userA, "Second");
    const [forB] = await queued(t, "install-b");
    const rowsA = await queued(t, "install-a");
    if (forB === undefined) {
      throw new Error("No queued push for B");
    }
    const { fetchMock, release } = holdNextSend();
    await startHeldSend(t, fetchMock);
    for (const row of rowsA) {
      expect(await notification(t, row.id)).toMatchObject({ state: "in_progress" });
    }

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });

    // Nothing the sender holds is deleted; the install already has no token.
    for (const row of rowsA) {
      expect(await notification(t, row.id)).toMatchObject({ state: "in_progress" });
    }
    expect(await tokenStatus(t, "install-a")).toMatchObject({ hasToken: false });
    expect(await pendingDrains(t)).toHaveLength(1);

    release();
    await t.finishInProgressScheduledFunctions();
    expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });

    await runUntil(t, async () => (await tokenRecords(t, userA)).length === 0);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(0);
    expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });
    expect(await tokenStatus(t, "install-b")).toMatchObject({ hasToken: true });
  });
});

describe("an install moving between accounts and the push component's sender", () => {
  test(
    "a settled history of more than a page under a shared token is gone before the new owner's push",
    async () => {
      const { t, userA, userB, asA, asB } = await setup();
      await register(asA, "install-x", "ExponentPushToken[shared]");
      await queueHistory(t, userA, "install-x", 1100);
      await runUntil(t, async () => sent.length >= 1100, 100);
      expect(sent).toHaveLength(1100);

      await register(asB, "install-x", "ExponentPushToken[shared]");
      await queuePush(t, userB, "For B");
      const [forB] = await queued(t, "install-x");
      await runUntil(t, async () => (await notification(t, forB?.id ?? ""))?.state === "delivered");

      expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
        "For B",
      ]);
      expect(await notification(t, forB?.id ?? "")).toMatchObject({ state: "delivered" });
      expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
      expect(await tokenRecords(t, userA)).toHaveLength(0);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("account deletion after a handoff leaves the new owner's token, notification, and send", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await register(asA, "install-x", "ExponentPushToken[shared]");
    await queuePush(t, userA, "For A");
    await register(asB, "install-x", "ExponentPushToken[shared]");
    await queuePush(t, userB, "For B");
    const [forB] = await queued(t, "install-x");
    if (forB === undefined) {
      throw new Error("No queued push for B");
    }

    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    await runUntil(t, async () => (await notification(t, forB.id))?.state === "delivered");

    expect(await tokenStatus(t, "install-x")).toMatchObject({ hasToken: true });
    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For B",
    ]);
    expect(sent.filter((message) => message.title === "For A")).toHaveLength(0);
    expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
    const sendsB = await t.run((ctx) =>
      ctx.db
        .query("pushSends")
        .withIndex("by_user", (q) => q.eq("userId", userB))
        .collect(),
    );
    expect(sendsB.map((row) => row.notificationId)).toEqual([forB.id]);
  });

  // Review round 2: the former owner signed out with a settled history too
  // long for the sign-out transaction, so its drain is still pending and its
  // device row is gone when the same install and token register for another
  // account. The handoff finds the former owner through its token record.
  async function settledSignOutThenHandoff() {
    const s = await setup();
    const { t, userA, userB, asA, asB } = s;
    await register(asA, "install-x", "ExponentPushToken[shared]");
    await queueHistory(t, userA, "install-x", 1100);
    await runUntil(t, async () => sent.length >= 1100, 100);
    expect(sent).toHaveLength(1100);
    const settled = await tokenHistory(t, "ExponentPushToken[shared]");
    expect(settled.every((row) => row.state === "delivered")).toBe(true);

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-x" });
    // A history of 1,000 or more waits for a drain that has not run yet.
    expect(await tokenHistory(t, "ExponentPushToken[shared]")).toHaveLength(1100);
    expect(await pendingDrains(t)).toHaveLength(1);

    await register(asB, "install-x", "ExponentPushToken[shared]");
    // The handoff deleted A's whole history before B's token was recorded.
    expect(await tokenHistory(t, "ExponentPushToken[shared]")).toHaveLength(0);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
    await queuePush(t, userB, "For B");
    const [forB] = await queued(t, "install-x");
    if (forB === undefined) {
      throw new Error("No queued push for B");
    }
    // A's pending drain runs, finds its record gone, and does nothing.
    await runUntil(t, async () => (await notification(t, forB.id))?.state === "delivered");
    return { ...s, forB };
  }

  async function expectOnlyB(t: Setup["t"], userB: Id<"users">, forBId: string) {
    expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
      "For B",
    ]);
    expect(await notification(t, forBId)).toMatchObject({ state: "delivered" });
    expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
    expect(await tokenStatus(t, "install-x")).toMatchObject({ hasToken: true });
    const recordsB = await tokenRecords(t, userB);
    expect(recordsB.map((row) => [row.token, row.drainScheduledAt])).toEqual([
      ["ExponentPushToken[shared]", undefined],
    ]);
    const sendsB = await t.run((ctx) =>
      ctx.db
        .query("pushSends")
        .withIndex("by_user", (q) => q.eq("userId", userB))
        .collect(),
    );
    expect(sendsB.map((row) => row.notificationId)).toEqual([forBId]);
  }

  test(
    "a settled multi-page sign-out followed by a handoff on the same token leaves none of the former owner's notifications",
    async () => {
      const { t, userA, userB, forB } = await settledSignOutThenHandoff();

      expect(await tokenRecords(t, userA)).toHaveLength(0);
      expect(await pendingDrains(t)).toHaveLength(0);
      await expectOnlyB(t, userB, forB.id);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test(
    "the former owner's account deletion after that sequence touches nothing of the new owner's",
    async () => {
      const { t, userA, userB, asA, forB } = await settledSignOutThenHandoff();

      await asA.mutation(identity.accountDeletion.deleteAccount, {});
      const purged = () =>
        t.run(async (ctx) => {
          const [record] = await ctx.db.query("accountDeletions").collect();
          return record?.purgedAt !== undefined;
        });
      await runUntil(t, purged, 120);

      // No cancellation of A's was left, so the purge finished and removed
      // A's send records with the rest of the account.
      expect(await purged()).toBe(true);
      expect(await tokenRecords(t, userA)).toHaveLength(0);
      const sendsA = await t.run((ctx) =>
        ctx.db
          .query("pushSends")
          .withIndex("by_user", (q) => q.eq("userId", userA))
          .collect(),
      );
      expect(sendsA).toHaveLength(0);
      await expectOnlyB(t, userB, forB.id);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  // The documented limit, accepted by operator decision on 2026-10-13
  // (option A): the former owner's send is still at Expo when the install
  // takes the same Expo token for another account, and the new owner's push
  // lands on the token before the cleanup finishes. The token's oldest page
  // then holds both accounts' notifications, and push component 0.3.1 can
  // delete only whole pages, so the cleanup stops and logs. It deletes
  // nothing of the new owner's and leaves the former owner's notification.
  for (const path of ["handoff", "sign-out, then handoff"] as const) {
    test(`${path} on a shared token while the former owner's send is in flight stops and keeps the new owner's push`, async () => {
      const { t, userA, userB, asA, asB } = await setup();
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await register(asA, "install-x", "ExponentPushToken[shared]");
      await queuePush(t, userA, "For A");
      const [forA] = await queued(t, "install-x");
      if (forA === undefined) {
        throw new Error("No queued push for A");
      }
      const { fetchMock, release } = holdNextSend();
      await startHeldSend(t, fetchMock);
      expect(await notification(t, forA.id)).toMatchObject({ state: "in_progress" });

      if (path === "sign-out, then handoff") {
        await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-x" });
      }
      await register(asB, "install-x", "ExponentPushToken[shared]");
      // The send is still in flight, so the former owner's row waits for a
      // drain.
      expect(await notification(t, forA.id)).toMatchObject({ state: "in_progress" });
      expect(await pendingDrains(t)).toHaveLength(1);
      await queuePush(t, userB, "For B");
      const [forB] = await queued(t, "install-x");
      if (forB === undefined) {
        throw new Error("No queued push for B");
      }
      release();
      await t.finishInProgressScheduledFunctions();
      const stopped = async () =>
        (await tokenRecords(t, userA)).every(
          (row) => row.drainScheduledAt === CANCELLATION_STOPPED,
        );
      await runUntil(
        t,
        async () => (await stopped()) && (await notification(t, forB.id))?.state === "delivered",
      );

      // The cleanup stopped and logged. The former owner keeps the token's
      // record, marked stopped, and no drain loops on it.
      expect(await tokenRecords(t, userA)).toEqual([
        expect.objectContaining({
          token: "ExponentPushToken[shared]",
          drainScheduledAt: CANCELLATION_STOPPED,
        }),
      ]);
      expect(await pendingDrains(t)).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("stopped"));
      // Nothing of the new owner's is deleted: its notification, send, token,
      // and token record survive, and the push reached Expo once.
      expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });
      expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
      expect(await tokenStatus(t, "install-x")).toMatchObject({ hasToken: true });
      expect(await tokenRecords(t, userB)).toHaveLength(1);
      const sendsB = await t.run((ctx) =>
        ctx.db
          .query("pushSends")
          .withIndex("by_user", (q) => q.eq("userId", userB))
          .collect(),
      );
      expect(sendsB.map((row) => row.notificationId)).toEqual([forB.id]);
      // The former owner's notification, handed to the sender before the
      // handoff, stays on the shared token.
      expect(await notification(t, forA.id)).toMatchObject({ state: "delivered" });
      expect((await tokenHistory(t, "ExponentPushToken[shared]")).map((row) => row.title)).toEqual([
        "For B",
        "For A",
      ]);

      // The former owner's account deletion looks at the token again. The
      // page still holds B's notification, so it stops once more and drops
      // the record so the purge can finish; nothing of B's is touched.
      await asA.mutation(identity.accountDeletion.deleteAccount, {});
      expect(await tokenRecords(t, userA)).toHaveLength(0);
      expect(await notification(t, forB.id)).toMatchObject({ state: "delivered" });
      expect(await tokenStatus(t, "install-x")).toMatchObject({ hasToken: true });
      expect(await tokenRecords(t, userB)).toHaveLength(1);
    });
  }
});

// Review round 1, finding 2: the sign-out cutoff beyond the in-transaction
// case, measured against the component's real sender. Each test counts the
// messages Expo receives for the signed-out install's token after
// `unregisterDevice` returns. The sender batches at most 100 notifications.
describe("the sign-out cutoff beyond one transaction, measured", () => {
  test(
    "1,100 queued at sign-out: one sender batch of 100 still reaches Expo, the other 1,000 are deleted",
    async () => {
      const { t, userA, userB, asA, asB } = await setup();
      await register(asA, "install-a", "ExponentPushToken[a]");
      await register(asB, "install-b", "ExponentPushToken[b]");
      await queueHistory(t, userA, "install-a", 1100);
      await queuePush(t, userB, "For B");
      expect(sent).toHaveLength(0);

      await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });
      // A history of 1,000 or more is left to a drain, so nothing is deleted
      // in the sign-out transaction.
      expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(1100);
      await runUntil(t, async () => (await tokenRecords(t, userA)).length === 0);
      await runUntil(t, async () => false, 30);

      // Measured: the coordinator's first batch, queued before the sign-out,
      // went to Expo before the drain's first look; the drain then deleted
      // the remaining 1,000 queued notifications.
      expect(sent.filter((message) => message.to === "ExponentPushToken[a]")).toHaveLength(100);
      expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(0);
      expect(await tokenRecords(t, userA)).toHaveLength(0);
      expect(sent.filter((message) => message.title === "For B")).toHaveLength(1);
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("queued behind an in-flight batch at sign-out: the batch reaches Expo, none of the 50 behind it does", async () => {
    const { t, userA, asA } = await setup();
    await register(asA, "install-a", "ExponentPushToken[a]");
    await queueHistory(t, userA, "install-a", 150);
    const { fetchMock, release } = holdNextSend();
    await startHeldSend(t, fetchMock);
    const before = await tokenHistory(t, "ExponentPushToken[a]");
    expect(before.filter((row) => row.state === "in_progress")).toHaveLength(100);
    expect(before.filter((row) => row.state === "awaiting_delivery")).toHaveLength(50);

    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-a" });
    expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(150);
    release();
    await t.finishInProgressScheduledFunctions();
    await runUntil(t, async () => (await tokenRecords(t, userA)).length === 0);
    await runUntil(t, async () => false, 30);

    // Measured: Expo received one request, the 100 already in flight at
    // sign-out; the drain deleted the 50 queued behind them before the
    // coordinator took them.
    const requests = fetchMock.mock.calls.map(
      (call) => (JSON.parse(String((call[1] as RequestInit).body)) as unknown[]).length,
    );
    expect(requests).toEqual([100]);
    expect(await tokenHistory(t, "ExponentPushToken[a]")).toHaveLength(0);
    expect(await tokenRecords(t, userA)).toHaveLength(0);
  });
});
