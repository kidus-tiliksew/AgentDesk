import { type Answer, errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx, query } from "../_generated/server";
import { comparePending } from "../decisions/appReads";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import type { EventKind } from "./events";
import { agentName } from "./messages";

// component-notifications §Digests: the app's read of one digest for the
// `digest/[id]` screen (req-mobile-app REQ-4; req-notification-rules AC-6.3).
// The app calls Convex as the signed-in person (DEC-3, DEC-7), so the query
// resolves the account with requireUser before reading any row and takes no
// user id. The contract has no digest read shape, so this module defines one
// in the contract's style: absent values are null and instants are ISO 8601
// strings.

type ReaderCtx = Pick<QueryCtx, "db">;

// One event the digest holds.
export type DigestEvent = {
  id: string;
  kind: EventKind;
  topic: string | null;
  occurred_at: string;
  // The action `route` stored; `digest` for every event a digest holds.
  action: "push" | "digest" | "mute" | null;
  decision_id: string | null;
  agent_session_id: string | null;
  // The decision's current title, or null when the event names no decision or
  // the decision no longer exists.
  decision_title: string | null;
  // The card name, "Ended agent" when the session no longer exists, or null
  // when the event names no session.
  agent_name: string | null;
};

// One decision that was pending when the digest was sent, in its current
// state.
export type DigestDecision = {
  id: string;
  topic: string;
  title: string;
  priority: "normal" | "urgent";
  deadline: string | null;
  state: Doc<"decisions">["state"];
  answer: Answer | null;
  answered_at: string | null;
  applied_by_default: boolean;
  agent_session_id: string;
  agent_name: string;
  created_at: string;
};

export type Digest = {
  id: string;
  sent_at: string;
  // Oldest first, then by id.
  events: DigestEvent[];
  // In inbox order (component-decisions §Reads, `listPending`). A decision
  // removed since the digest was sent is left out (component-decisions
  // §Removal).
  pending_decisions: DigestDecision[];
};

function instant(at: number | undefined): string | null {
  return at === undefined ? null : new Date(at).toISOString();
}

function notFound(): never {
  throw appError(errorCodeSchema.enum.not_found, "Digest not found");
}

async function sessionName(
  ctx: ReaderCtx,
  agentSessionId: Id<"agentSessions">,
  userId: Id<"users">,
): Promise<string> {
  return agentName(await getOwned(ctx, "agentSessions", agentSessionId, userId));
}

async function toDigestEvent(ctx: ReaderCtx, event: Doc<"events">): Promise<DigestEvent> {
  const decision =
    event.decisionId === undefined
      ? null
      : await getOwned(ctx, "decisions", event.decisionId, event.userId);
  return {
    id: event._id,
    kind: event.kind,
    topic: event.topic ?? null,
    occurred_at: new Date(event.occurredAt).toISOString(),
    action: event.action ?? null,
    decision_id: event.decisionId ?? null,
    agent_session_id: event.agentSessionId ?? null,
    decision_title: decision?.title ?? null,
    agent_name:
      event.agentSessionId === undefined
        ? null
        : await sessionName(ctx, event.agentSessionId, event.userId),
  };
}

async function toDigestDecision(
  ctx: ReaderCtx,
  decision: Doc<"decisions">,
): Promise<DigestDecision> {
  return {
    id: decision._id,
    topic: decision.topic,
    title: decision.title,
    priority: decision.priority,
    deadline: instant(decision.deadline),
    state: decision.state,
    answer: decision.answer ?? null,
    answered_at: instant(decision.answeredAt),
    applied_by_default: decision.appliedByDefault ?? false,
    agent_session_id: decision.agentSessionId,
    agent_name: await sessionName(ctx, decision.agentSessionId, decision.userId),
    created_at: new Date(decision._creationTime).toISOString(),
  };
}

function compareEvents(a: Doc<"events">, b: Doc<"events">): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt - b.occurredAt;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// One owned digest. A malformed `digestId` is `invalid` naming it; a missing
// digest and another account's digest are both `not_found`
// (req-accounts-and-connections AC-1.1). Every related row is read within the
// digest owner's account, and a missing one is left out rather than failing
// the read.
export const get = query({
  args: { digestId: v.string() },
  handler: async (ctx, args): Promise<Digest> => {
    const user = await requireUser(ctx);
    const digestId = ctx.db.normalizeId("digests", args.digestId);
    if (digestId === null) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid digestId", "digestId");
    }
    const digest = await getOwned(ctx, "digests", digestId, user._id);
    if (digest === null) {
      notFound();
    }

    const events: Doc<"events">[] = [];
    for (const eventId of digest.eventIds) {
      const event = await getOwned(ctx, "events", eventId, user._id);
      if (event !== null) {
        events.push(event);
      }
    }
    const decisions: Doc<"decisions">[] = [];
    for (const decisionId of digest.pendingDecisionIds) {
      const decision = await getOwned(ctx, "decisions", decisionId, user._id);
      if (decision !== null) {
        decisions.push(decision);
      }
    }

    const result: Digest = {
      id: digest._id,
      sent_at: new Date(digest.sentAt).toISOString(),
      events: [],
      pending_decisions: [],
    };
    for (const event of events.sort(compareEvents)) {
      result.events.push(await toDigestEvent(ctx, event));
    }
    for (const decision of decisions.sort(comparePending)) {
      result.pending_decisions.push(await toDigestDecision(ctx, decision));
    }
    return result;
  },
});
