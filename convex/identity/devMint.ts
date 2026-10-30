import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { insertApiToken, insertConnectionToken } from "./credentials";
import { insertInstallKey } from "./installKeys";
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

// Development-only install-key mint, so the gateway smoke run can enroll
// before the app's install-key screen exists. Internal like the mints above.
// It validates and stores the key exactly as `createInstallKey` does
// (component-identity §Install keys) and returns the secret once:
//
//   npx convex run identity/devMint:mintInstallKey \
//     '{"clerkUserId": "user_…", "email": "…", "label": "Smoke", "harnesses": ["claude-code"],
//       "expiresInDays": 1, "machineLimit": 1, "ephemeral": true, "idleLimitMinutes": 15}'
export const mintInstallKey = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    label: v.string(),
    harnesses: v.array(v.string()),
    expiresInDays: v.number(),
    machineLimit: v.number(),
    ephemeral: v.boolean(),
    idleLimitMinutes: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { clerkUserId, email, ...input },
  ): Promise<{ secret: string; userId: Id<"users">; installKeyId: Id<"installKeys"> }> => {
    const userId = await devUser(ctx, clerkUserId, email);
    const { installKeyId, secret } = await insertInstallKey(ctx, userId, input, Date.now());
    return { secret, userId, installKeyId };
  },
});

// Development-only inspection of one connection, so the gateway smoke run
// can check that an idle ephemeral connection ended with its sessions and
// decisions (component-identity §Ending a connection) without presenting the
// connection's token, which would keep it alive. Internal, like the mints. It
// reads the agents and decisions tables only to report them, and writes
// nothing:
//
//   npx convex run identity/devMint:inspectConnection '{"credentialId": "…"}'
export const inspectConnection = internalQuery({
  args: { credentialId: v.string() },
  handler: async (ctx, args) => {
    const credentialId = ctx.db.normalizeId("credentials", args.credentialId);
    const credential = credentialId === null ? null : await ctx.db.get("credentials", credentialId);
    if (credential === null) {
      throw appError(errorCodeSchema.enum.not_found, "Credential not found");
    }
    const sessions = await ctx.db
      .query("agentSessions")
      .withIndex("by_credential", (q) => q.eq("credentialId", credential._id))
      .collect();
    const decisions = [];
    for (const session of sessions) {
      const rows = await ctx.db
        .query("decisions")
        .withIndex("by_agent_state", (q) => q.eq("agentSessionId", session._id))
        .collect();
      for (const row of rows) {
        decisions.push({ id: row._id, state: row.state, cancelReason: row.cancelReason ?? null });
      }
    }
    return {
      revokedAt: credential.revokedAt ?? null,
      idleDeadlineAt: credential.idleDeadlineAt ?? null,
      lastUsedAt: credential.lastUsedAt ?? null,
      sessions: sessions.map((session) => ({
        id: session._id,
        endedAt: session.endedAt ?? null,
        endReason: session.endReason ?? null,
      })),
      decisions,
    };
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
