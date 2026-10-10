import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { appError } from "../lib/errors";
import { insertConnectionToken } from "./credentials";
import { findUser } from "./users";

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
    const existing = await findUser(ctx, clerkUserId);
    if (existing?.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Account is being deleted");
    }
    const userId = existing?._id ?? (await ctx.db.insert("users", { clerkUserId, email }));
    const { plaintext, credentialId } = await insertConnectionToken(ctx, {
      userId,
      harness,
      name,
      ...(machineName === undefined ? {} : { machineName }),
    });
    return { token: plaintext, userId, credentialId };
  },
});
