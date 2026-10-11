import { defineTable } from "convex/server";
import { v } from "convex/values";

// The notifications domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition; component-notifications §Tables).
// Rules, settings, digests, and webhook tables arrive with the later slices
// that use them.

// The five notifiable kinds (req-notification-rules REQ-2) and the two
// webhook-only kinds, mirrored from webhookEventKindSchema in
// @agentdesk/contract.
export const eventKindValidator = v.union(
  v.literal("decision.created"),
  v.literal("decision.expired"),
  v.literal("decision.answered"),
  v.literal("decision.cancelled"),
  v.literal("agent.stale"),
  v.literal("agent.status_changed"),
  v.literal("agent.done"),
);

// The routed action (req-notification-rules REQ-1). null marks a webhook-only
// kind that rules do not route, mirrored from webhookActionSchema.
export const actionValidator = v.union(
  v.literal("push"),
  v.literal("digest"),
  v.literal("mute"),
  v.null(),
);

export const platformValidator = v.union(v.literal("ios"), v.literal("android"));

export const tables = {
  // One row per emitted event. `action` stays unset until `route` stores it.
  // `digestId` stays unset until the digest slice stamps it; it is a string so
  // that slice can adopt a typed id once the `digests` table exists.
  events: defineTable({
    userId: v.id("users"),
    kind: eventKindValidator,
    topic: v.optional(v.string()),
    decisionId: v.optional(v.id("decisions")),
    agentSessionId: v.optional(v.id("agentSessions")),
    // Decision events only.
    priority: v.optional(v.union(v.literal("normal"), v.literal("urgent"))),
    // Epoch milliseconds.
    occurredAt: v.number(),
    action: v.optional(actionValidator),
    digestId: v.optional(v.string()),
  }),

  // One row per app install. `deviceId` is the stable install id and the push
  // component's user key, so the push token lives only in the component
  // (DEC-7). One account owns a `deviceId` at a time; registerDevice keeps
  // that invariant through `by_device`.
  devices: defineTable({
    userId: v.id("users"),
    deviceId: v.string(),
    name: v.string(),
    platform: platformValidator,
  })
    .index("by_device", ["deviceId"])
    .index("by_user_device", ["userId", "deviceId"]),

  // One row per event pushed to one install (req-notification-rules REQ-7).
  pushDeliveries: defineTable({
    eventId: v.id("events"),
    deviceId: v.string(),
  }).index("by_event_device", ["eventId", "deviceId"]),
};
