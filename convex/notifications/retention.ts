import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import {
  COMPONENT_PAGE,
  type ComponentNotification,
  deleteCheckedPages,
  HANDOFF_PAGES,
  HISTORY_READ_LIMIT,
  ownerDeleting,
  queuedByAccount,
} from "./accountPurge";
import { notifications } from "./refs";

// component-notifications §Push history retention: an hourly sweep that
// deletes the push component's settled notifications once they are older than
// RETENTION_MS, so an install's history stays small and account deletion's
// in-transaction cutoff applies to it (req-accounts-and-connections AC-5.1,
// §Account deletion).
//
// Push component 0.3.1 deletes only whole pages: `deleteNotificationsForUser`
// deletes a token's oldest 1,000 notifications in any state. Retention
// therefore deletes a token's oldest page only when one read proves that every
// notification on it is old, settled, and queued by the account that holds
// the token record, through the read-before-delete primitive that cancellation
// uses (`deleteCheckedPages` in ./accountPurge.ts). A page that mixes such
// notifications with anything else stays whole.

// How long a settled notification stays in the component, counted from its
// creation, the only timestamp the component keeps.
export const RETENTION_MS = 24 * 60 * 60 * 1000;
// The installs one sweep step reads from `devices`.
export const SCAN_PAGE = 10;
// The most pages one sweep deletes under one token record, one per mutation:
// a whole history that one read can see.
export const CHAIN_PAGES = HANDOFF_PAGES;
// The prefix of the private keys retention reads and deletes through. It
// differs from cancellation's, and install ids are UUIDs, so no other key
// ever uses one.
export const RETAIN_KEY_PREFIX = "agentdesk-retain:";

// The states in which the component's sender is done with a notification.
// `awaiting_delivery` and `needs_retry` are queued, and `in_progress` is in
// the sender's hands.
const SETTLED_STATES: ReadonlySet<string> = new Set([
  "delivered",
  "failed",
  "maybe_delivered",
  "unable_to_deliver",
]);

// Why retention left a token's oldest page whole.
export type RetentionBlock =
  // A notification on the page is in the sender's hands.
  | "inFlight"
  // A notification on the page is queued or waiting for a retry.
  | "unsettled"
  // A notification on the page is in a state retention does not know.
  | "unknownState"
  // A notification on the page is not older than the cutoff.
  | "recent"
  // A notification on the page is another account's, or has no `pushSends`
  // record.
  | "foreign";

// The page check: every notification on the page must be settled, created
// before `cutoff`, and queued by `generation`'s account.
function retentionCheck(generation: Doc<"deviceTokens">, cutoff: number) {
  return async (
    ctx: MutationCtx,
    page: ComponentNotification[],
  ): Promise<RetentionBlock | null> => {
    if (page.some((row) => row.state === "in_progress")) {
      return "inFlight";
    }
    if (page.some((row) => row.state === "awaiting_delivery" || row.state === "needs_retry")) {
      return "unsettled";
    }
    if (page.some((row) => !SETTLED_STATES.has(row.state))) {
      return "unknownState";
    }
    if (page.some((row) => row._creationTime >= cutoff)) {
      return "recent";
    }
    return (await queuedByAccount(ctx, page, generation.userId)) ? null : "foreign";
  };
}

// What one pruning step did under one token record.
export type PruneResult =
  // The record, its install, or its account no longer qualifies.
  | { outcome: "skipped" }
  // The token holds nothing older than the cutoff.
  | { outcome: "nothingDue" }
  // The read reached HISTORY_READ_LIMIT + 1 notifications.
  | { outcome: "overLimit" }
  | { outcome: "blocked"; reason: RetentionBlock }
  // One page was deleted; `more` when the token still holds a notification
  // older than the cutoff.
  | { outcome: "deleted"; more: boolean };

