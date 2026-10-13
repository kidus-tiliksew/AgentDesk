import { errorCodeSchema } from "@agentdesk/contract";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";

// component-identity §Accounts.

// Returns the raw row for a Clerk user, including one whose deletion has started.
export async function findUser(ctx: Pick<QueryCtx, "db">, clerkUserId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkUserId", clerkUserId))
    .unique();
}

// Returns the deletion record of a Clerk user's account, or null. The record
// outlives the `users` row while the Clerk user's deletion is retried and for
// the refusal window after both steps finish (§Account deletion).
export async function findDeletion(ctx: Pick<QueryCtx, "db">, clerkUserId: string) {
  return await ctx.db
    .query("accountDeletions")
    .withIndex("by_clerk", (q) => q.eq("clerkUserId", clerkUserId))
    .unique();
}

// Returns the active account for a Clerk user, or null when there is none or
// its deletion has started.
export async function getUserByClerkId(
  ctx: Pick<QueryCtx, "db">,
  clerkUserId: string,
): Promise<Doc<"users"> | null> {
  const user = await findUser(ctx, clerkUserId);
  return user === null || user.deletingAt !== undefined ? null : user;
}

// Returns the signed-in person's account, creating it on first use
// (req-accounts-and-connections AC-2.1). The lookup reads the raw row, so a
// deleting account is refused instead of being recreated while its purge runs.
// A subject whose deletion record remains after the purge deleted its row is
// refused too, so a Convex token Clerk issued before the deletion, which still
// authenticates until it expires, cannot create a new account.
// Lookup and insert share the caller's mutation transaction, so concurrent
// first calls cannot create two rows for one subject.
export async function ensureUser(ctx: Pick<MutationCtx, "auth" | "db">): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw appError(errorCodeSchema.enum.unauthenticated, "Not signed in");
  }
  const existing = await findUser(ctx, identity.subject);
  if (existing !== null) {
    if (existing.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Account is being deleted");
    }
    return existing;
  }
  if ((await findDeletion(ctx, identity.subject)) !== null) {
    throw appError(errorCodeSchema.enum.unauthenticated, "Account is being deleted");
  }
  if (!identity.email) {
    throw appError(errorCodeSchema.enum.unauthenticated, "Sign-in identity has no email");
  }
  const id = await ctx.db.insert("users", { clerkUserId: identity.subject, email: identity.email });
  const user = await ctx.db.get("users", id);
  if (user === null) {
    throw new Error("Inserted user row is missing");
  }
  return user;
}
