import { errorCodeSchema } from "@agentdesk/contract";
import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { isValidTimeZone, nextDigestAt, parseTime } from "./time";

// component-notifications §Tables and §Settings: one `settings` row per
// person holds the time zone, quiet hours, urgent override, digest time, stale
// threshold, and the next digest instant. The app calls Convex as that person
// (DEC-3, DEC-7), so each public function resolves the account with
// requireUser before reading any row and takes no user id from the client.
// Convex indexes do not enforce uniqueness, so every writer goes through
// ensureSettings, which reads `by_user` and inserts in the same transaction.

export const DEFAULT_TIME_ZONE = "UTC";
// req-notification-rules AC-6.1.
export const DEFAULT_DIGEST_TIME = "09:00";
// req-notification-rules AC-5.2.
export const DEFAULT_URGENT_OVERRIDE = true;
// req-agent-status AC-3.1: 30 minutes unless set, and any whole number of
// minutes from 5 to 240.
export const DEFAULT_STALE_THRESHOLD_MINUTES = 30;
export const MIN_STALE_THRESHOLD_MINUTES = 5;
export const MAX_STALE_THRESHOLD_MINUTES = 240;

// `default` marks the UTC fallback that nobody chose, `device` a zone the app
// supplied at first launch, and `user` a zone chosen in settings.
export type TimeZoneSource = Doc<"settings">["timeZoneSource"];

// The settings as the app reads them. The contract has no settings read
// shape, so this module defines one in the contract's style: an absent quiet
// endpoint is null.
export type NotificationSettings = {
  time_zone: string;
  time_zone_source: TimeZoneSource;
  quiet_start: string | null;
  quiet_end: string | null;
  urgent_override: boolean;
  digest_time: string;
  stale_threshold_minutes: number;
};

// The fields that decide routing and scheduling, with defaults filled in.
type EffectiveSettings = Pick<
  Doc<"settings">,
  | "timeZone"
  | "timeZoneSource"
  | "quietStart"
  | "quietEnd"
  | "urgentOverride"
  | "digestTime"
  | "staleThresholdMinutes"
>;

const DEFAULTS: EffectiveSettings = {
  timeZone: DEFAULT_TIME_ZONE,
  timeZoneSource: "default",
  urgentOverride: DEFAULT_URGENT_OVERRIDE,
  digestTime: DEFAULT_DIGEST_TIME,
  staleThresholdMinutes: DEFAULT_STALE_THRESHOLD_MINUTES,
};

function invalid(field: string, message = `Invalid ${field}`): never {
  throw appError(errorCodeSchema.enum.invalid, message, field);
}

