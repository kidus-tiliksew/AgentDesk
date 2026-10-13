import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, mutation } from "../_generated/server";
import { purgeAgentSessions } from "../agents/accountPurge";
import { purgeDecisions } from "../decisions/accountPurge";
import { appError } from "../lib/errors";
import { purgeNotifications } from "../notifications/accountPurge";
import { removeAllDevices } from "../notifications/devices";
import { identity } from "./refs";
import { findDeletion, findUser } from "./users";

// component-identity §Account deletion (req-accounts-and-connections REQ-5,
// AC-5.1). `deleteAccount` stops the account at once: it sets `deletingAt`,
// revokes every credential, and removes every device with its queued pushes
// in one transaction. It then starts two independent chains of scheduled
// work: the purge, which deletes the account's rows domain by domain in
// bounded batches and deletes the `users` row last, and the Clerk user's
// deletion (`./clerkDeletion`). Identity drives the purge; each domain's own
// module deletes that domain's tables.

// What one domain's purge call did: how many rows it deleted, and whether the
// domain holds no more rows for the account.
export type PurgeStep = { deleted: number; done: boolean };

// The purge finishes within this long of `deletingAt` (AC-5.1).
export const DELETION_WINDOW_MS = 24 * 60 * 60_000;
// The most rows one purge batch deletes, which keeps each batch well inside
// Convex's per-transaction limits.
export const PURGE_BATCH = 200;
// A deletion whose purge or Clerk deletion has made no progress for this long
// is restarted by the hourly `resumePurges`.
export const STALL_MS = 10 * 60_000;
// The most deletions one `resumePurges` run restarts; a full page schedules
// another run for the rest.
export const RESUME_PAGE = 50;
// The first Clerk attempt waits this long, so the app's sign-out of the
// deleting session finishes before Clerk deletes the user.
export const CLERK_FIRST_DELAY_MS = 60_000;

type Phase = Doc<"accountDeletions">["phase"];

const PHASES: readonly Phase[] = ["decisions", "agents", "notifications", "identity", "verify"];

// Identity's own rows: credentials, the short-code sign-in requests the
// account approved, and its wrong-code attempts. Requests the account never
// approved carry no `userId` and stay.
async function purgeIdentity(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  budget: number,
): Promise<PurgeStep> {
  let deleted = 0;
  const credentials = await ctx.db
    .query("credentials")
    .withIndex("by_user_kind", (q) => q.eq("userId", userId))
    .take(budget);
  for (const row of credentials) {
    await ctx.db.delete("credentials", row._id);
  }
  deleted += credentials.length;
  if (deleted < budget) {
    const requests = await ctx.db
      .query("deviceRequests")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(budget - deleted);
    for (const row of requests) {
      await ctx.db.delete("deviceRequests", row._id);
    }
    deleted += requests.length;
  }
  if (deleted < budget) {
    const attempts = await ctx.db
      .query("codeAttempts")
      .withIndex("by_user_at", (q) => q.eq("userId", userId))
      .take(budget - deleted);
    for (const row of attempts) {
      await ctx.db.delete("codeAttempts", row._id);
    }
    deleted += attempts.length;
  }
  return { deleted, done: deleted < budget };
}

const DOMAINS: Record<
  Exclude<Phase, "verify">,
  (ctx: MutationCtx, userId: Id<"users">, budget: number) => Promise<PurgeStep>
> = {
  decisions: purgeDecisions,
  agents: purgeAgentSessions,
  notifications: purgeNotifications,
  identity: purgeIdentity,
};

// `verify` runs every domain again. It is done only when no domain deleted
// anything, so a row a racing writer added after its domain's phase is
// found before the `users` row goes.
async function runPhase(
  ctx: MutationCtx,
  phase: Phase,
  userId: Id<"users">,
  budget: number,
): Promise<PurgeStep> {
  if (phase !== "verify") {
    return await DOMAINS[phase](ctx, userId, budget);
  }
  let deleted = 0;
  for (const purge of Object.values(DOMAINS)) {
    if (deleted >= budget) {
      return { deleted, done: false };
    }
    const step = await purge(ctx, userId, budget - deleted);
    deleted += step.deleted;
    if (!step.done) {
      return { deleted, done: false };
    }
  }
  return { deleted, done: deleted === 0 };
}

// What deleteAccount returns: when deletion started and when the purge will
// have finished.
const resultValidator = v.object({ deletingAt: v.number(), completeBy: v.number() });

function result(startedAt: number) {
  return { deletingAt: startedAt, completeBy: startedAt + DELETION_WINDOW_MS };
}

// Deletes the signed-in person's account. The Clerk identity alone selects
// the account; the call takes no arguments. The first call sets `deletingAt`,
// marks every credential revoked, removes every device and cancels its
// queued pushes, records the deletion, and schedules the purge's first batch
// and the Clerk deletion, all in one transaction, so a failure leaves the
// account active with nothing revoked. From that commit on, every credential
// resolution, device registration, and app call for the account is refused
// (§Credentials, §Accounts). A later call, including one after the purge has
// deleted the `users` row, returns the first call's times and does nothing.
// A caller without an identity or without an account is `unauthenticated`.
export const deleteAccount = mutation({
  args: {},
  returns: resultValidator,
  handler: async (ctx) => {
    const signedIn = await ctx.auth.getUserIdentity();
    if (signedIn === null) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Not signed in");
    }
    const running = await findDeletion(ctx, signedIn.subject);
    if (running !== null) {
      return result(running.startedAt);
    }
    const user = await findUser(ctx, signedIn.subject);
    if (user === null) {
      throw appError(errorCodeSchema.enum.unauthenticated, "No account");
    }
    const now = Date.now();
    const startedAt = user.deletingAt ?? now;
    if (user.deletingAt === undefined) {
      await ctx.db.patch("users", user._id, { deletingAt: startedAt });
    }

    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_user_kind", (q) => q.eq("userId", user._id))
      .collect();
    for (const credential of credentials) {
      if (credential.revokedAt === undefined) {
        await ctx.db.patch("credentials", credential._id, { revokedAt: now });
      }
    }
    await removeAllDevices(ctx, user._id);

    const deletionId = await ctx.db.insert("accountDeletions", {
      userId: user._id,
      clerkUserId: user.clerkUserId,
      startedAt,
      phase: PHASES[0] ?? "verify",
      generation: 1,
      updatedAt: now,
      restarts: 0,
      clerk: { state: "pending", attempt: 1, nextAttemptAt: now + CLERK_FIRST_DELAY_MS },
    });
    await ctx.scheduler.runAfter(0, identity.accountDeletion.purgeBatch, {
      deletionId,
      generation: 1,
    });
    await ctx.scheduler.runAfter(CLERK_FIRST_DELAY_MS, identity.clerkDeletion.deleteClerkUser, {
      deletionId,
      attempt: 1,
    });
    return result(startedAt);
  },
});

