import { convexTest, type TestConvex } from "convex-test";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { pushNotifications } from "./push";
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
