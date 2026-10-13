import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { PurgeStep } from "../identity/accountDeletion";
import { pushNotifications } from "./push";
import { notifications } from "./refs";

// component-notifications §Account deletion: this domain's part of account
// deletion (req-accounts-and-connections AC-5.1). `cancelAccountPushes` runs
// in the deletion transaction; `drainTokenPushes` finishes what it cannot;
// `purgeNotifications` is this domain's part of the purge that
// `identity/accountDeletion:purgeBatch` drives.
//
// How push component 0.3.1 stores and deletes notifications:
//
// - A `pushTokens` row maps a key (AgentDesk uses the install id) to the
//   install's current Expo push token. Recording a token for a key replaces
//   the token that key held.
// - Each queued notification copies the token string; it keeps no key and
//   no account. The component's coordinator sends it to that token without
//   looking at any key.
// - `getNotificationsForUser` and `deleteNotificationsForUser` look a key up
//   and read notifications by the token it holds now, so they never see
//   notifications under a token the key held earlier.
// - `deleteNotificationsForUser` deletes the token's oldest 1,000
//   notifications in any state. When it fills that page it schedules itself
//   again with the same key, and that continuation looks the key up again
//   when it runs, without any check.
// - Its sender records each send's outcome on the notification's row and
//   fails the whole batch, other accounts' notifications included, when a
//   row is missing.
// - There is no way to delete a single notification by id.
//
// Expo issues one token per app install, whichever account is signed in, so
// one token can carry notifications of several accounts after an install
// moves between them. AgentDesk therefore keeps every token an account
// registered (`deviceTokens`) and the id of every notification it queued for
// the account (`pushSends`).

// The most notifications `deleteNotificationsForUser` deletes in one call.
export const COMPONENT_PAGE = 1000;
// The most notifications a drain reads to see a token's whole history.
export const HISTORY_READ_LIMIT = 4000;
// A drain looks again every DRAIN_RETRY_MS for its first DRAIN_FAST_LOOKS
// looks, then every DRAIN_SLOW_RETRY_MS. The component's sender records a
// send's outcome when Expo answers, or after 10 seconds when it cannot tell.
export const DRAIN_RETRY_MS = 50;
export const DRAIN_FAST_LOOKS = 400;
export const DRAIN_SLOW_RETRY_MS = 30_000;
// A token whose drain was scheduled longer ago than this, and which is still
// stored, gets a new drain from the purge.
export const DRAIN_STALL_MS = 10 * 60_000;
// The prefix of the private keys a cancellation reads and deletes through.
// Install ids are UUIDs, so no install ever uses one.
export const CANCEL_KEY_PREFIX = "agentdesk-cancel:";

type Look =
  // The token holds none of the account's notifications any more.
  | "done"
  // A notification on the next page is in the sender's hands, or more pages
  // remain; look again.
  | "wait"
  // The next page holds a notification that is not the account's, or the
  // history is longer than a look can read. Nothing more can be deleted
  // without touching another account's rows.
  | "stop";

// One look at the notifications under one of the account's tokens, reading
// at most `limit` of them. It reads and deletes through a private key that
// holds the token only inside this transaction:
//
// 1. The private key gets the token, so the component's reads and deletion
//    target exactly that token.
// 2. The page `deleteNotificationsForUser` would delete is the token's
//    oldest COMPONENT_PAGE notifications. It is deleted only when every
//    notification on it is one the account queued (`pushSends`) and none is
//    `in_progress`.
// 3. The private key loses its token before the transaction ends, so the
//    component's own continuation finds no token and deletes nothing. No
//    deletion ever runs unchecked, and none can follow the install to
//    another account.
async function look(
  ctx: MutationCtx,
  generation: Doc<"deviceTokens">,
  limit: number,
): Promise<Look> {
  const key = `${CANCEL_KEY_PREFIX}${generation._id}`;
  await pushNotifications.recordToken(ctx, { userId: key, pushToken: generation.token });
  try {
    const rows = await pushNotifications.getNotificationsForUser(ctx, { userId: key, limit });
    if (rows.length === 0) {
      return "done";
    }
    if (rows.length >= limit) {
      return limit > COMPONENT_PAGE ? "stop" : "wait";
    }
    // Newest first, so the oldest page is the end of the list.
    const page = rows.slice(-COMPONENT_PAGE);
    if (page.some((row) => row.state === "in_progress")) {
      return "wait";
    }
    for (const row of page) {
      const sent = await ctx.db
        .query("pushSends")
        .withIndex("by_notification", (q) => q.eq("notificationId", row.id))
        .first();
      if (sent === null || sent.userId !== generation.userId) {
        return "stop";
      }
    }
    await pushNotifications.deleteNotificationsForUser(ctx, { userId: key });
    return rows.length > COMPONENT_PAGE ? "wait" : "done";
  } finally {
    await pushNotifications.removeToken(ctx, { userId: key });
  }
}