// Deletes the record once both the purge and the Clerk deletion are done;
// until then it stays and refuses the Clerk subject.
export async function finishIfComplete(
  ctx: Pick<MutationCtx, "db">,
  record: Doc<"accountDeletions">,
): Promise<boolean> {
  if (record.purgedAt !== undefined && record.clerk.state === "done") {
    await ctx.db.delete("accountDeletions", record._id);
    return true;
  }
  return false;
}

// Marks a deletion past its 24-hour deadline once, and logs it without the
// account's identifiers.
function overdue(record: Doc<"accountDeletions">, now: number): { overdueAt?: number } {
  if (record.overdueAt !== undefined || now <= record.startedAt + DELETION_WINDOW_MS) {
    return {};
  }
  console.error(
    `Account deletion ${record._id} is past its deadline in phase ${record.phase}` +
      ` after ${Math.round((now - record.startedAt) / 60_000)} min`,
  );
  return { overdueAt: now };
}

// One purge batch: at most PURGE_BATCH rows across the current phase and the
// ones after it, then the next batch is scheduled. The progress and the
// deletions commit together, and a batch that throws rolls both back, so the
// phase never moves past rows that are still stored. A batch whose
// `generation` is no longer the record's does nothing, so a duplicate or a
// chain that recovery replaced stops. Once `verify` finds nothing, the
// `users` row is deleted.
export const purgeBatch = internalMutation({
  args: { deletionId: v.id("accountDeletions"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { deletionId, generation }) => {
    const record = await ctx.db.get("accountDeletions", deletionId);
    if (record === null || record.generation !== generation || record.purgedAt !== undefined) {
      return null;
    }
    const now = Date.now();
    let phase = record.phase;
    let budget = PURGE_BATCH;
    let finished = false;
    while (budget > 0) {
      const step = await runPhase(ctx, phase, record.userId, budget);
      budget -= step.deleted;
      if (!step.done) {
        break;
      }
      const next = PHASES[PHASES.indexOf(phase) + 1];
      if (next === undefined) {
        finished = true;
        break;
      }
      phase = next;
    }

    if (finished) {
      const user = await ctx.db.get("users", record.userId);
      if (user !== null) {
        await ctx.db.delete("users", user._id);
      }
      const done = { ...record, phase, purgedAt: now, updatedAt: now };
      if (!(await finishIfComplete(ctx, done))) {
        await ctx.db.patch("accountDeletions", deletionId, {
          phase,
          purgedAt: now,
          updatedAt: now,
          ...overdue(record, now),
        });
      }
      return null;
    }

    await ctx.db.patch("accountDeletions", deletionId, {
      phase,
      generation: generation + 1,
      updatedAt: now,
      ...overdue(record, now),
    });
    await ctx.scheduler.runAfter(0, identity.accountDeletion.purgeBatch, {
      deletionId,
      generation: generation + 1,
    });
    return null;
  },
});

// Hourly recovery from convex/crons.ts. It restarts each deletion with no
// progress for STALL_MS: a purge that is not finished gets a new chain under
// a new generation, which stops the old one, and a Clerk deletion whose
// attempt is overdue by STALL_MS gets a new attempt. A purge batch that
// failed, for example, left its chain without a successor; this run picks it
// up again. A full page schedules another run for the rest.
export const resumePurges = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const stalled = await ctx.db
      .query("accountDeletions")
      .withIndex("by_updated", (q) => q.lt("updatedAt", now - STALL_MS))
      .take(RESUME_PAGE);
    for (const record of stalled) {
      const patch: Partial<Doc<"accountDeletions">> = { updatedAt: now, ...overdue(record, now) };
      if (record.purgedAt === undefined) {
        patch.generation = record.generation + 1;
        patch.restarts = record.restarts + 1;
        await ctx.scheduler.runAfter(0, identity.accountDeletion.purgeBatch, {
          deletionId: record._id,
          generation: record.generation + 1,
        });
      }
      if (record.clerk.state === "pending" && record.clerk.nextAttemptAt <= now - STALL_MS) {
        const attempt = record.clerk.attempt + 1;
        patch.clerk = { ...record.clerk, attempt, nextAttemptAt: now };
        await ctx.scheduler.runAfter(0, identity.clerkDeletion.deleteClerkUser, {
          deletionId: record._id,
          attempt,
        });
      }
      await ctx.db.patch("accountDeletions", record._id, patch);
    }
    if (stalled.length === RESUME_PAGE) {
      await ctx.scheduler.runAfter(0, identity.accountDeletion.resumePurges, {});
    }
    return stalled.length;
  },
});
