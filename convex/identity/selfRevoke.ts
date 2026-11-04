import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { appError } from "../lib/errors";
import { isMacCredential } from "./clients";
import { revokeCredential } from "./credentials";
import { endEphemeralConnection, isEphemeralConnection } from "./ephemeral";
import { identity } from "./refs";

// component-identity §Service routes: the installer's uninstall revokes the
// connection token it presents, and the Mac app's sign-out revokes its API
// token (req-mac-app AC-2.7). Only a live connection token or Mac API token of
// an active account revokes; every other hash, including another API token's,
// is unauthenticated, as resolveToken answers it. The check and the revoke
// share one transaction. A connection of an ephemeral install key ends
// through endEphemeralConnection, so `agentdesk uninstall` in a sandbox also
// cancels its pending decisions (req-install-keys AC-4.2). Revoking a Mac
// credential schedules the `has_mac_app` send (§PostHog Mac property).
export const revokeSelf = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }): Promise<null> => {
    const credential = await ctx.db
      .query("credentials")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (
      credential === null ||
      (credential.kind !== "connection_token" && !isMacCredential(credential)) ||
      credential.revokedAt !== undefined
    ) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Invalid credential");
    }
    const user = await ctx.db.get("users", credential.userId);
    if (user === null || user.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Invalid credential");
    }
    if (await isEphemeralConnection(ctx, credential)) {
      await endEphemeralConnection(ctx, credential, Date.now());
    } else {
      await revokeCredential(ctx, credential.userId, credential._id);
    }
    if (isMacCredential(credential)) {
      await ctx.scheduler.runAfter(0, identity.posthogPerson.syncMacApp, {
        userId: credential.userId,
      });
    }
    return null;
  },
});
