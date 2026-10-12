import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { deliverDigestPush, type PushMessage } from "./push";
import { notifications } from "./refs";
import { nextDigestAt } from "./time";

// component-notifications §Digests: the daily digest (req-notification-rules
// REQ-6). The cron `digest dispatch` runs `dispatchDue` every 5 minutes. It
// schedules one `dispatchUser` per due settings row, and each `dispatchUser`
// builds, stamps, pushes, and reschedules one person's digest in one
// transaction.

// The most settings rows one `dispatchDue` run schedules. Later runs take
// the rows still due.
export const DISPATCH_BATCH = 100;

export const DIGEST_TITLE = "Daily digest";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The digest push: the title and both counts. The tap opens the digest
// screen through the `{ kind: "digest", digestId }` data that
// deliverDigestPush adds.
export function digestMessage(eventCount: number, pendingCount: number): PushMessage {
  return {
    title: DIGEST_TITLE,
    body: `${plural(eventCount, "event", "events")} · ${plural(pendingCount, "pending decision", "pending decisions")}`,
  };
}

// Reads the earliest settings rows whose `nextDigestAt` has passed, at most
// DISPATCH_BATCH, and schedules one `dispatchUser` for each with the slot it
// saw. A row stays due until its `dispatchUser` advances it, so a row this
// run leaves out, or whose worker fails, is taken by a later run. A row taken
// again before its worker runs gets a second worker, which finds the slot
// advanced and does nothing.
export const dispatchDue = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("settings")
      .withIndex("by_nextDigestAt", (q) => q.lte("nextDigestAt", now))
      .take(DISPATCH_BATCH);
    for (const row of due) {
      await ctx.scheduler.runAfter(0, notifications.digest.dispatchUser, {
        settingsId: row._id,
        expectedNextDigestAt: row.nextDigestAt,
      });
    }
    return due.length;
  },
});

// Moves the slot to the first local `digestTime` strictly after `now`, so a
// slot several days overdue yields one digest, not one per missed day.
async function advance(ctx: MutationCtx, settings: Doc<"settings">, now: number): Promise<void> {
  await ctx.db.patch("settings", settings._id, {
    nextDigestAt: nextDigestAt(settings.timeZone, settings.digestTime, now),
  });
}

// One person's digest for the slot `expectedNextDigestAt`. It does nothing
// when the settings row is gone, its slot no longer equals the expected one,
// as after an earlier worker or a settings change rescheduled it, or the slot
// is not yet due. Otherwise it collects every digest event no digest holds
// and every pending decision. When both are empty it sends nothing
// (req-notification-rules AC-6.2); otherwise it inserts the digest, stamps
// the events, and queues one push per current device. Either way it advances
// the slot. All of this is one transaction: a repeated or overlapping worker
// sees the advanced slot, and a failed send rolls back the digest, the stamps,
// the queued sends, and the advance, leaving the slot due for a later run.
// An account that is missing or being deleted gets no digest; its slot still
// advances, so it does not hold a place in every later batch.
export const dispatchUser = internalMutation({
  args: { settingsId: v.id("settings"), expectedNextDigestAt: v.number() },
  returns: v.union(v.id("digests"), v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const settings = await ctx.db.get("settings", args.settingsId);
    if (
      settings === null ||
      settings.nextDigestAt !== args.expectedNextDigestAt ||
      settings.nextDigestAt > now
    ) {
      return null;
    }
    const user = await ctx.db.get("users", settings.userId);
    if (user === null || user.deletingAt !== undefined) {
      await advance(ctx, settings, now);
      return null;
    }

    const events = await ctx.db
      .query("events")
      .withIndex("by_user_action_digest", (q) =>
        q.eq("userId", user._id).eq("action", "digest").eq("digestId", undefined),
      )
      .collect();
    // AC-6.3: every decision still pending when the digest is sent.
    const pending = await ctx.db
      .query("decisions")
      .withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", "pending"))
      .collect();
    if (events.length === 0 && pending.length === 0) {
      await advance(ctx, settings, now);
      return null;
    }

    const digestId = await ctx.db.insert("digests", {
      userId: user._id,
      eventIds: events.map((event) => event._id),
      pendingDecisionIds: pending.map((decision) => decision._id),
      sentAt: now,
    });
    for (const event of events) {
      await ctx.db.patch("events", event._id, { digestId });
    }
    const digest = await ctx.db.get("digests", digestId);
    if (digest === null) {
      throw new Error("Inserted digest is missing");
    }
    await deliverDigestPush(ctx, digest, digestMessage(events.length, pending.length));
    await advance(ctx, settings, now);
    return digestId;
  },
});
