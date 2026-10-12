import { type Decision, errorCodeSchema } from "@agentdesk/contract";
import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { pendingForUser } from "./appReads";
import { type HistoryItem, historyPage, parseHistoryFilters } from "./history";
import {
  answerDecision,
  answerForAction,
  getDecision,
  loadOwned,
  parseId,
  refuseSettled,
  removeDecision,
} from "./model";

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

// The history screen: the user's answered, expired, and cancelled decisions,
// searched by text and filtered by state and topic (req-mobile-app AC-6.1).
// The result is Convex's native `PaginationResult`, so the app pages it with
// `usePaginatedQuery`; each row carries the decision and its ISO settlement
// time. The server clamps `paginationOpts.numItems` to 1..50.
export const searchHistory = query({
  args: {
    query: v.optional(v.string()),
    state: v.optional(v.string()),
    topic: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PaginationResult<HistoryItem>> => {
    const user = await requireUser(ctx);
    const filters = parseHistoryFilters(args);
    return await historyPage(ctx, user._id, filters, args.paginationOpts);
  },
});

// Deletes one settled decision from every surface (req-mobile-app AC-6.2). A
// pending decision is `conflict`.
export const remove = mutation({
  args: { decisionId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const user = await requireUser(ctx);
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, user._id, decisionId);
    return await removeDecision(ctx, doc);
  },
});

// The answer from a notification action button, sent by the app's background
// notification task (req-mobile-app AC-4.1). The server maps `action` to the
// answer and fixes the surface to `notification` (req-decision-requests
// AC-4.3). `action` is taken as any value so a malformed one is `invalid`
// naming `action`. A settled decision is `conflict` carrying the stored
// `Decision` whatever the action, as with `answer`. No MCP route reaches this
// mutation (req-agent-tools AC-7.3).
export const answerFromNotification = mutation({
  args: { decisionId: v.string(), action: v.any() },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const user = await requireUser(ctx);
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, user._id, decisionId);
    if (doc.state !== "pending") {
      return await refuseSettled(ctx, doc);
    }
    return await answerDecision(
      ctx,
      doc,
      answerForAction(doc, args.action),
      undefined,
      "notification",
      now,
    );
  },
});
