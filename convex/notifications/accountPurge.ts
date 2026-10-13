import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { PurgeStep } from "../identity/accountDeletion";
import { pushNotifications } from "./push";
import { notifications } from "./refs";

// component-notifications §Account deletion and §Devices: cancelling the
// notifications an account queued under its tokens (req-accounts-and-connections
// AC-5.1, req-mobile-app AC-4.2). Three paths share one cancellation:
//
// - `cancelAccountPushes` runs in the account deletion transaction, for every
//   token the account registered.
// - `cancelInstallPushes` runs when an install leaves an account: in
//   `unregisterDevice` (sign-out) and in `registerDevice` when another account
//   takes the install. It covers every token the account registered for that
//   install and nothing of its other installs.
// - `drainTokenPushes` finishes, page by page, what a transaction cannot.
//
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
// registered for an install (`deviceTokens`) and the id of every notification
// it queued for the account (`pushSends`).
//
// A `deviceTokens` row is a registration record while `drainScheduledAt` is
// unset. A cancellation that a transaction cannot finish sets it when it
// schedules the row's drain, and from then on the row only waits for its
// cancellation: `registerDevice` never reuses it and adds a fresh record when
// the account registers the token again.

// The most notifications `deleteNotificationsForUser` deletes in one call.
export const COMPONENT_PAGE = 1000;
// The most notifications a drain reads to see a token's whole history.
export const HISTORY_READ_LIMIT = 4000;
// The most pages a handoff deletes in the transaction that moves an install
// to another account: a whole history that one read can see.
export const HANDOFF_PAGES = HISTORY_READ_LIMIT / COMPONENT_PAGE;
// A drain looks again every DRAIN_RETRY_MS for its first DRAIN_FAST_LOOKS
// looks, then every DRAIN_SLOW_RETRY_MS. The component's sender records a
// send's outcome when Expo answers, or after 10 seconds when it cannot tell.
export const DRAIN_RETRY_MS = 50;
export const DRAIN_FAST_LOOKS = 400;
export const DRAIN_SLOW_RETRY_MS = 30_000;
// A token whose drain was scheduled longer ago than this, and which is still
// stored, gets a new drain from the purge or from a later cancellation.
export const DRAIN_STALL_MS = 10 * 60_000;
// The prefix of the private keys a cancellation reads and deletes through.
// Install ids are UUIDs, so no install ever uses one.
export const CANCEL_KEY_PREFIX = "agentdesk-cancel:";

type Look =
  // The token holds none of the account's notifications any more.
  | "done"
  // More pages remain, or the history is too long for this transaction to
  // read; look again in a drain.
  | "more"
  // A notification on the next page is in the sender's hands; look again
  // once it settles.
  | "busy"
  // The next page holds a notification that is not the account's, or the
  // history is longer than a look can read. Nothing more can be deleted
  // without touching another account's rows.
  | "stop"
  // The account has registered the token again, so a current registration
  // record covers what remains under it.
  | "superseded";

// Whether the account holds a registration record for the token other than
// `generation`, so its install may queue new notifications under the token.
async function registeredAgain(ctx: MutationCtx, generation: Doc<"deviceTokens">) {
  const rows = await ctx.db
    .query("deviceTokens")
    .withIndex("by_user", (q) => q.eq("userId", generation.userId))
    .collect();
  return rows.some(
    (row) =>
      row._id !== generation._id &&
      row.token === generation.token &&
      row.drainScheduledAt === undefined,
  );
}