// One pruning step for one token record of an install: it reads the token's
// history once and deletes at most its oldest page. It runs only while the
// record is a registration record (no `drainScheduledAt`), its install row
// still belongs to the record's account, and that account is not being
// deleted; a record whose cancellation is pending or stopped belongs to the
// cancellation (§Account deletion).
export async function pruneTokenPage(
  ctx: MutationCtx,
  generation: Doc<"deviceTokens">,
  device: Doc<"devices">,
  cutoff: number,
): Promise<PruneResult> {
  if (
    generation.drainScheduledAt !== undefined ||
    device.userId !== generation.userId ||
    device.deviceId !== generation.deviceId ||
    (await ownerDeleting(ctx, generation.userId))
  ) {
    return { outcome: "skipped" };
  }
  const result = await deleteCheckedPages(ctx, generation, {
    keyPrefix: RETAIN_KEY_PREFIX,
    limit: HISTORY_READ_LIMIT + 1,
    pages: 1,
    check: async (ctx, page) => {
      // Nothing old on the oldest page means nothing old anywhere.
      const oldest = page[page.length - 1];
      if (oldest === undefined || oldest._creationTime >= cutoff) {
        return "nothingDue";
      }
      return retentionCheck(generation, cutoff)(ctx, page);
    },
  });
  switch (result.outcome) {
    case "overLimit":
      console.warn(
        `Push retention for token record ${generation._id} skipped: its history holds more` +
          ` than ${HISTORY_READ_LIMIT} notifications`,
      );
      return { outcome: "overLimit" };
    case "blocked": {
      if (result.reason === "nothingDue") {
        return { outcome: "nothingDue" };
      }
      const log =
        result.reason === "foreign" || result.reason === "unknownState"
          ? console.warn
          : console.info;
      log(
        `Push retention for token record ${generation._id} kept its oldest page of` +
          ` ${Math.min(result.remaining.length, COMPONENT_PAGE)} notifications` +
          ` (${result.remaining.length} read): ${result.reason}`,
      );
      return { outcome: "blocked", reason: result.reason };
    }
    case "deleted": {
      if (result.deleted === 0) {
        return { outcome: "nothingDue" };
      }
      const oldest = result.remaining[result.remaining.length - 1];
      return { outcome: "deleted", more: oldest !== undefined && oldest._creationTime < cutoff };
    }
  }
}

// The hourly sweep (`convex/crons.ts`). It reads `devices` in creation order,
// SCAN_PAGE installs per step, and schedules `scanInstall` for each. Every
// step carries the first step's cutoff, so the whole sweep applies one
// cutoff. A failed step rolls back what it scheduled; the next hourly sweep
// starts over and inspects whatever remains.
export const sweep = internalMutation({
  args: { cursor: v.optional(v.string()), cutoff: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cutoff = args.cutoff ?? Date.now() - RETENTION_MS;
    const result = await ctx.db
      .query("devices")
      .paginate({ cursor: args.cursor ?? null, numItems: SCAN_PAGE });
    for (const device of result.page) {
      await ctx.scheduler.runAfter(0, notifications.retention.scanInstall, {
        deviceRowId: device._id,
        cutoff,
      });
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, notifications.retention.sweep, {
        cursor: result.continueCursor,
        cutoff,
      });
    }
    return null;
  },
});

// Reads the install's registration records, one per step, through
// `deviceTokens.by_user_device_token`, and schedules `pruneToken` for each.
// Tokens a later registration replaced are included, because the
// component's history under them is the account's too. Each record gets its
// own pruning mutation, so a record that blocks or fails holds up no other.
export const scanInstall = internalMutation({
  args: {
    deviceRowId: v.id("devices"),
    cutoff: v.number(),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await ctx.db.get("devices", args.deviceRowId);
    if (device === null || (await ownerDeleting(ctx, device.userId))) {
      return null;
    }
    const result = await ctx.db
      .query("deviceTokens")
      .withIndex("by_user_device_token", (q) =>
        q.eq("userId", device.userId).eq("deviceId", device.deviceId),
      )
      .filter((q) => q.eq(q.field("drainScheduledAt"), undefined))
      .paginate({ cursor: args.cursor ?? null, numItems: 1 });
    for (const generation of result.page) {
      await ctx.scheduler.runAfter(0, notifications.retention.pruneToken, {
        generationId: generation._id,
        deviceRowId: device._id,
        cutoff: args.cutoff,
        pages: 0,
      });
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, notifications.retention.scanInstall, {
        deviceRowId: device._id,
        cutoff: args.cutoff,
        cursor: result.continueCursor,
      });
    }
    return null;
  },
});

// One pruning step for one token record (`pruneTokenPage`). After a deleted
// page it schedules the next step for the same record while the token still
// holds a notification older than the cutoff, up to CHAIN_PAGES pages per
// sweep. Each step reads the device, the account, and the record again and
// repeats the whole proof, so a step scheduled before a sign-out, a handoff,
// or account deletion deletes nothing after it. The deletion and the next
// step commit together, and a failed step rolls back both.
export const pruneToken = internalMutation({
  args: {
    generationId: v.id("deviceTokens"),
    deviceRowId: v.id("devices"),
    cutoff: v.number(),
    pages: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const generation = await ctx.db.get("deviceTokens", args.generationId);
    const device = await ctx.db.get("devices", args.deviceRowId);
    if (generation === null || device === null) {
      return null;
    }
    const result = await pruneTokenPage(ctx, generation, device, args.cutoff);
    if (result.outcome === "deleted" && result.more && args.pages + 1 < CHAIN_PAGES) {
      await ctx.scheduler.runAfter(0, notifications.retention.pruneToken, {
        ...args,
        pages: args.pages + 1,
      });
    }
    return null;
  },
});
