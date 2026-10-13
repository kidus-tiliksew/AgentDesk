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

// The most notifications the component's `deleteNotificationsForUser`
// deletes in one call. It deletes the install's oldest rows first, and when
// it fills a page it schedules its own continuation for the next page, which
// runs later without any check.
export const COMPONENT_PAGE = 1000;
// The most notifications a drain reads to see an install's whole history.
export const HISTORY_READ_LIMIT = 4000;
// A drain looks again every DRAIN_RETRY_MS for its first DRAIN_FAST_LOOKS
// looks, then every DRAIN_SLOW_RETRY_MS. The component's sender records a
// send's outcome when Expo answers, or after 10 seconds when it cannot tell,
// and retries a failed send at most five times.
export const DRAIN_RETRY_MS = 50;
export const DRAIN_FAST_LOOKS = 400;
export const DRAIN_SLOW_RETRY_MS = 30_000;

// States the component never changes again. A queued (`awaiting_delivery`)
// or retrying (`needs_retry`) notification can still be handed to the
// sender, and an `in_progress` one is in the sender's hands.
const SETTLED_STATES = new Set(["delivered", "failed", "maybe_delivered", "unable_to_deliver"]);

type Notification = Awaited<ReturnType<typeof pushNotifications.getNotificationsForUser>>[number];

// What one look at an install's notifications did.
type Look =
  // Every notification and the token are gone.
  | "done"
  // Something must settle, or a deletion is still running; look again.
  | "wait"
  // The history is longer than one look can check; nothing was deleted.
  | "too_long";

// One look at an install's notifications, reading at most `limit` of them,
// newest first. The component's sender records each send's outcome on its
// row and fails the whole batch, other accounts' notifications included,
// when a row is missing, so no look ever deletes a row that is
// `in_progress`, and no look starts a deletion whose rows it has not read:
//
// - Fewer than COMPONENT_PAGE rows, none in flight: one call deletes every
//   row, queued and retrying ones included, and schedules no continuation.
//   The token goes in the same transaction.
// - COMPONENT_PAGE rows or more, all settled: the component's own
//   continuations delete the rest of the history later without a check. That
//   is safe only because every row is settled and nothing can add a row: the
//   install's `devices` row is gone, so AgentDesk queues nothing for it.
// - Anything else waits. In a long history, queued and retrying rows are
//   sent or settle before the history is deleted.
async function look(ctx: MutationCtx, deviceId: string, limit: number): Promise<Look> {
  const rows: Notification[] = await pushNotifications.getNotificationsForUser(ctx, {
    userId: deviceId,
    limit,
  });
  if (rows.length === 0) {
    await pushNotifications.removeToken(ctx, { userId: deviceId });
    return "done";
  }
  if (rows.length >= limit) {
    return limit > COMPONENT_PAGE ? "too_long" : "wait";
  }
  if (rows.some((row) => row.state === "in_progress")) {
    return "wait";
  }
  if (rows.length < COMPONENT_PAGE) {
    await pushNotifications.deleteNotificationsForUser(ctx, { userId: deviceId });
    await pushNotifications.removeToken(ctx, { userId: deviceId });
    return "done";
  }
  if (rows.every((row) => SETTLED_STATES.has(row.state))) {
    await pushNotifications.deleteNotificationsForUser(ctx, { userId: deviceId });
  }
  return "wait";
}

// Cancels every send the push component holds for an install and removes the
// install's token. It runs in the deletion transaction, after the caller
// deleted the install's `devices` row. The component copies the token into
// each queued notification, so removing the token alone would still send
// what is queued (§Push). When the install holds fewer than COMPONENT_PAGE
// notifications and none is in flight, every queued and retrying send is
// deleted in this transaction. Otherwise the token stays and
// `drainDevicePushes` finishes the work in later transactions.
export async function cancelDevicePushes(ctx: MutationCtx, deviceId: string): Promise<void> {
  if ((await look(ctx, deviceId, COMPONENT_PAGE)) === "done") {
    return;
  }
  await ctx.scheduler.runAfter(0, notifications.accountPurge.drainDevicePushes, {
    deviceId,
    attempt: 1,
  });
}

// Finishes `cancelDevicePushes` for an install that had a send in flight or
// a long notification history. It reads the whole history, up to
// HISTORY_READ_LIMIT notifications, on every look and never deletes a row in
// flight; it waits instead, without a limit on the number of looks. It
// stops when another account has registered the install since, because the
// component's token then belongs to that account. A history longer than
// HISTORY_READ_LIMIT cannot be checked, so the drain logs it and stops,
// leaving the history and the token in the component.
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
    const result = await look(ctx, deviceId, HISTORY_READ_LIMIT + 1);
    if (result === "done") {
      return null;
    }
    if (result === "too_long") {
      console.error(
        `Push drain stopped: an install holds more than ${HISTORY_READ_LIMIT} notifications`,
      );
      return null;
    }
    if (attempt === DRAIN_FAST_LOOKS) {
      console.error(`Push drain for an install is still waiting after ${attempt} looks`);
    }
    await ctx.scheduler.runAfter(
      attempt < DRAIN_FAST_LOOKS ? DRAIN_RETRY_MS : DRAIN_SLOW_RETRY_MS,
      notifications.accountPurge.drainDevicePushes,
      { deviceId, attempt: attempt + 1 },
    );
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
