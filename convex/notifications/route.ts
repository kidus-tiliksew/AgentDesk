import { topicMatches } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type QueryCtx } from "../_generated/server";
import { type EventKind, NOTIFIABLE_KINDS } from "./events";
import { pushMessage } from "./messages";
import { deliverPush } from "./push";

// component-notifications §Emitting and routing: `route`, one mutation per
// event, scheduled by `emit`. It applies the owner's most specific matching
// rule, or the default action when no rule matches.

type Action = NonNullable<Doc<"events">["action"]>;

// req-notification-rules REQ-4. Webhook-only kinds have no default.
const DEFAULT_ACTIONS: Partial<Record<EventKind, Action>> = {
  "decision.created": "push",
  "agent.stale": "push",
  "decision.expired": "digest",
  "agent.done": "digest",
  "agent.status_changed": "mute",
};

// Only decision events carry a priority.
const PRIORITY_KINDS: readonly EventKind[] = ["decision.created", "decision.expired"];

// True when every match field the rule sets matches the event. An event
// field that is absent fails the rule's matcher for it (REQ-3, AC-3.1).
export function ruleMatches(rule: Doc<"rules">, event: Doc<"events">): boolean {
  if (
    rule.topic !== undefined &&
    (event.topic === undefined || !topicMatches(rule.topic, event.topic))
  ) {
    return false;
  }
  if (rule.agentSessionId !== undefined && rule.agentSessionId !== event.agentSessionId) {
    return false;
  }
  if (rule.eventKind !== undefined && rule.eventKind !== event.kind) {
    return false;
  }
  if (
    rule.priority !== undefined &&
    (!PRIORITY_KINDS.includes(event.kind) || rule.priority !== event.priority)
  ) {
    return false;
  }
  return true;
}

// The number of match fields the rule sets.
export function specificity(rule: Doc<"rules">): number {
  return [rule.topic, rule.agentSessionId, rule.eventKind, rule.priority].filter(
    (field) => field !== undefined,
  ).length;
}

// Ranks matching rules: most match fields first, then the latest `updatedAt`
// (AC-3.2), then the newest creation, then the lexically smallest id, so equal
// edit times still give one deterministic winner.
export function compareRules(a: Doc<"rules">, b: Doc<"rules">): number {
  const count = specificity(b) - specificity(a);
  if (count !== 0) {
    return count;
  }
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a._creationTime !== b._creationTime) {
    return b._creationTime - a._creationTime;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// Steps 1 and 2: the action of the owner's best matching rule, read now, or
// undefined when none matches.
async function ruleAction(
  ctx: Pick<QueryCtx, "db">,
  event: Doc<"events">,
): Promise<Action | undefined> {
  const rules = await ctx.db
    .query("rules")
    .withIndex("by_user", (q) => q.eq("userId", event.userId))
    .collect();
  const [best] = rules.filter((rule) => ruleMatches(rule, event)).sort(compareRules);
  return best?.action;
}

// Stores the action and delivers the event in one transaction. An event that
// already has an action was routed before, so a repeated run sends nothing
// more; a push that throws rolls back the stored action, leaving the event
// for a retry.
export const run = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("events", args.eventId);
    if (event === null || event.action !== undefined) {
      return null;
    }
    // Webhook-only kinds are never routed (REQ-2).
    if (!NOTIFIABLE_KINDS.includes(event.kind)) {
      return null;
    }
    // Steps 1 and 2 (REQ-3, REQ-4): the most specific matching rule, else the
    // default.
    const action = (await ruleAction(ctx, event)) ?? DEFAULT_ACTIONS[event.kind];
    if (action === undefined) {
      return null;
    }
    // Step 3 (REQ-5): Phase 4 changes push to digest here inside the owner's
    // quiet window, unless an urgent `decision.created` meets `urgentOverride`.
    await ctx.db.patch("events", event._id, { action });
    // Step 4. A digest event keeps no `digestId` until the digest dispatch
    // stamps it (§Digests). Mute sends nothing; the decision or agent still
    // shows in every inbox, which reads the domain tables (AC-1.2).
    if (action === "push") {
      const message = await pushMessage(ctx, event);
      if (message !== null) {
        await deliverPush(ctx, event._id, message);
      }
    }
    // Phase 5 (§Webhooks) enqueues this event's webhook deliveries here,
    // carrying the action.
    return null;
  },
});
