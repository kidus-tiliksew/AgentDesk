import { convexTest, type TestConvex } from "convex-test";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { deliverPush, pushNotifications } from "./push";
import { notifications } from "./refs";

// The push component's test entry is TypeScript source that references
// vite/client types, whose ImportMeta.glob clashes with the declaration in
// convex/lib/test.modules.ts. A specifier typed as a plain string keeps the
// entry out of type checking; Vitest still resolves and transforms it.
const PUSH_TEST_ENTRY: string = "@convex-dev/expo-push-notifications/test";

type PushNotificationsTest = {
  register(t: TestConvex<typeof schema>, name?: string): void;
};

// Shared setup for this domain's tests: a backend with the real push
// component mounted and two accounts. Tests read the component's queue
// through its public queries and never run its scheduled sender, so nothing
// contacts Expo.
export async function setup() {
  const t = convexTest(schema, modules);
  const pushNotificationsTest: PushNotificationsTest = (await import(PUSH_TEST_ENTRY)).default;
  pushNotificationsTest.register(t);
  const { userA, userB } = await t.run(async (ctx) => ({
    userA: await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    userB: await ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" }),
  }));
  const asA = t.withIdentity({ subject: "user_a" });
  const asB = t.withIdentity({ subject: "user_b" });
  return { t, userA, userB, asA, asB };
}

export type Setup = Awaited<ReturnType<typeof setup>>;
type Caller = Setup["asA"];

export function register(as: Caller, deviceId: string, pushToken: string) {
  return as.mutation(notifications.devices.registerDevice, {
    deviceId,
    pushToken,
    platform: "ios",
    name: `Phone ${deviceId}`,
  });
}

export function devicesOf(t: Setup["t"]) {
  return t.run((ctx) => ctx.db.query("devices").collect());
}

// The component's token state for an install.
export function tokenStatus(t: Setup["t"], deviceId: string) {
  return t.run((ctx) => pushNotifications.getStatusForUser(ctx, { userId: deviceId }));
}

// The notifications queued for an install's current token, newest first.
export function queued(t: Setup["t"], deviceId: string) {
  return t.run((ctx) => pushNotifications.getNotificationsForUser(ctx, { userId: deviceId }));
}

// Opens and activates an agent session on topic `repo/x` for `userId`.
export async function openSession(t: Setup["t"], userId: Id<"users">, displayName?: string) {
  const credentialId = await t.run((ctx) =>
    ctx.db.insert("credentials", { userId, kind: "connection_token", tokenHash: "0".repeat(64) }),
  );
  const { agentSessionId } = await t.mutation(agents.sessions.open, {
    userId,
    credentialId,
    clientName: "Claude Code",
    clientVersion: "2.1.0",
  });
  await t.run(async (ctx) => {
    await touch(ctx, userId, agentSessionId, "repo/x", Date.now());
    if (displayName !== undefined) {
      await ctx.db.patch("agentSessions", agentSessionId, { displayName });
    }
  });
  return agentSessionId;
}

// Every stored event, oldest first.
export function eventsOf(t: Setup["t"]) {
  return t.run((ctx) => ctx.db.query("events").collect());
}

// The event ids of the scheduled `route` runs, oldest first.
export async function scheduledRoutes(t: Setup["t"]) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((job) => job.name.startsWith("notifications/route"))
    .map((job) => (job.args[0] as { eventId: Id<"events"> }).eventId);
}

// Queues one event push to every current install of the account, through
// AgentDesk's own delivery path, and returns the event id.
export async function queuePush(t: Setup["t"], userId: Id<"users">, title: string) {
  return t.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      userId,
      kind: "agent.stale",
      occurredAt: Date.now(),
      action: "push",
    });
    await deliverPush(ctx, eventId, { title });
    return eventId;
  });
}

// Queues `count` notifications to the install the way `queueToDevice` in
// ./push.ts does, through the component's send and the account's `pushSends`
// record, without the event rows a purge would also have to delete.
export async function queueHistory(
  t: Setup["t"],
  userId: Id<"users">,
  deviceId: string,
  count: number,
) {
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

// One component notification by id, or null once it is deleted.
export function notification(t: Setup["t"], id: string) {
  return t.run((ctx) => pushNotifications.getNotification(ctx, { id }));
}

// The account's token records, registration records and cancellations alike.
export function tokenRecords(t: Setup["t"], userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

// The pending runs of `drainTokenPushes`.
export function pendingDrains(t: Setup["t"]) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) =>
        job.name.startsWith("notifications/accountPurge:drainTokenPushes") &&
        job.state.kind === "pending",
    ),
  );
}

// Every component notification under an Expo token, newest first, whichever
// install holds the token now. The test reads through a key of its own and
// removes it in the same transaction.
export function tokenHistory(t: Setup["t"], token: string) {
  return t.run(async (ctx) => {
    const key = "test-reader";
    await pushNotifications.recordToken(ctx, { userId: key, pushToken: token });
    const rows = await pushNotifications.getNotificationsForUser(ctx, { userId: key, limit: 5000 });
    await pushNotifications.removeToken(ctx, { userId: key });
    return rows;
  });
}
