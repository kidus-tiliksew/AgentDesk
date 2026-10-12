import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { staleThresholdMinutes } from "../notifications/settings";

// Returns the user's stale threshold in milliseconds for the sweep
// (component-agent-presence §Sweep). component-notifications owns
// `staleThresholdMinutes` on its `settings` table; a user with no row gets
// the 30-minute default (req-agent-status AC-3.1).
export async function staleThresholdMs(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
): Promise<number> {
  return (await staleThresholdMinutes(ctx, userId)) * 60_000;
}
