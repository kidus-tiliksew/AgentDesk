import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { insertApiToken, insertConnectionToken } from "./credentials";
import { findDeletion, findUser } from "./users";

// Development-only connection-token mint. No sign-in surface exists before
// Phase 2, and the Phase 1 demo needs a token on a dev deployment. Being
// internal, it is callable only from the dashboard or with a deploy key:
//
//   npx convex run identity/devMint:mintConnectionToken \
//     '{"clerkUserId": "user_…", "email": "…", "harness": "claude-code", "name": "Claude Code"}'
//
// Phase 3's `collectDeviceRequest` is the production mint
// (component-identity §Short-code sign-in).
export const mintConnectionToken = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    harness: v.string(),
    name: v.string(),
    machineName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { clerkUserId, email, harness, name, machineName },
  ): Promise<{ token: string; userId: Id<"users">; credentialId: Id<"credentials"> }> => {
    const userId = await devUser(ctx, clerkUserId, email);
    const { plaintext, credentialId } = await insertConnectionToken(ctx, {
      userId,
      harness,
      name,
      ...(machineName === undefined ? {} : { machineName }),
    });
    return { token: plaintext, userId, credentialId };
  },
});

// Development-only API-token mint, so the gateway smoke run and manual checks
// can call `/v1` before any app creates API tokens. Internal like
// `mintConnectionToken`:
//
//   npx convex run identity/devMint:mintApiToken \
//     '{"clerkUserId": "user_…", "email": "…", "name": "Local API checks"}'
export const mintApiToken = internalMutation({
  args: { clerkUserId: v.string(), email: v.string(), name: v.string() },
  handler: async (
    ctx,
    { clerkUserId, email, name },
  ): Promise<{ token: string; userId: Id<"users">; credentialId: Id<"credentials"> }> => {
    const userId = await devUser(ctx, clerkUserId, email);
    const { plaintext, credentialId } = await insertApiToken(ctx, { userId, name });
    return { token: plaintext, userId, credentialId };
  },
});

// The dev mints' account: the existing user, or a new one. An account being
// deleted is refused before anything is written.
async function devUser(ctx: MutationCtx, clerkUserId: string, email: string): Promise<Id<"users">> {
  const existing = await findUser(ctx, clerkUserId);
  if (existing?.deletingAt !== undefined || (await findDeletion(ctx, clerkUserId)) !== null) {
    throw appError(errorCodeSchema.enum.unauthenticated, "Account is being deleted");
  }
  return existing?._id ?? (await ctx.db.insert("users", { clerkUserId, email }));
}
