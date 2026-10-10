import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// component-decisions §Reads: the pending decision count on an agent card
// (component-agent-presence §Reads). It imports no other module of this domain, so
// convex/agents/sessions.ts can import it while this domain imports `touch`
// from there without a runtime cycle.
export async function pendingCountForAgent(
  ctx: Pick<QueryCtx, "db">,
  agentSessionId: Id<"agentSessions">,
): Promise<number> {
  const pending = await ctx.db
    .query("decisions")
    .withIndex("by_agent_state", (q) =>
      q.eq("agentSessionId", agentSessionId).eq("state", "pending"),
    )
    .collect();
  return pending.length;
}
