import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { EventKind } from "./events";
import { pushMessage } from "./messages";
import { deliverPush } from "./push";

// component-notifications §Emitting and routing: `route`, one mutation per
// event, scheduled by `emit`. This slice applies the default actions only.

type Action = NonNullable<Doc<"events">["action"]>;

// req-notification-rules REQ-4. Webhook-only kinds have no default.
const DEFAULT_ACTIONS: Partial<Record<EventKind, Action>> = {
  "decision.created": "push",
  "agent.stale": "push",
  "decision.expired": "digest",
  "agent.done": "digest",
  "agent.status_changed": "mute",
};

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
    // Steps 1 and 2 (REQ-3, AC-3.1, AC-3.2): Phase 4 collects the owner's
    // matching rules here and picks the most specific, using the default
    // below only when no rule matches.
    const action = DEFAULT_ACTIONS[event.kind];
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
