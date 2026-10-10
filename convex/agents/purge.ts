import { internalMutation } from "../_generated/server";

// component-agent-presence §Sweep: the daily purge of ended sessions. Runs
// at 03:00 UTC from convex/crons.ts.

// An ended session stays in the recent list this long (req-agent-status AC-4.1).
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export const run = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();
    // No index covers `endedAt` alone, so the daily run scans the table and
    // keeps rows whose end is within retention. Decisions keep their
    // `agentSessionId`; nothing here touches them (AC-4.2).
    const ended = await ctx.db
      .query("agentSessions")
      .filter((q) =>
        q.and(q.neq(q.field("endedAt"), undefined), q.lt(q.field("endedAt"), now - RETENTION_MS)),
      )
      .collect();

    for (const session of ended) {
      const history = await ctx.db
        .query("statusHistory")
        .withIndex("by_session_at", (q) => q.eq("agentSessionId", session._id))
        .collect();
      for (const row of history) {
        await ctx.db.delete("statusHistory", row._id);
      }
      await ctx.db.delete("agentSessions", session._id);
    }
  },
});
