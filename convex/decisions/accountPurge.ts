import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { PurgeStep } from "../identity/accountDeletion";

// component-decisions §Account deletion: this domain's part of the account
// purge that `identity/accountDeletion:purgeBatch` drives
// (req-accounts-and-connections AC-5.1). Each call deletes at most `budget`
// of the account's decisions, in every state, and reports whether none
// remain. It reads only the rows it deletes, so a repeated or resumed call
// continues from the rows still stored.
export async function purgeDecisions(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  userId: Id<"users">,
  budget: number,
): Promise<PurgeStep> {
  const rows = await ctx.db
    .query("decisions")
    .withIndex("by_user_state", (q) => q.eq("userId", userId))
    .take(budget);
  for (const doc of rows) {
    // A pending decision's expiry job is cancelled first, with the same
    // scheduler-state check `remove` uses, so a job that already finished
    // never makes the purge fail. A job that runs anyway finds no row.
    if (doc.expiryJobId !== undefined) {
      const job = await ctx.db.system.get(doc.expiryJobId);
      if (job !== null && (job.state.kind === "pending" || job.state.kind === "inProgress")) {
        await ctx.scheduler.cancel(doc.expiryJobId);
      }
    }
    await ctx.db.delete("decisions", doc._id);
  }
  return { deleted: rows.length, done: rows.length < budget };
}
