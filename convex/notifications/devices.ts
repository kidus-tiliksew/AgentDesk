import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { cancelAccountPushes, cancelInstallPushes } from "./accountPurge";
import { pushNotifications } from "./push";
import { platformValidator } from "./schema";

// component-notifications §Devices. Each row and the push component's token
// share the install's `deviceId` as key (DEC-7), and every function below
// changes both in one transaction.

function requireNonEmpty(value: string, field: string) {
  if (value === "") {
    throw appError(errorCodeSchema.enum.invalid, `${field} is empty`, field);
  }
}

function ownedDevice(ctx: Pick<QueryCtx, "db">, userId: Id<"users">, deviceId: string) {
  return ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .unique();
}

// The app calls this after sign-in and whenever its push token changes. An
// install that signs in to another account moves to that account: the lookup
// spans every account, so the former owner keeps no row for the install and
// its later events select no device for it, and the former owner's
// notifications for the install are cancelled before the new token is
// recorded (§Devices). The token replaces the one the component held for the
// install. A re-registration by the same owner, such as a token refresh,
// keeps the install's notifications.
export const registerDevice = mutation({
  args: {
    deviceId: v.string(),
    pushToken: v.string(),
    platform: platformValidator,
    name: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    requireNonEmpty(args.deviceId, "deviceId");
    requireNonEmpty(args.pushToken, "pushToken");
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", args.deviceId))
      .collect();
    let own = null;
    const formerOwners = new Set<Id<"users">>();
    for (const row of rows) {
      if (row.userId === user._id && own === null) {
        own = row;
      } else {
        await ctx.db.delete("devices", row._id);
        if (row.userId !== user._id) {
          formerOwners.add(row.userId);
        }
      }
    }
    // Before the install takes the new owner's token, which can be the same
    // Expo token, so the former owner's history under it is gone before the
    // new owner can queue anything there.
    for (const formerOwner of formerOwners) {
      await cancelInstallPushes(ctx, formerOwner, args.deviceId, "handoff");
    }
    if (own === null) {
      await ctx.db.insert("devices", {
        userId: user._id,
        deviceId: args.deviceId,
        name: args.name,
        platform: args.platform,
      });
    } else {
      await ctx.db.patch("devices", own._id, { name: args.name, platform: args.platform });
    }
    await pushNotifications.recordToken(ctx, { userId: args.deviceId, pushToken: args.pushToken });
    // Every token the account registers for an install is kept until a
    // sign-out, a handoff, or account deletion has cancelled its
    // notifications (§Account deletion). A record whose cancellation is still
    // draining is not reused.
    const records = await ctx.db
      .query("deviceTokens")
      .withIndex("by_user_device_token", (q) =>
        q.eq("userId", user._id).eq("deviceId", args.deviceId).eq("token", args.pushToken),
      )
      .collect();
    if (records.every((record) => record.drainScheduledAt !== undefined)) {
      await ctx.db.insert("deviceTokens", {
        userId: user._id,
        deviceId: args.deviceId,
        token: args.pushToken,
      });
    }
    return null;
  },
});

// The app calls this on sign-out, before ending the Clerk session, so the
// install receives nothing more (req-mobile-app AC-4.2). The install's token
// goes, and the notifications the account queued for the install are
// cancelled under every token it registered there (§Devices). An install the
// signed-in person does not own is left unchanged, as is its token.
export const unregisterDevice = mutation({
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const device = await ownedDevice(ctx, user._id, args.deviceId);
    if (device === null) {
      return null;
    }
    await ctx.db.delete("devices", device._id);
    await pushNotifications.removeToken(ctx, { userId: device.deviceId });
    await cancelInstallPushes(ctx, user._id, device.deviceId, "signOut");
    return null;
  },
});

// Account deletion: removes every device of the account and its token, so
// nothing queues a new push for the account, then cancels every push the
// component still holds under any token the account registered
// (§Account deletion).
export async function removeAllDevices(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId))
    .collect();
  for (const device of devices) {
    await ctx.db.delete("devices", device._id);
    await pushNotifications.removeToken(ctx, { userId: device.deviceId });
  }
  await cancelAccountPushes(ctx, userId);
}
