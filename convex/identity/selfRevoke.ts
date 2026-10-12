import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { appError } from "../lib/errors";
import { revokeCredential } from "./credentials";

// component-identity §Service routes: the installer's uninstall revokes the
// connection token it presents. Only a live connection token of an active
// account revokes; every other hash is unauthenticated, as resolveToken
// answers it. The check and the revoke share one transaction.
export const revokeSelf = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }): Promise<null> => {
    const credential = await ctx.db
      .query("credentials")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (
      credential === null ||
      credential.kind !== "connection_token" ||
      credential.revokedAt !== undefined
    ) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Invalid credential");
    }
    const user = await ctx.db.get("users", credential.userId);
    if (user === null || user.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Invalid credential");
    }
    await revokeCredential(ctx, credential.userId, credential._id);
    return null;
  },
});