// The person's row, or null when none exists yet.
export async function readSettings(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
): Promise<Doc<"settings"> | null> {
  return await ctx.db
    .query("settings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

function effective(row: Doc<"settings"> | null): EffectiveSettings {
  if (row === null) {
    return DEFAULTS;
  }
  const settings: EffectiveSettings = {
    timeZone: row.timeZone,
    timeZoneSource: row.timeZoneSource,
    urgentOverride: row.urgentOverride,
    digestTime: row.digestTime,
    staleThresholdMinutes: row.staleThresholdMinutes,
  };
  if (row.quietStart !== undefined) {
    settings.quietStart = row.quietStart;
  }
  if (row.quietEnd !== undefined) {
    settings.quietEnd = row.quietEnd;
  }
  return settings;
}

function toNotificationSettings(settings: EffectiveSettings): NotificationSettings {
  return {
    time_zone: settings.timeZone,
    time_zone_source: settings.timeZoneSource,
    quiet_start: settings.quietStart ?? null,
    quiet_end: settings.quietEnd ?? null,
    urgent_override: settings.urgentOverride,
    digest_time: settings.digestTime,
    stale_threshold_minutes: settings.staleThresholdMinutes,
  };
}

// Returns the person's settings row, inserting one with the defaults and a
// `nextDigestAt` computed from `now` when none exists. `route`,
// updateSettings, and initializeTimeZone call it, so every account with a
// routed event has a row and a next digest instant (req-notification-rules
// REQ-6). An existing row, including its schedule, is returned unchanged.
export async function ensureSettings(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  now: number,
): Promise<Doc<"settings">> {
  const existing = await readSettings(ctx, userId);
  if (existing !== null) {
    return existing;
  }
  const id = await ctx.db.insert("settings", {
    userId,
    ...DEFAULTS,
    nextDigestAt: nextDigestAt(DEFAULTS.timeZone, DEFAULTS.digestTime, now),
  });
  const inserted = await ctx.db.get("settings", id);
  if (inserted === null) {
    throw new Error("Inserted settings row is missing");
  }
  return inserted;
}

// The person's stale threshold in minutes, or the default when they have no
// row (req-agent-status AC-3.1). component-agent-presence reads it for the
// sweep through convex/agents/settings.ts.
export async function staleThresholdMinutes(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
): Promise<number> {
  return effective(await readSettings(ctx, userId)).staleThresholdMinutes;
}

// The person's effective settings. With no row it returns the defaults and
// writes nothing.
export const getSettings = query({
  args: {},
  handler: async (ctx): Promise<NotificationSettings> => {
    const user = await requireUser(ctx);
    return toNotificationSettings(effective(await readSettings(ctx, user._id)));
  },
});

// Updates the fields the app supplies and keeps every omitted one
// (req-mobile-app REQ-5). `null` clears a quiet endpoint. The complete
// resulting settings are checked before any write, so a refused update
// changes nothing. A supplied `timeZone` records the zone as the person's own
// choice, even when it equals the stored one. A changed `timeZone` or
// `digestTime` recomputes `nextDigestAt` from this mutation's time; any other
// edit keeps the schedule.
export const updateSettings = mutation({
  args: {
    timeZone: v.optional(v.string()),
    quietStart: v.optional(v.union(v.string(), v.null())),
    quietEnd: v.optional(v.union(v.string(), v.null())),
    urgentOverride: v.optional(v.boolean()),
    digestTime: v.optional(v.string()),
    staleThresholdMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<NotificationSettings> => {
    const user = await requireUser(ctx);
    const current = effective(await readSettings(ctx, user._id));

    const next: EffectiveSettings = { ...current };
    if (args.timeZone !== undefined) {
      next.timeZone = args.timeZone;
      next.timeZoneSource = "user";
    }
    if (args.quietStart !== undefined) {
      next.quietStart = args.quietStart ?? undefined;
    }
    if (args.quietEnd !== undefined) {
      next.quietEnd = args.quietEnd ?? undefined;
    }
    if (args.urgentOverride !== undefined) {
      next.urgentOverride = args.urgentOverride;
    }
    if (args.digestTime !== undefined) {
      next.digestTime = args.digestTime;
    }
    if (args.staleThresholdMinutes !== undefined) {
      next.staleThresholdMinutes = args.staleThresholdMinutes;
    }

    // The checks run on the complete result, before any write.
    if (!isValidTimeZone(next.timeZone)) {
      invalid("timeZone");
    }
    if (next.quietStart !== undefined && parseTime(next.quietStart) === null) {
      invalid("quietStart");
    }
    if (next.quietEnd !== undefined && parseTime(next.quietEnd) === null) {
      invalid("quietEnd");
    }
    if (next.quietStart !== undefined && next.quietEnd === undefined) {
      invalid("quietEnd", "Quiet hours need both a start and an end");
    }
    if (next.quietStart === undefined && next.quietEnd !== undefined) {
      invalid("quietStart", "Quiet hours need both a start and an end");
    }
    if (next.quietStart !== undefined && next.quietStart === next.quietEnd) {
      invalid("quietEnd", "Quiet hours must start and end at different times");
    }
    if (parseTime(next.digestTime) === null) {
      invalid("digestTime");
    }
    if (
      !Number.isInteger(next.staleThresholdMinutes) ||
      next.staleThresholdMinutes < MIN_STALE_THRESHOLD_MINUTES ||
      next.staleThresholdMinutes > MAX_STALE_THRESHOLD_MINUTES
    ) {
      invalid("staleThresholdMinutes");
    }

    const now = Date.now();
    const row = await ensureSettings(ctx, user._id, now);
    const rescheduled =
      next.timeZone !== row.timeZone || next.digestTime !== row.digestTime
        ? nextDigestAt(next.timeZone, next.digestTime, now)
        : row.nextDigestAt;
    // Absent quiet endpoints are left out, so a replacement clears them.
    const fields: WithoutSystemFields<Doc<"settings">> = {
      userId: user._id,
      timeZone: next.timeZone,
      timeZoneSource: next.timeZoneSource,
      urgentOverride: next.urgentOverride,
      digestTime: next.digestTime,
      staleThresholdMinutes: next.staleThresholdMinutes,
      nextDigestAt: rescheduled,
    };
    if (next.quietStart !== undefined && next.quietEnd !== undefined) {
      fields.quietStart = next.quietStart;
      fields.quietEnd = next.quietEnd;
    }
    await ctx.db.replace("settings", row._id, fields);
    return toNotificationSettings(next);
  },
});

// Records the device's time zone at first launch. It sets the zone only while
// nobody has chosen one (`timeZoneSource` `default`), so a later device zone
// never replaces a device zone or the person's own choice, including an
// explicit UTC. A refused zone changes nothing.
export const initializeTimeZone = mutation({
  args: { timeZone: v.string() },
  handler: async (ctx, args): Promise<NotificationSettings> => {
    const user = await requireUser(ctx);
    if (!isValidTimeZone(args.timeZone)) {
      invalid("timeZone");
    }
    const now = Date.now();
    const row = await ensureSettings(ctx, user._id, now);
    if (row.timeZoneSource !== "default") {
      return toNotificationSettings(effective(row));
    }
    const fields = {
      timeZone: args.timeZone,
      timeZoneSource: "device" as const,
      nextDigestAt:
        args.timeZone === row.timeZone
          ? row.nextDigestAt
          : nextDigestAt(args.timeZone, row.digestTime, now),
    };
    await ctx.db.patch("settings", row._id, fields);
    return toNotificationSettings(effective({ ...row, ...fields }));
  },
});
