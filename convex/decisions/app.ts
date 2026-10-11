import { type Decision, errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { pendingForUser } from "./appReads";
import { answerDecision, getDecision, loadOwned, parseId } from "./model";

// component-decisions §Reads: the app's functions. The app calls Convex as
// the signed-in person (DEC-3, DEC-7), so each function resolves the account
// with requireUser and takes no user id, agent identity, or answer surface
// from the client. A missing and a foreign decision are both `not_found`
// (req-accounts-and-connections AC-1.1).

// The inbox: the user's pending decisions, urgent first, then by deadline
// with none last, then oldest (req-mobile-app AC-2.1). The query is reactive,
// so the inbox follows creation and settlement without user action (AC-2.3).
export const listPending = query({
  args: {},
  handler: async (ctx): Promise<Decision[]> => {
    const user = await requireUser(ctx);
    return await pendingForUser(ctx, user._id);
  },
});

// The decision screen: one owned decision with its parent and follow-up ids
// (req-mobile-app AC-3.1; req-decision-requests AC-6.2). The asking session
// need not exist (REQ-7).
export const get = query({
  args: { decisionId: v.string() },
  handler: async (ctx, args): Promise<Decision> => {
    const user = await requireUser(ctx);
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    return await getDecision(ctx, user._id, decisionId);
  },
});

// The decision screen's answer. The surface is always `app`. The answer and
// note are taken as any value so the mechanism's validation names the
// failing field, as `invalid`, and leaves the decision pending
// (req-decision-requests AC-2.2). A settled decision is the mechanism's
// `conflict`, whose data carries the stored `Decision` under `decision`, so
// the app shows the recorded outcome (req-mobile-app AC-3.2). No MCP tool
// reaches this mutation (req-agent-tools AC-7.3).
export const answer = mutation({
  args: { decisionId: v.string(), answer: v.any(), note: v.optional(v.any()) },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const user = await requireUser(ctx);
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, user._id, decisionId);
    const note: unknown = args.note;
    // A settled decision stays a `conflict` whatever the note holds.
    if (doc.state === "pending" && note !== undefined && typeof note !== "string") {
      throw appError(errorCodeSchema.enum.invalid, "note must be a string", "note");
    }
    return await answerDecision(
      ctx,
      doc,
      args.answer,
      typeof note === "string" ? note : undefined,
      "app",
      now,
    );
  },
});
