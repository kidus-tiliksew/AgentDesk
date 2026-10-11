import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { notifications } from "./refs";

// component-notifications §Emitting and routing: the one entry point through
// which component-decisions and component-agent-presence record events.

export type EventKind = Doc<"events">["kind"];

// What an emitter supplies. `action` and `digestId` belong to routing.
export type EmittedEvent = Omit<Doc<"events">, "_id" | "_creationTime" | "action" | "digestId">;

// req-notification-rules REQ-2.
export const NOTIFIABLE_KINDS: readonly EventKind[] = [
  "decision.created",
  "decision.expired",
  "agent.stale",
  "agent.status_changed",
  "agent.done",
];

// Inserts the event in the emitter's transaction, so an emitter that throws
// or rolls back leaves no event and no scheduled route. A notifiable event is
// routed immediately; `decision.answered` and `decision.cancelled` are stored
// with `action: null` and never routed.
export async function emit(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  event: EmittedEvent,
): Promise<Id<"events">> {
  if (NOTIFIABLE_KINDS.includes(event.kind)) {
    const eventId = await ctx.db.insert("events", event);
    await ctx.scheduler.runAfter(0, notifications.route.run, { eventId });
    return eventId;
  }
  const eventId = await ctx.db.insert("events", { ...event, action: null });
  // Phase 5 (§Webhooks) enqueues this event's webhook deliveries here, with
  // `action: null`.
  return eventId;
}

// A decision event, taking topic and priority from the decision.
export function decisionEvent(
  kind: "decision.created" | "decision.answered" | "decision.cancelled" | "decision.expired",
  decision: Pick<Doc<"decisions">, "_id" | "userId" | "agentSessionId" | "topic" | "priority">,
  occurredAt: number,
): EmittedEvent {
  return {
    userId: decision.userId,
    kind,
    topic: decision.topic,
    decisionId: decision._id,
    agentSessionId: decision.agentSessionId,
    priority: decision.priority,
    occurredAt,
  };
}

// An agent event, taking the topic from the session.
export function agentEvent(
  kind: "agent.stale" | "agent.status_changed" | "agent.done",
  session: Pick<Doc<"agentSessions">, "_id" | "userId" | "topic">,
  occurredAt: number,
): EmittedEvent {
  return {
    userId: session.userId,
    kind,
    topic: session.topic,
    agentSessionId: session._id,
    occurredAt,
  };
}
