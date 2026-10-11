import { errorCodeSchema } from "@agentdesk/contract";
import { PushNotifications } from "@convex-dev/expo-push-notifications";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

// What a caller supplies for one event. deliverPush adds the routing fields to
// `data`.
export type PushMessage = Pick<NotificationFields, "title" | "body" | "categoryId"> & {
  data?: Record<string, unknown>;
};

// The data fields deliverPush derives from the event, so a tap opens the
// right screen (req-mobile-app REQ-4).
const ROUTING_KEYS = new Set(["eventId", "kind", "decisionId", "agentSessionId"]);

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
  const extra = Object.entries(message.data ?? {}).filter(([key]) => !ROUTING_KEYS.has(key));
  const data: Record<string, unknown> = {
    ...Object.fromEntries(extra),
    eventId,
    kind: event.kind,
  };
  if (event.decisionId !== undefined) {
    data.decisionId = event.decisionId;
  }
  if (event.agentSessionId !== undefined) {
    data.agentSessionId = event.agentSessionId;
  }
  const notification: NotificationFields = { title: message.title, data };
  if (message.body !== undefined) {
    notification.body = message.body;
  }
  if (message.categoryId !== undefined) {
    notification.categoryId = message.categoryId;
  }

  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", event.userId))
    .collect();
  for (const device of devices) {
    const delivered = await ctx.db
      .query("pushDeliveries")
      .withIndex("by_event_device", (q) => q.eq("eventId", eventId).eq("deviceId", device.deviceId))
      .first();
    if (delivered !== null) {
      continue;
    }
    await ctx.db.insert("pushDeliveries", { eventId, deviceId: device.deviceId });
    await pushNotifications.sendPushNotification(ctx, { userId: device.deviceId, notification });
  }
}
