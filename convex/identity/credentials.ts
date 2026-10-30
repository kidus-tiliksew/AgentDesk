import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { API_TOKEN_PREFIX, mintToken } from "./tokens";

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
// caller hands to the client once. Only the hash is stored. Enrollment also
// passes the install key, the run's machine id, and, for an ephemeral key, the
// idle deadline (§Enrollment).
export async function insertConnectionToken(
  ctx: Pick<MutationCtx, "db">,
  credential: {
    userId: Id<"users">;
    harness: string;
    name: string;
    machineName?: string;
    installKeyId?: Id<"installKeys">;
    machineId?: string;
    idleDeadlineAt?: number;
  },
): Promise<{ plaintext: string; credentialId: Id<"credentials"> }> {
  const { plaintext, hash } = await mintToken();
  const credentialId = await ctx.db.insert("credentials", {
    ...credential,
    kind: "connection_token",
    tokenHash: hash,
  });
  return { plaintext, credentialId };
}

// Inserts one API token for a user and returns its plaintext, which the caller
// shows once (req-public-api-and-webhooks AC-3.1). Only the hash is stored. A
// Mac sign-in passes `harness` and `machineName`, which admit the token to the
// connection functions (convex/identity/clients.ts#isMacCredential).
export async function insertApiToken(
  ctx: Pick<MutationCtx, "db">,
  credential: { userId: Id<"users">; name: string; harness?: string; machineName?: string },
): Promise<{ plaintext: string; credentialId: Id<"credentials"> }> {
  const { plaintext, hash } = await mintToken(API_TOKEN_PREFIX);
  const credentialId = await ctx.db.insert("credentials", {
    ...credential,
    kind: "api_token",
    tokenHash: hash,
  });
  return { plaintext, credentialId };
}

// Resolves the SHA-256 hex of a presented token to its user and credential
// (req-accounts-and-connections AC-4.2; req-agent-tools AC-7.1). An unknown
// hash, a revoked credential, and a deleting account are all unauthenticated.
// When the resolve writes `lastUsedAt` on a connection of an ephemeral key,
// it also moves the connection's idle deadline (§Enrollment), so MCP calls
// and `/device/wait` polls both keep the connection alive.
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
      await ctx.db.patch("credentials", credential._id, {
        lastUsedAt: now,
        ...(await nextIdleDeadline(ctx, credential, now)),
      });
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

// The idle deadline a resolve at `now` writes on a connection of an ephemeral
// key, or nothing for any other credential. A revoked key still sets it, so
// the connections it made keep working until they go idle (req-install-keys
// AC-3.2). A request within the next LAST_USED_WRITE_INTERVAL_MS writes
// nothing, so the deadline counts the idle limit from the end of that
// interval: the sweep never ends a connection that made a request within its
// idle limit, and ends an idle one at most a minute plus one sweep after the
// limit passes (AC-4.1).
async function nextIdleDeadline(
  ctx: Pick<MutationCtx, "db">,
  credential: Doc<"credentials">,
  now: number,
): Promise<{ idleDeadlineAt?: number }> {
  if (credential.idleDeadlineAt === undefined || credential.installKeyId === undefined) {
    return {};
  }
  const key = await ctx.db.get("installKeys", credential.installKeyId);
  if (key?.idleLimitMinutes === undefined) {
    return {};
  }
  return { idleDeadlineAt: now + LAST_USED_WRITE_INTERVAL_MS + key.idleLimitMinutes * 60_000 };
}

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
