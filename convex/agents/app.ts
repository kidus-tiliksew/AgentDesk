import { type AgentSession, type Decision, errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx, query } from "../_generated/server";
import { pendingForAgent } from "../decisions/appReads";
import { pendingCountForAgent } from "../decisions/counts";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { toAgentSession } from "./sessions";

// component-agent-presence §Reads: the app's functions. The app calls Convex
// as the signed-in person (DEC-3, DEC-7), so each function resolves the
// account with requireUser and takes no user id from the client. Nothing here
// accepts a message from the user to an agent (req-agent-status REQ-5).

type ReaderCtx = Pick<QueryCtx, "db">;

// The detail view reads at most this many history rows (req-agent-status
// AC-1.2).
const HISTORY_LIMIT = 20;

// A previous status of a session. The contract has no history read shape, so
// this module defines it in the contract's style: `link` is null when absent
// and `at` is an ISO 8601 string.
export type StatusHistoryEntry = {
  state: Doc<"statusHistory">["state"];
  line: string;
  link: string | null;
  at: string;
};

// The agent screen: the session's card, its history newest first, and its
// pending decisions in inbox order.
export type AgentSessionDetail = AgentSession & {
  history: StatusHistoryEntry[];
  pending_decisions: Decision[];
};

function notFound(): never {
  throw appError(errorCodeSchema.enum.not_found, "Agent session not found");
}

// Most recent activity first; creation time, newest first, and then the id
// break ties, so the order is total.
function byActivity(a: Doc<"agentSessions">, b: Doc<"agentSessions">): number {
  if (a.lastActivityAt !== b.lastActivityAt) {
    return b.lastActivityAt - a.lastActivityAt;
  }
  if (a._creationTime !== b._creationTime) {
    return b._creationTime - a._creationTime;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// The agent cards: the user's activated sessions with no `endedAt`, each with
// its pending decision count and stale flag (req-mobile-app AC-2.2;
// req-agent-status AC-2.3). A session that was only initialized has no card
// (REQ-2).
export const liveAgents = query({
  args: {},
  handler: async (ctx): Promise<AgentSession[]> => {
    const user = await requireUser(ctx);
    return await withPendingCounts(ctx, await liveSessionsFor(ctx, user._id));
  },
});

// The user's activated sessions with no `endedAt`, in `liveAgents` order. The
// public API's agent list reads the same set (component-agent-presence
// §Service routes).
export async function liveSessionsFor(
  ctx: ReaderCtx,
  userId: Id<"users">,
): Promise<Doc<"agentSessions">[]> {
  const sessions = await ctx.db
    .query("agentSessions")
    .withIndex("by_user_ended", (q) => q.eq("userId", userId).eq("endedAt", undefined))
    .collect();
  return sessions.filter((session) => session.activatedAt !== undefined).sort(byActivity);
}

// Each session's `AgentSession` with its pending decision count, in order.
export async function withPendingCounts(
  ctx: ReaderCtx,
  sessions: Doc<"agentSessions">[],
): Promise<AgentSession[]> {
  const result: AgentSession[] = [];
  for (const session of sessions) {
    result.push(toAgentSession(session, await pendingCountForAgent(ctx, session._id)));
  }
  return result;
}

// The window of recent agents: an elapsed seven days, the time the purge
// keeps an ended session (component-agent-presence §Sweep).
const RECENT_MS = 7 * 24 * 60 * 60_000;

// Latest end first; creation time, newest first, and then the id break ties,
// so the order is total.
function byEnd(a: Doc<"agentSessions">, b: Doc<"agentSessions">): number {
  const aEnd = a.endedAt ?? 0;
  const bEnd = b.endedAt ?? 0;
  if (aEnd !== bEnd) {
    return bEnd - aEnd;
  }
  if (a._creationTime !== b._creationTime) {
    return b._creationTime - a._creationTime;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// The recent agents the rule editor offers beside liveAgents: the user's
// activated sessions whose `endedAt` lies in [now - 7 days, now], ended
// through `done` or `idle`, latest end first, each with its real pending
// decision count (component-mobile-app §Screens).
export const recentAgents = query({
  args: {},
  handler: async (ctx): Promise<AgentSession[]> => {
    const user = await requireUser(ctx);
    return await withPendingCounts(ctx, await recentSessionsFor(ctx, user._id, Date.now()));
  },
});

// The user's activated sessions ended in [now - 7 days, now], in
// `recentAgents` order. The public API's agent list reads the same set.
export async function recentSessionsFor(
  ctx: ReaderCtx,
  userId: Id<"users">,
  now: number,
): Promise<Doc<"agentSessions">[]> {
  const sessions = await ctx.db
    .query("agentSessions")
    .withIndex("by_user_ended", (q) =>
      q
        .eq("userId", userId)
        .gte("endedAt", now - RECENT_MS)
        .lte("endedAt", now),
    )
    .collect();
  return sessions.filter((session) => session.activatedAt !== undefined).sort(byEnd);
}

// The agent screen: one owned activated session, live or ended. A missing, a
// foreign, and an only-initialized session are all `not_found`; the last has
// no topic, so it has no valid card (req-agent-status REQ-2;
// req-accounts-and-connections AC-1.1).
export const get = query({
  args: { agentSessionId: v.string() },
  handler: async (ctx, args): Promise<AgentSessionDetail> => {
    const user = await requireUser(ctx);
    const agentSessionId = ctx.db.normalizeId("agentSessions", args.agentSessionId);
    if (agentSessionId === null) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid agentSessionId", "agentSessionId");
    }
    const session = await getOwned(ctx, "agentSessions", agentSessionId, user._id);
    if (session === null || session.activatedAt === undefined) {
      notFound();
    }
    // `by_session_at` orders equal times by creation, so descending order is
    // newest first throughout.
    const rows = await ctx.db
      .query("statusHistory")
      .withIndex("by_session_at", (q) => q.eq("agentSessionId", agentSessionId))
      .order("desc")
      .take(HISTORY_LIMIT);
    return {
      ...toAgentSession(session, await pendingCountForAgent(ctx, agentSessionId)),
      history: rows.map((row) => ({
        state: row.state,
        line: row.line,
        link: row.link ?? null,
        at: new Date(row.at).toISOString(),
      })),
      pending_decisions: await pendingForAgent(ctx, user._id, agentSessionId),
    };
  },
});