// One look at the notifications under one of the account's tokens, reading
// at most `limit` of them and deleting at most `pages` pages. It reads and
// deletes through a private key that holds the token only inside this
// transaction:
//
// 1. The private key gets the token, so the component's reads and deletion
//    target exactly that token.
// 2. The page `deleteNotificationsForUser` would delete is the token's
//    oldest COMPONENT_PAGE notifications. It is deleted only when every
//    notification on it is one the account queued (`pushSends`) and none is
//    `in_progress`. With `pages` above 1, the next oldest page is checked
//    and deleted the same way from the same read.
// 3. The private key loses its token before the transaction ends, so the
//    component's own continuation finds no token and deletes nothing. No
//    deletion ever runs unchecked, and none can follow the install to
//    another account.
//
// A look leaves the token alone while the account has registered it again
// (`superseded`): that registration's own cancellation, at the next
// sign-out, handoff, or account deletion, covers the token's whole history,
// and the install's new notifications are never deleted here.
async function look(
  ctx: MutationCtx,
  generation: Doc<"deviceTokens">,
  limit: number,
  pages = 1,
): Promise<Look> {
  if (await registeredAgain(ctx, generation)) {
    return "superseded";
  }
  const key = `${CANCEL_KEY_PREFIX}${generation._id}`;
  await pushNotifications.recordToken(ctx, { userId: key, pushToken: generation.token });
  try {
    let rows = await pushNotifications.getNotificationsForUser(ctx, { userId: key, limit });
    if (rows.length >= limit) {
      return limit > COMPONENT_PAGE ? "stop" : "more";
    }
    for (let deleted = 0; deleted < pages; deleted++) {
      if (rows.length === 0) {
        return "done";
      }
      // Newest first, so the oldest page is the end of the list.
      const page = rows.slice(-COMPONENT_PAGE);
      if (page.some((row) => row.state === "in_progress")) {
        return "busy";
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
      rows = rows.slice(0, -COMPONENT_PAGE);
    }
    return rows.length === 0 ? "done" : "more";
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

// Settles one look of a cancellation that runs in a caller's transaction: a
// finished, stopped, or superseded token's row goes; any other token gets a
// drain, unless a drain scheduled within DRAIN_STALL_MS still runs for it.
async function settle(
  ctx: MutationCtx,
  generation: Doc<"deviceTokens">,
  result: Look,
  now: number,
) {
  if (result === "more" || result === "busy") {
    if (
      generation.drainScheduledAt === undefined ||
      generation.drainScheduledAt < now - DRAIN_STALL_MS
    ) {
      await scheduleDrain(ctx, generation, now);
    }
    return;
  }
  await finish(ctx, generation, result);
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
    // A row an earlier look in this loop finished is gone.
    const current = await ctx.db.get("deviceTokens", generation._id);
    if (current === null) {
      continue;
    }
    await settle(ctx, current, await look(ctx, current, COMPONENT_PAGE), now);
  }
}

// How an install leaves an account: the account signs out on it, or another
// account registers it.
export type InstallDeparture = "signOut" | "handoff";

// Cancels the pushes the component still holds for one install of the
// account, under every token the account registered for it, including tokens
// a later registration replaced. The caller has already deleted the
// account's `devices` row for the install, so nothing queues a new push for
// the account to it. Other installs of the account keep their tokens and
// notifications.
//
// On sign-out a token with fewer than COMPONENT_PAGE notifications, all the
// account's own and none in flight, is finished in this transaction, as in
// account deletion. A handoff runs before the new account's token is
// recorded and deletes up to HANDOFF_PAGES checked pages of each token in
// this transaction, so a history up to HISTORY_READ_LIMIT with nothing in
// flight is gone before the new account can queue a notification under a
// shared token. Every other token gets a drain.
//
// Accepted limit (operator decision, 2026-10-13): when a send of the former
// owner's is in flight at Expo at the handoff, and the new owner gets a push
// under the same Expo token before the drain finishes, the token's oldest
// page holds both accounts' notifications. The drain then stops and logs,
// deleting nothing of the new owner's and leaving the former owner's
// notifications on that page.
export async function cancelInstallPushes(
  ctx: MutationCtx,
  userId: Id<"users">,
  deviceId: string,
  departure: InstallDeparture,
): Promise<void> {
  const now = Date.now();
  const generations = await ctx.db
    .query("deviceTokens")
    .withIndex("by_user_device_token", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .collect();
  for (const generation of generations) {
    const current = await ctx.db.get("deviceTokens", generation._id);
    if (current === null) {
      continue;
    }
    const result =
      departure === "handoff"
        ? await look(ctx, current, HISTORY_READ_LIMIT + 1, HANDOFF_PAGES)
        : await look(ctx, current, COMPONENT_PAGE);
    await settle(ctx, current, result, now);
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
    if (result !== "more" && result !== "busy") {
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