// Ends a token's cancellation. Its row goes either way; a stopped
// cancellation is logged with the reason and leaves the token's remaining
// notifications in the component.
async function finish(ctx: MutationCtx, generation: Doc<"deviceTokens">, result: Look) {
  if (result === "stop") {
    console.error(
      `Push cancellation for token record ${generation._id} stopped: its next page holds` +
        " notifications of another account, or its history is too long to read",
    );
  }
  await ctx.db.delete("deviceTokens", generation._id);
}

async function scheduleDrain(ctx: MutationCtx, generation: Doc<"deviceTokens">, now: number) {
  await ctx.db.patch("deviceTokens", generation._id, { drainScheduledAt: now });
  await ctx.scheduler.runAfter(0, notifications.accountPurge.drainTokenPushes, {
    generationId: generation._id,
    attempt: 1,
  });
}

// Cancels the pushes the component still holds for the account, under every
// token it ever registered. It runs in the deletion transaction, after the
// account's `devices` rows and install tokens are gone, so nothing queues a
// new push for the account. A token with fewer than COMPONENT_PAGE
// notifications, all the account's own and none in flight, is finished in
// this transaction, its queued and retrying sends included. Every other
// token gets a drain.
export async function cancelAccountPushes(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const now = Date.now();
  const generations = await ctx.db
    .query("deviceTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const generation of generations) {
    const result = await look(ctx, generation, COMPONENT_PAGE);
    if (result === "wait") {
      await scheduleDrain(ctx, generation, now);
    } else {
      await finish(ctx, generation, result);
    }
  }
}

// Finishes the cancellation for one token, page by page, each page checked
// in its own transaction. It waits while a notification on the next page is
// in flight, without a limit on the number of looks.
export const drainTokenPushes = internalMutation({
  args: { generationId: v.id("deviceTokens"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { generationId, attempt }) => {
    const generation = await ctx.db.get("deviceTokens", generationId);
    if (generation === null) {
      return null;
    }
    const result = await look(ctx, generation, HISTORY_READ_LIMIT + 1);
    if (result !== "wait") {
      await finish(ctx, generation, result);
      return null;
    }
    if (attempt === DRAIN_FAST_LOOKS) {
      console.error(`Push cancellation for token record ${generationId} is still waiting`);
    }
    await ctx.db.patch("deviceTokens", generationId, { drainScheduledAt: Date.now() });
    await ctx.scheduler.runAfter(
      attempt < DRAIN_FAST_LOOKS ? DRAIN_RETRY_MS : DRAIN_SLOW_RETRY_MS,
      notifications.accountPurge.drainTokenPushes,
      { generationId, attempt: attempt + 1 },
    );
    return null;
  },
});

// Deletes at most `budget` of the account's notification rows and reports
// whether none remain: devices with their install tokens; events, each after
// its push delivery rows; digests; rules; the settings row; and, once every
// token's cancellation has finished, the account's `pushSends` records. While
// a token's cancellation runs, the step reports not done, and a stalled
// cancellation gets a new drain. Events are found by owner, so events of
// decisions or sessions already deleted are included, and delivery rows are
// found through their event, so deliveries to installs unregistered earlier
// are included.
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
    await pushNotifications.removeToken(ctx, { userId: device.deviceId });
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

  // The send records are the cancellation's proof of ownership, so they go
  // only after every token's cancellation has finished.
  const now = Date.now();
  const generations = await ctx.db
    .query("deviceTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget);
  if (generations.length > 0) {
    for (const generation of generations) {
      if (
        generation.drainScheduledAt === undefined ||
        generation.drainScheduledAt < now - DRAIN_STALL_MS
      ) {
        await scheduleDrain(ctx, generation, now);
      }
    }
    return { deleted, done: false };
  }
  if (deleted >= budget) {
    return { deleted, done: false };
  }
  const sends = await ctx.db
    .query("pushSends")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(budget - deleted);
  for (const row of sends) {
    await ctx.db.delete("pushSends", row._id);
  }
  deleted += sends.length;

  return { deleted, done: deleted < budget };
}
