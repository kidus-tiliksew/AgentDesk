import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { finishIfComplete } from "./accountDeletion";
import { identity } from "./refs";

// component-identity §Account deletion: deleting the person's Clerk user
// through the Clerk Backend API, with the Convex variable `CLERK_SECRET_KEY`
// (component-repository §Configuration). It runs apart from the purge, so a
// Clerk failure never holds back the AgentDesk purge. Each attempt carries a
// number; an outcome for any attempt but the record's current one is
// ignored, so a late or duplicate attempt cannot move the retry schedule.

export const CLERK_API = "https://api.clerk.com/v1";
// Retry delays double from one minute up to one hour.
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

// What one attempt observed. `retryAfterMs` comes from a Retry-After header.
const outcomeValidator = v.union(
  v.object({ kind: v.literal("deleted") }),
  v.object({
    kind: v.literal("failed"),
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
  }),
);

// The Clerk user id for the attempt, or null when the attempt is stale or the
// Clerk user is already deleted.
export const clerkTarget = internalQuery({
  args: { deletionId: v.id("accountDeletions"), attempt: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { deletionId, attempt }) => {
    const record = await ctx.db.get("accountDeletions", deletionId);
    if (record === null || record.clerk.state !== "pending" || record.clerk.attempt !== attempt) {
      return null;
    }
    return record.clerkUserId;
  },
});

// Reads a Retry-After header in seconds or as an HTTP date.
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// One attempt. Success and a Clerk user that no longer exists both complete
// the step. A missing secret, a refused secret, a rate limit, a server error,
// and a network failure each record a short failure code and retry later; the
// response body and the secret are never stored or logged.
export const deleteClerkUser = internalAction({
  args: { deletionId: v.id("accountDeletions"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { deletionId, attempt }) => {
    const clerkUserId = await ctx.runQuery(identity.clerkDeletion.clerkTarget, {
      deletionId,
      attempt,
    });
    if (clerkUserId === null) {
      return null;
    }
    const secret = process.env.CLERK_SECRET_KEY;
    let outcome: { kind: "deleted" } | { kind: "failed"; error: string; retryAfterMs?: number };
    if (!secret) {
      outcome = { kind: "failed", error: "missing_secret" };
    } else {
      try {
        const response = await fetch(`${CLERK_API}/users/${encodeURIComponent(clerkUserId)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (response.ok || response.status === 404) {
          outcome = { kind: "deleted" };
        } else {
          const wait = retryAfterMs(response.headers.get("Retry-After"), Date.now());
          outcome = {
            kind: "failed",
            error: `http_${response.status}`,
            ...(wait === undefined ? {} : { retryAfterMs: wait }),
          };
        }
      } catch {
        outcome = { kind: "failed", error: "network" };
      }
    }
    await ctx.runMutation(identity.clerkDeletion.recordClerkOutcome, {
      deletionId,
      attempt,
      outcome,
    });
    return null;
  },
});

// Records an attempt's outcome. It leaves `updatedAt`, which tracks the
// purge, unchanged; recovery reads `nextAttemptAt` for the Clerk step. A failure schedules the next attempt after
// an exponential delay, or after Retry-After when Clerk asks for longer, and
// logs the failure code with the deletion id only.
export const recordClerkOutcome = internalMutation({
  args: { deletionId: v.id("accountDeletions"), attempt: v.number(), outcome: outcomeValidator },
  returns: v.null(),
  handler: async (ctx, { deletionId, attempt, outcome }) => {
    const record = await ctx.db.get("accountDeletions", deletionId);
    if (record === null || record.clerk.state !== "pending" || record.clerk.attempt !== attempt) {
      return null;
    }
    const now = Date.now();
    if (outcome.kind === "deleted") {
      const clerk = { state: "done" as const, attempt, nextAttemptAt: record.clerk.nextAttemptAt };
      const done = { ...record, clerk: { ...clerk, doneAt: now } };
      if (!(await finishIfComplete(ctx, done))) {
        await ctx.db.patch("accountDeletions", deletionId, { clerk: { ...clerk, doneAt: now } });
      }
      return null;
    }
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const delay = Math.max(backoff, outcome.retryAfterMs ?? 0);
    const next = attempt + 1;
    console.error(
      `Clerk user deletion for account deletion ${deletionId} failed (${outcome.error}),` +
        ` attempt ${attempt}; retrying in ${Math.round(delay / 1000)} s`,
    );
    await ctx.db.patch("accountDeletions", deletionId, {
      clerk: {
        state: "pending",
        attempt: next,
        nextAttemptAt: now + delay,
        lastError: outcome.error,
      },
    });
    await ctx.scheduler.runAfter(delay, identity.clerkDeletion.deleteClerkUser, {
      deletionId,
      attempt: next,
    });
    return null;
  },
});
