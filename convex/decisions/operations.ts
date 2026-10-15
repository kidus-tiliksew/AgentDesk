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
  relayAnswer,
  serialize,
  validateCreate,
} from "./model";

// component-decisions §Service routes: one internal mutation per route. Each
// validates its input, loads any decision it needs for the topic, calls
// `touch` from component-agent-presence, then acts, all in one transaction,
// so a failure anywhere also rolls back the session activity. A route touches
// the session its caller names; `cancel` without one touches none, and `watch`
// touches the asking session recorded on the decision. Only `resolve` accepts
// an answer, and only with the user's chat message (req-agent-tools AC-7.3).

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

// The resume waiter's read, through the gateway's `POST /device/wait` (DEC-15).
// The waiter has no MCP session, so the request names none. The touch goes to
// the session that asked, the row's `agentSessionId`, with the decision's
// topic, so that session stays active while its waiter waits (req-agent-status
// AC-3.5). Decisions outlive their sessions (req-decision-requests REQ-7), so
// the touch is skipped only when that session no longer exists. The existence
// check is explicit rather than a caught `not_found`, so any other touch
// failure, such as a session owned by another user, still fails the call and
// rolls it back. Reads every state and changes no decision.
export const watch = internalMutation({
  args: { userId: v.string(), decisionId: v.string() },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, userId, decisionId);
    const asking = await ctx.db.get("agentSessions", doc.agentSessionId);
    if (asking !== null) {
      await touch(ctx, userId, doc.agentSessionId, doc.topic, now);
    }
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

// MCP `resolve`: relays an answer the user gave in the calling agent's chat
// (req-agent-tools REQ-9; DEC-13). The route checked `chatMessage` with the
// contract's chatMessageSchema before calling. `agentSessionId` is the
// relaying session, which may differ from the asking one. The touch carries
// the decision's topic and rolls back with the rest when the relay fails, so
// a settled decision is `conflict` with no state changed whatever the answer
// holds (AC-9.2).
export const resolve = internalMutation({
  args: {
    userId: v.string(),
    agentSessionId: v.string(),
    decisionId: v.string(),
    answer: v.optional(v.any()),
    chatMessage: v.string(),
  },
  handler: async (ctx, args): Promise<Decision> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const agentSessionId = parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");
    const decisionId = parseId(ctx, "decisions", args.decisionId, "decisionId");
    const doc = await loadOwned(ctx, userId, decisionId);
    await touch(ctx, userId, agentSessionId, doc.topic, now);
    return await relayAnswer(ctx, doc, args.answer, args.chatMessage, agentSessionId, now);
  },
});
