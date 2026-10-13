import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { PurgeStep } from "../identity/accountDeletion";
import { pushNotifications } from "./push";
import { notifications } from "./refs";

// component-notifications §Account deletion: this domain's part of account
// deletion (req-accounts-and-connections AC-5.1). `cancelDevicePushes` runs in
// the deletion transaction for each removed install; `purgeNotifications` is
// this domain's part of the purge that `identity/accountDeletion:purgeBatch`
// drives.

// The most component notifications one call reads or deletes for an install;
// the component's own `deleteNotificationsForUser` deletes this many per call.
export const COMPONENT_PAGE = 1000;
// How long a drain waits for a send in flight before it looks again, and how
// many times it looks. The component marks a send's outcome when Expo
// answers, or after 10 seconds when it cannot tell, so a send stays in flight
// for at most about 10 seconds.
export const DRAIN_RETRY_MS = 50;
export const DRAIN_MAX_ATTEMPTS = 400;

// Cancels every send the push component holds for an install and removes the
// install's token. The component copies the token into each queued
// notification, so removing the token alone would still send what is queued
// (§Push). `deleteNotificationsForUser` deletes the install's notifications
// in every state, which cancels the queued and retrying ones and removes
// their copied titles and bodies.
//
// A notification in state `in_progress` is in the hands of the component's
// sender, which records the outcome on that row when Expo answers; deleting
// the row would make that record fail for the whole batch, including other
// accounts' notifications. So when a send is in flight, or the install holds
// more notifications than one call deletes, the token stays and
// `drainDevicePushes` finishes the work in later transactions. The caller has
// already deleted the install's `devices` row, so nothing in AgentDesk queues
// a new send to it.
export async function cancelDevicePushes(ctx: MutationCtx, deviceId: string): Promise<void> {
  if (await deleteSettledPushes(ctx, deviceId)) {
    return;
  }
  await ctx.scheduler.runAfter(0, notifications.accountPurge.drainDevicePushes, {
    deviceId,
    attempt: 1,
  });
}

// One step of the cancellation. Returns true when the install's
// notifications and token are gone, and false when a send is in flight or
// more notifications remain, without deleting anything in flight.
async function deleteSettledPushes(ctx: MutationCtx, deviceId: string): Promise<boolean> {
  const rows = await pushNotifications.getNotificationsForUser(ctx, {
    userId: deviceId,
    limit: COMPONENT_PAGE,
  });
  if (rows.some((row) => row.state === "in_progress")) {
    return false;
  }
  if (rows.length > 0) {
    await pushNotifications.deleteNotificationsForUser(ctx, { userId: deviceId });
  }
  if (rows.length >= COMPONENT_PAGE) {
    return false;
  }
  await pushNotifications.removeToken(ctx, { userId: deviceId });
  return true;
}

// Finishes `cancelDevicePushes` for an install that had a send in flight or a
// long notification history. It stops when another account has registered
// the install since, because the component's token then belongs to that
// account. A send still in flight after DRAIN_MAX_ATTEMPTS looks is treated as
// settled.
export const drainDevicePushes = internalMutation({
  args: { deviceId: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { deviceId, attempt }) => {
    const owner = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .first();
    if (owner !== null) {
      return null;
    }
    if (attempt >= DRAIN_MAX_ATTEMPTS) {
      await pushNotifications.deleteNotificationsForUser(ctx, { userId: deviceId });
      await pushNotifications.removeToken(ctx, { userId: deviceId });
      console.error(`Push drain for an install gave up waiting after ${attempt} looks`);
      return null;
    }
    if (await deleteSettledPushes(ctx, deviceId)) {
      return null;
    }
    await ctx.scheduler.runAfter(DRAIN_RETRY_MS, notifications.accountPurge.drainDevicePushes, {
      deviceId,
      attempt: attempt + 1,
    });
    return null;
  },
});

// Deletes at most `budget` of the account's notification rows and reports
// whether none remain: devices, with their component notifications and
// token; events, each after its push delivery rows; digests; rules; and the
// settings row. Events are found by owner, so events of decisions or
// sessions already deleted are included, and delivery rows are found through
// their event, so deliveries to installs unregistered earlier are included.
export async function purgeNotifications(
  ctx: MutationCtx,
  userId: Id<"users">,
  budget: number,
): Promise<PurgeStep> {
  let deleted = 0;

  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId))
    .take(budget);
  for (const device of devices) {
    await ctx.db.delete("devices", device._id);
    await cancelDevicePushes(ctx, device.deviceId);
  }
  deleted += devices.length;

  while (deleted < budget) {
    const event = await ctx.db
      .query("events")
      .withIndex("by_user_action_digest", (q) => q.eq("userId", userId))
      .first();
    if (event === null) {
      break;
    }
    const deliveries = await ctx.db
      .query("pushDeliveries")
      .withIndex("by_event_device", (q) => q.eq("eventId", event._id))
      .take(budget - deleted);
    for (const delivery of deliveries) {
      await ctx.db.delete("pushDeliveries", delivery._id);
    }
    deleted += deliveries.length;
    if (deleted >= budget) {
      return { deleted, done: false };
    }
    await ctx.db.delete("events", event._id);
    deleted++;
  }

  for (const table of ["digests", "rules", "settings"] as const) {
    if (deleted >= budget) {
      return { deleted, done: false };
    }
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(budget - deleted);
    for (const row of rows) {
      await ctx.db.delete(table, row._id);
    }
    deleted += rows.length;
  }

  return { deleted, done: deleted < budget };
}
