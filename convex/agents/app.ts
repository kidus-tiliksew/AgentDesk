import { type AgentSession, type Decision, errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
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
    const sessions = await ctx.db
      .query("agentSessions")
      .withIndex("by_user_ended", (q) => q.eq("userId", user._id).eq("endedAt", undefined))
      .collect();
    const live = sessions.filter((session) => session.activatedAt !== undefined).sort(byActivity);
    const result: AgentSession[] = [];
    for (const session of live) {
      result.push(toAgentSession(session, await pendingCountForAgent(ctx, session._id)));
    }
    return result;
  },
});

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
