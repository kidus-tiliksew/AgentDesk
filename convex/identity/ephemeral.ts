import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { endForConnection } from "../agents/sessions";
import { cancelForAgentSession } from "../decisions/model";
import { identity } from "./refs";

// component-identity §Ending a connection (req-install-keys REQ-4; DEC-21
// (4)). A connection made with an ephemeral install key ends when its machine
// goes quiet, or when the person or its own uninstall revokes it. Ending it
// revokes the credential, ends its agent sessions, and cancels their pending
// decisions, all in the caller's transaction. A connection made by short code
// or with a key that is not ephemeral keeps `revokeCredential` alone.

// The most connections one sweep run ends. A full batch schedules the next
// run at once, so a backlog clears well within the 5 minutes AC-4.1 allows.
export const SWEEP_BATCH = 100;

// True when the credential is a connection of an ephemeral install key.
export async function isEphemeralConnection(
  ctx: Pick<QueryCtx, "db">,
  credential: Doc<"credentials">,
): Promise<boolean> {
  if (credential.installKeyId === undefined) {
    return false;
  }
  const key = await ctx.db.get("installKeys", credential.installKeyId);
  return key?.ephemeral === true;
}

// Revokes the credential, unless it is already revoked, and clears its idle
// deadline, so the sweep's index no longer holds it. Then ends every session
// the connection opened and cancels each one's pending decisions with reason
// `connection_ended` (AC-4.2). A second call changes nothing.
export async function endEphemeralConnection(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  credential: Doc<"credentials">,
  now: number,
): Promise<void> {
  await ctx.db.patch("credentials", credential._id, {
    revokedAt: credential.revokedAt ?? now,
    idleDeadlineAt: undefined,
  });
  const sessions: Id<"agentSessions">[] = await endForConnection(
    ctx,
    credential.userId,
    credential._id,
    now,
  );
  for (const agentSessionId of sessions) {
    await cancelForAgentSession(ctx, credential.userId, agentSessionId, "connection_ended", now);
  }
}

// The minute sweep from convex/crons.ts (AC-4.1). It reads up to SWEEP_BATCH
// credentials whose idle deadline is at or before now, in deadline order, and
// ends each live one. A revoked credential still holding a deadline, such as
// one account deletion revoked, only has the deadline cleared, so no row
// stays in the index to hold back later runs. A full batch schedules the next
// run at once. Returns the number of connections it ended.
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    const due = await ctx.db
      .query("credentials")
      .withIndex("by_idle_deadline", (q) => q.gt("idleDeadlineAt", 0).lte("idleDeadlineAt", now))
      .take(SWEEP_BATCH);
    let ended = 0;
    for (const credential of due) {
      if (credential.revokedAt === undefined) {
        await endEphemeralConnection(ctx, credential, now);
        ended++;
      } else {
        await ctx.db.patch("credentials", credential._id, { idleDeadlineAt: undefined });
      }
    }
    if (due.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, identity.ephemeral.sweep, {});
    }
    return ended;
  },
});
