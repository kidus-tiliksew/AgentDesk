import type { StatusHistoryEntry } from "@agentdesk/contract";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// component-agent-presence §Reads: the one history read behind `agents/app:get`
// and `agents/api:history`. It checks no ownership, so each caller checks the
// session first. A read caps its rows itself: `status` trims storage to the
// same 20 (req-agent-status AC-1.2).
const HISTORY_LIMIT = 20;

// The session's previous statuses, newest first. `by_session_at` orders equal
// times by creation, so descending order is newest first throughout.
export async function statusHistoryFor(
  ctx: Pick<QueryCtx, "db">,
  agentSessionId: Id<"agentSessions">,
): Promise<StatusHistoryEntry[]> {
  const rows = await ctx.db
    .query("statusHistory")
    .withIndex("by_session_at", (q) => q.eq("agentSessionId", agentSessionId))
    .order("desc")
    .take(HISTORY_LIMIT);
  return rows.map((row) => ({
    state: row.state,
    line: row.line,
    link: row.link ?? null,
    at: new Date(row.at).toISOString(),
  }));
}
