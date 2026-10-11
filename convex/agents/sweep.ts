import { internalMutation } from "../_generated/server";
import { agentEvent, emit } from "../notifications/events";
import { staleThresholdMs } from "./settings";

// component-agent-presence §Sweep. Runs every minute from convex/crons.ts.

// Five minutes is the smallest allowed stale threshold (req-agent-status
// AC-3.1), so no session silent for less can need a change.
const MIN_SILENCE_MS = 5 * 60_000;
// A session silent this long leaves the live set (REQ-4).
const IDLE_MS = 24 * 60 * 60_000;

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
      if (
        session.activatedAt !== undefined &&
        session.state !== "done" &&
        session.staleSince === undefined &&
        silence >= (await staleThresholdMs(ctx, session.userId))
      ) {
        await ctx.db.patch("agentSessions", session._id, { staleSince: now });
        await emit(ctx, agentEvent("agent.stale", session, now));
      }
    }
  },
});
