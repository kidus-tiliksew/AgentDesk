import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { mintToken } from "./tokens";

// component-identity §Credentials.

// A resolve writes `lastUsedAt` at most once a minute per credential, so an
// agent that polls every 25 seconds does not write on every call.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export type ResolvedCredential = {
  userId: Id<"users">;
  credentialId: Id<"credentials">;
  kind: Doc<"credentials">["kind"];
  harness?: string;
  name?: string;
};

// Inserts one connection token for a user and returns its plaintext, which the
// caller hands to the client once. Only the hash is stored.
export async function insertConnectionToken(
  ctx: Pick<MutationCtx, "db">,
  credential: { userId: Id<"users">; harness: string; name: string; machineName?: string },
): Promise<{ plaintext: string; credentialId: Id<"credentials"> }> {
  const { plaintext, hash } = await mintToken();
  const credentialId = await ctx.db.insert("credentials", {
    ...credential,
    kind: "connection_token",
    tokenHash: hash,
  });
  return { plaintext, credentialId };
}

// Resolves the SHA-256 hex of a presented token to its user and credential
// (req-accounts-and-connections AC-4.2; req-agent-tools AC-7.1). An unknown
// hash, a revoked credential, and a deleting account are all unauthenticated.
export const resolveToken = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }): Promise<ResolvedCredential> => {
    const now = Date.now();
    const credential = await ctx.db
      .query("credentials")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (credential === null || credential.revokedAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Invalid credential");
    }
    const user = await ctx.db.get("users", credential.userId);
    if (user === null || user.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Invalid credential");
    }
    if (
      credential.lastUsedAt === undefined ||
      now - credential.lastUsedAt > LAST_USED_WRITE_INTERVAL_MS
    ) {
      await ctx.db.patch("credentials", credential._id, { lastUsedAt: now });
    }
    return {
      userId: credential.userId,
      credentialId: credential._id,
      kind: credential.kind,
      harness: credential.harness,
      name: credential.name,
    };
  },
});

// Revokes one of the user's credentials, so its next resolve is refused
// (req-accounts-and-connections AC-4.2). The Phase 2 connections screen and the
// Phase 3 self-revoke route call it. A second revoke keeps the first time.
export async function revokeCredential(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  credentialId: Id<"credentials">,
): Promise<void> {
  const now = Date.now();
  const credential = await getOwned(ctx, "credentials", credentialId, userId);
  if (credential === null) {
    throw appError(errorCodeSchema.enum.not_found, "Credential not found");
  }
  if (credential.revokedAt === undefined) {
    await ctx.db.patch("credentials", credentialId, { revokedAt: now });
  }
}
