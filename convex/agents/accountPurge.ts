import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { PurgeStep } from "../identity/accountDeletion";

// component-agent-presence §Account deletion: this domain's part of the
// account purge that `identity/accountDeletion:purgeBatch` drives
// (req-accounts-and-connections AC-5.1). Each call deletes at most `budget`
// rows: a session's status history first, then the session, so the history
// stays reachable through its session until it is gone. A session whose
// history the budget cuts off stays stored, and the next call continues with
// it. Unactivated, live, and ended sessions are all deleted.
export async function purgeAgentSessions(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  budget: number,
): Promise<PurgeStep> {
  let deleted = 0;
  while (deleted < budget) {
    const session = await ctx.db
      .query("agentSessions")
      .withIndex("by_user_ended", (q) => q.eq("userId", userId))
      .first();
    if (session === null) {
      return { deleted, done: true };
    }
    const history = await ctx.db
      .query("statusHistory")
      .withIndex("by_session_at", (q) => q.eq("agentSessionId", session._id))
      .take(budget - deleted);
    for (const row of history) {
      await ctx.db.delete("statusHistory", row._id);
    }
    deleted += history.length;
    if (deleted >= budget) {
      break;
    }
    await ctx.db.delete("agentSessions", session._id);
    deleted++;
  }
  return { deleted, done: false };
}
