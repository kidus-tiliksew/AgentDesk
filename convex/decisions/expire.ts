import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { expireDecision } from "./model";

// component-decisions §State machine: the deadline expiry job that `create`
// schedules with `ctx.scheduler.runAt(deadline, ...)`. It re-reads the row,
// so a decision answered or cancelled first is refused and keeps its
// settlement (req-decision-requests AC-5.4), and a run before the stored
// deadline changes nothing.
export const run = internalMutation({
  args: { decisionId: v.id("decisions") },
  handler: async (ctx, { decisionId }): Promise<void> => {
    const doc = await ctx.db.get("decisions", decisionId);
    if (doc === null) {
      return;
    }
    // An owner being deleted gets no expiry and no event; the account purge
    // deletes the decision (§Account deletion).
    const owner = await ctx.db.get("users", doc.userId);
    if (owner === null || owner.deletingAt !== undefined) {
      return;
    }
    await expireDecision(ctx, doc, Date.now());
  },
});
