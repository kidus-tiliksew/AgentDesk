import { errorCodeSchema } from "@agentdesk/contract";
import { PushNotifications } from "@convex-dev/expo-push-notifications";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { appError } from "../lib/errors";

// component-notifications §Push: per-device delivery through the push
// component (DEC-7). The component queues each notification and sends it to
// Expo from its own scheduled sender; nothing here calls Expo.

// The component client. Its user key is the device's stable install id, not
// the account, so each install holds its own token.
export const pushNotifications = new PushNotifications<string>(components.pushNotifications);

// The component's notification fields, read from its public send method; the
// package exports no name for the type.
type NotificationFields = Parameters<
  PushNotifications<string>["sendPushNotification"]
>[1]["notification"];

// What a caller supplies for one push. deliverPush and deliverDigestPush add
// the routing fields to `data`. `interruptionLevel` is set only for an urgent
// `decision.created` push (§Push sound); every other push leaves it unset.
export type PushMessage = Pick<
  NotificationFields,
  "title" | "body" | "categoryId" | "interruptionLevel"
> & {
  data?: Record<string, unknown>;
};

// The data fields a push derives from its event or digest, so a tap opens the
// right screen (req-mobile-app REQ-4). Caller `data` keeps its other keys and
// cannot set these.
const ROUTING_KEYS = new Set(["eventId", "kind", "decisionId", "agentSessionId", "digestId"]);

// The component notification for `message`, with `routing` laid over the
// caller's data. Every push plays the device's default notification sound;
// without `sound` the platform delivers it silently. Callers cannot change it.
function notificationFor(
  message: PushMessage,
  routing: Record<string, unknown>,
): NotificationFields {
  const extra = Object.entries(message.data ?? {}).filter(([key]) => !ROUTING_KEYS.has(key));
  const notification: NotificationFields = {
    title: message.title,
    data: { ...Object.fromEntries(extra), ...routing },
    sound: "default",
  };
  if (message.body !== undefined) {
    notification.body = message.body;
  }
  if (message.categoryId !== undefined) {
    notification.categoryId = message.categoryId;
  }
  if (message.interruptionLevel !== undefined) {
    notification.interruptionLevel = message.interruptionLevel;
  }
  return notification;
}

// The account's current installs.
function devicesOf(ctx: MutationCtx, userId: Id<"users">): Promise<Doc<"devices">[]> {
  return ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId))
    .collect();
}

// The per-device helper both pushes send through: queues one send to the
// install in the caller's transaction, keyed by its install id (DEC-7). A send
// that throws, such as the component's `NoPushToken` for an install without a
// token, rolls back the caller's transaction. A null result, which the
// component returns for a paused token, counts as sent.
//
// The component returns the queued notification's id, or null for a paused
// token. Each id is recorded against the account in `pushSends`, so account
// deletion can tell the account's own notifications from another account's
// on the same token (§Account deletion).
async function queueToDevice(
  ctx: MutationCtx,
  userId: Id<"users">,
  deviceId: string,
  notification: NotificationFields,
): Promise<void> {
  const notificationId = await pushNotifications.sendPushNotification(ctx, {
    userId: deviceId,
    notification,
  });
  if (notificationId !== null) {
    await ctx.db.insert("pushSends", { userId, notificationId });
  }
}

// Pushes one event to each of its owner's devices that has no delivery row
// for it, inserting the row and queueing the send in the caller's
// transaction, so a repeated or concurrent call sends nothing more
// (req-notification-rules REQ-7). A send that throws rolls back every row and
// queued send of the call. A null send result, which the component returns
// for a paused token, still consumes the device's delivery.
export async function deliverPush(
  ctx: MutationCtx,
  eventId: Id<"events">,
  message: PushMessage,
): Promise<void> {
  const event = await ctx.db.get("events", eventId);
  if (event === null) {
    throw appError(errorCodeSchema.enum.not_found, "Event not found");
  }
  const routing: Record<string, unknown> = { eventId, kind: event.kind };
  if (event.decisionId !== undefined) {
    routing.decisionId = event.decisionId;
  }
  if (event.agentSessionId !== undefined) {
    routing.agentSessionId = event.agentSessionId;
  }
  const notification = notificationFor(message, routing);

  for (const device of await devicesOf(ctx, event.userId)) {
    const delivered = await ctx.db
      .query("pushDeliveries")
      .withIndex("by_event_device", (q) => q.eq("eventId", eventId).eq("deviceId", device.deviceId))
      .first();
    if (delivered !== null) {
      continue;
    }
    await ctx.db.insert("pushDeliveries", { eventId, deviceId: device.deviceId });
    await queueToDevice(ctx, event.userId, device.deviceId, notification);
  }
}

// Pushes a digest that the caller inserted in this transaction to each of its
// owner's current devices, with data `{ kind: "digest", digestId }` and no
// `eventId` (§Digests). It writes no delivery rows: its only caller,
// `notifications/digest:dispatchUser`, advances `nextDigestAt` in the same
// transaction, so a repeated or overlapping run finds the slot taken and sends
// nothing, and a send that throws rolls back the digest with every queued
// send (req-notification-rules REQ-7).
export async function deliverDigestPush(
  ctx: MutationCtx,
  digest: Doc<"digests">,
  message: PushMessage,
): Promise<void> {
  const notification = notificationFor(message, { kind: "digest", digestId: digest._id });
  for (const device of await devicesOf(ctx, digest.userId)) {
    await queueToDevice(ctx, digest.userId, device.deviceId, notification);
  }
}
