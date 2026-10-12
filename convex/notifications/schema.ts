import { defineTable } from "convex/server";
import { v } from "convex/values";

// The notifications domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition; component-notifications §Tables).
// Digest and webhook tables arrive with the later slices that use them.

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

// What a rule may match and route: the five notifiable kinds
// (req-notification-rules REQ-2) and a non-null action (REQ-1). The save
// handler checks client strings against these lists so a bad value is an
// `invalid` application error rather than a transport validation error.
export const RULE_EVENT_KINDS = [
  "decision.created",
  "decision.expired",
  "agent.stale",
  "agent.status_changed",
  "agent.done",
] as const;
export const RULE_ACTIONS = ["push", "digest", "mute"] as const;
export const PRIORITIES = ["normal", "urgent"] as const;

export const ruleEventKindValidator = v.union(
  v.literal("decision.created"),
  v.literal("decision.expired"),
  v.literal("agent.stale"),
  v.literal("agent.status_changed"),
  v.literal("agent.done"),
);
export const ruleActionValidator = v.union(
  v.literal("push"),
  v.literal("digest"),
  v.literal("mute"),
);
export const priorityValidator = v.union(v.literal("normal"), v.literal("urgent"));

export const platformValidator = v.union(v.literal("ios"), v.literal("android"));

// Who set `settings.timeZone`: `default` is the UTC fallback nobody chose,
// `device` the zone the app supplied at first launch, and `user` a zone chosen
// in settings.
export const timeZoneSourceValidator = v.union(
  v.literal("default"),
  v.literal("device"),
  v.literal("user"),
);

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
    priority: v.optional(priorityValidator),
    // Epoch milliseconds.
    occurredAt: v.number(),
    action: v.optional(actionValidator),
    digestId: v.optional(v.string()),
  }),

  // One row per notification rule (req-notification-rules REQ-3). At least
  // one of the four match fields is set; `save` refuses a rule with none
  // (AC-3.3). `topic` is stored normalized. `updatedAt` is the epoch
  // milliseconds of the latest save and ranks equally specific matches
  // (AC-3.2).
  rules: defineTable({
    userId: v.id("users"),
    topic: v.optional(v.string()),
    agentSessionId: v.optional(v.id("agentSessions")),
    eventKind: v.optional(ruleEventKindValidator),
    priority: v.optional(priorityValidator),
    action: ruleActionValidator,
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // One row per person (req-mobile-app REQ-5), kept unique by ensureSettings
  // in convex/notifications/settings.ts. `quietStart` and `quietEnd` are local
  // `HH:MM` times, both set or both absent. `digestTime` is a local `HH:MM`.
  // `nextDigestAt` is the epoch milliseconds of the next digest
  // (req-notification-rules REQ-6).
  settings: defineTable({
    userId: v.id("users"),
    timeZone: v.string(),
    timeZoneSource: timeZoneSourceValidator,
    quietStart: v.optional(v.string()),
    quietEnd: v.optional(v.string()),
    urgentOverride: v.boolean(),
    digestTime: v.string(),
    staleThresholdMinutes: v.number(),
    nextDigestAt: v.number(),
  }).index("by_user", ["userId"]),

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
