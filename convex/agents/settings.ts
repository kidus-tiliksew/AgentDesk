import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// The stale threshold when the user has not set one (req-agent-status AC-3.1).
const DEFAULT_STALE_THRESHOLD_MINUTES = 30;

// Returns the user's stale threshold in milliseconds for the sweep
// (component-agent-presence §Sweep).
//
// Phase 2 seam: component-notifications owns `staleThresholdMinutes` on its
// `settings` table, which does not exist yet. When that table lands, this
// function reads the user's row and falls back to the default below; the
// sweep's call site does not change.
export async function staleThresholdMs(
  _ctx: Pick<QueryCtx, "db">,
  _userId: Id<"users">,
): Promise<number> {
  return DEFAULT_STALE_THRESHOLD_MINUTES * 60_000;
}
