import type { Id } from "../_generated/dataModel";
import { internalMutation, type QueryCtx } from "../_generated/server";
import { agentEvent, emit } from "../notifications/events";
import { staleThresholdMs } from "./settings";

// component-agent-presence §Sweep. Runs every minute from convex/crons.ts.

// Five minutes is the smallest allowed stale threshold (req-agent-status
// AC-3.1), so no session silent for less can need a change.
const MIN_SILENCE_MS = 5 * 60_000;
// A session silent this long leaves the live set (REQ-4).
const IDLE_MS = 24 * 60 * 60_000;

async function ownerActive(ctx: Pick<QueryCtx, "db">, userId: Id<"users">): Promise<boolean> {
  const owner = await ctx.db.get("users", userId);
  return owner !== null && owner.deletingAt === undefined;
}

export const run = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();
    const candidates = await ctx.db
      .query("agentSessions")
      .withIndex("by_activity", (q) => q.lte("lastActivityAt", now - MIN_SILENCE_MS))
      .filter((q) => q.eq(q.field("endedAt"), undefined))
      .collect();

    for (const session of candidates) {
      const silence = now - session.lastActivityAt;
      if (silence >= IDLE_MS) {
        await ctx.db.patch("agentSessions", session._id, { endedAt: now, endReason: "idle" });
        continue;
      }
      // REQ-3: only an activated session that is not done and not already
      // marked goes stale, so each silence is marked once (AC-3.2).
      // An owner being deleted gets no stale event: the account purge
      // deletes the session, and an event would outlive the purge's pass
      // over events (§Account deletion).
      if (
        session.activatedAt !== undefined &&
        session.state !== "done" &&
        session.staleSince === undefined &&
        (await ownerActive(ctx, session.userId)) &&
        silence >= (await staleThresholdMs(ctx, session.userId))
      ) {
        await ctx.db.patch("agentSessions", session._id, { staleSince: now });
        await emit(ctx, agentEvent("agent.stale", session, now));
      }
    }
  },
});
