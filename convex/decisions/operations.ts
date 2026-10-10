import type { Decision } from "@agentdesk/contract";
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { touch } from "../agents/sessions";
import {
  cancelDecision,
  insertDecision,
  loadCheck,
  loadOwned,
  parseId,
  serialize,
  validateCreate,
} from "./model";

// component-decisions §Service routes: one internal mutation per route. Each
// validates its input, loads any decision it needs for the topic, calls
// `touch` from component-agent-presence, then acts, all in one transaction,
// so a failure anywhere also rolls back the session activity. No mutation
// here accepts an answer (req-agent-tools AC-7.3).

// MCP `ask`.
export const create = internalMutation({
  args: { userId: v.string(), agentSessionId: v.string(), input: v.any() },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const agentSessionId = parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");
    const input = validateCreate(args.input, now);
    await touch(ctx, userId, agentSessionId, input.topic, now);
    return await insertDecision(ctx, userId, agentSessionId, input, now);
  },
});

// MCP `await`, one poll. The touch carries the decision's topic.
export const poll = internalMutation({
  args: { userId: v.string(), agentSessionId: v.string(), decisionId: v.string() },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const agentSessionId = parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, userId, decisionId);
    await touch(ctx, userId, agentSessionId, doc.topic, now);
    return await serialize(ctx, doc);
  },
});

// MCP `check`. The touch carries the first decision's topic. An empty batch
// has none, so it activates no session: on a session not yet activated it is
// `invalid` naming `topic`, the same as any first touch without a topic.
export const check = internalMutation({
  args: { userId: v.string(), agentSessionId: v.string(), decisionIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Decision[]> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const agentSessionId = parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");
    const docs = await loadCheck(ctx, userId, args.decisionIds);
    await touch(ctx, userId, agentSessionId, docs[0]?.topic, now);
    const result: Decision[] = [];
    for (const doc of docs) {
      result.push(await serialize(ctx, doc));
    }
    return result;
  },
});

// MCP `cancel` and the public API. The user or any agent session of the same
// user may cancel (req-decision-requests AC-4.4); only a call that names a
// session touches one.
export const cancel = internalMutation({
  args: {
    userId: v.string(),
    decisionId: v.string(),
    agentSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const agentSessionId =
      args.agentSessionId === undefined
        ? undefined
        : parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, userId, decisionId);
    if (agentSessionId !== undefined) {
      await touch(ctx, userId, agentSessionId, doc.topic, now);
    }
    return await cancelDecision(ctx, doc, now);
  },
});
