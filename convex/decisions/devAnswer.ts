import { type Decision, errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { appError } from "../lib/errors";
import { answerDecision, loadOwned, parseId } from "./model";

// Development-only answer path. No answer surface exists before Phase 2, and
// the Phase 1 demo settles a decision on a dev deployment. Being internal, it
// is callable only from the dashboard or with a deploy key:
//
//   npx convex run decisions/devAnswer:answer \
//     '{"decisionId": "…", "answer": {"kind": "approve"}, "answeredVia": "app"}'
//
// It takes the owner from the decision and runs the same `answer` mechanism
// as the production surfaces: the Phase 2 app mutation and the Phase 5
// `/svc/decisions/answer` route (component-decisions §Service routes). No MCP
// tool reaches it (req-agent-tools AC-7.3), and it cannot record `chat`, which
// only a relay through `/svc/decisions/resolve` records.
export const answer = internalMutation({
  args: {
    decisionId: v.string(),
    answer: v.any(),
    note: v.optional(v.string()),
    answeredVia: v.string(),
  },
  handler: async (ctx, args): Promise<Decision> => {
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const found = await ctx.db.get("decisions", decisionId);
    if (found === null) {
      throw appError(errorCodeSchema.enum.not_found, "Decision not found");
    }
    const doc = await loadOwned(ctx, found.userId, decisionId);
    return await answerDecision(ctx, doc, args.answer, args.note, args.answeredVia, Date.now());
  },
});
