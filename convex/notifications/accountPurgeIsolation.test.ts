import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { identity } from "../identity/refs";
import { deliverPush, pushNotifications } from "./push";
import { notifications } from "./refs";
import { queued, register, type Setup, setup, tokenStatus } from "./test.setup";

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
