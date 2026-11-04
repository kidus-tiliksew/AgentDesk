import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import { isMacCredential } from "./clients";
import { identity } from "./refs";

// component-identity §PostHog Mac property (req-accounts-and-connections REQ-7;
// DEC-22 (3)): the backend sets `has_mac_app` on the account's PostHog person,
// and the Mac app sends no analytics (req-mac-app REQ-10). Scheduled jobs carry
// only the user id, so a job sends the state it reads when it runs.

export const POSTHOG_DEFAULT_INGEST_HOST = "https://us.i.posthog.com";
// Users one backfill step reads, which also bounds the sends it schedules.
export const BACKFILL_PAGE_SIZE = 100;

type MacAppState = { distinctId: string; hasMacApp: boolean };

async function hasUnrevokedMac(ctx: Pick<QueryCtx, "db">, userId: Id<"users">): Promise<boolean> {
  const tokens = await ctx.db
    .query("credentials")
    .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", "api_token"))
    .collect();
  return tokens.some((token) => token.revokedAt === undefined && isMacCredential(token));
}

// The account's current state, or null for a missing or deleting account, which
// sends nothing (AC-7.3).
export const macAppState = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.null(), v.object({ distinctId: v.string(), hasMacApp: v.boolean() })),
  handler: async (ctx, { userId }): Promise<MacAppState | null> => {
    const user = await ctx.db.get("users", userId);
    if (user === null || user.deletingAt !== undefined) {
      return null;
    }
    return { distinctId: user.clerkUserId, hasMacApp: await hasUnrevokedMac(ctx, userId) };
  },
});

// One attempt. Without a project token it sends nothing (AC-7.3). The request
// carries only the distinct ID and the property (AC-7.2). A failure logs a short
// code and is not retried; the next Mac sign-in or revocation sends the current
// value. The log holds no token, distinct ID, or provider response.
export const syncMacApp = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }): Promise<null> => {
    const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
    if (!projectToken) {
      return null;
    }
    const state = await ctx.runQuery(identity.posthogPerson.macAppState, { userId });
    if (state === null) {
      return null;
    }
    const host = (process.env.POSTHOG_INGEST_HOST || POSTHOG_DEFAULT_INGEST_HOST).replace(
      /\/+$/,
      "",
    );
    try {
      const response = await fetch(`${host}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: projectToken,
          event: "$set",
          distinct_id: state.distinctId,
          properties: { $set: { has_mac_app: state.hasMacApp } },
        }),
      });
      if (!response.ok) {
        console.error(`posthog_mac_app_failed http_${response.status}`);
      }
    } catch {
      console.error("posthog_mac_app_failed network");
    }
    return null;
  },
});

// The operator runs this once per deployment, after the PostHog variables are
// set, because no earlier sign-in or revocation sent the property. Each step
// reads one page of `users`, schedules a send for each active account with an
// unrevoked Mac credential, and schedules the next page. Each send reads the
// account again when it runs.
export const backfillMacApp = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }): Promise<null> => {
    const result = await ctx.db
      .query("users")
      .paginate({ cursor: cursor ?? null, numItems: BACKFILL_PAGE_SIZE });
    for (const user of result.page) {
      if (user.deletingAt === undefined && (await hasUnrevokedMac(ctx, user._id))) {
        await ctx.scheduler.runAfter(0, identity.posthogPerson.syncMacApp, { userId: user._id });
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, identity.posthogPerson.backfillMacApp, {
        cursor: result.continueCursor,
      });
    }
    return null;
  },
});
