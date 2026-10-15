import { chatMessageSchema, decisionInputFieldsSchema } from "@agentdesk/contract";
import type { RouteSpec } from "convex/server";
import { z } from "zod";
import { serviceRoute } from "../lib/svc";
import { decisions } from "./refs";

// The decisions domain's service routes, mounted by convex/http.ts
// (component-backend-foundation §Composition; component-decisions §Service
// routes). The gateway resolved the caller before calling, so `userId` and
// `agentSessionId` are trusted and nothing else in the body names an identity
// (req-agent-tools REQ-7). Each handler runs one mutation, so a session touch
// and the action share one transaction. `/svc/decisions/cancel` may omit the
// caller session, and `/svc/decisions/watch` names none.
// `/svc/decisions/resolve` is the only route that accepts an answer from an
// MCP session, and it requires the user's chat message (req-agent-tools
// AC-7.3).
const id = z.string().min(1);

export const routes: RouteSpec[] = [
  {
    // MCP `ask`. The body carries the contract's decision input fields beside
    // the caller; the mutation applies the contract's cross-field rules at its
    // own clock.
    path: "/svc/decisions/create",
    method: "POST",
    handler: serviceRoute(
      decisionInputFieldsSchema.extend({ userId: id, agentSessionId: id }),
      (ctx, { userId, agentSessionId, ...input }) =>
        ctx.runMutation(decisions.operations.create, { userId, agentSessionId, input }),
    ),
  },
  {
    // MCP `await`, one poll.
    path: "/svc/decisions/poll",
    method: "POST",
    handler: serviceRoute(
      z.object({ userId: id, agentSessionId: id, decisionId: id }),
      (ctx, input) => ctx.runMutation(decisions.operations.poll, input),
    ),
  },
  {
    // The resume waiter's read, through the gateway's `POST /device/wait`
    // (DEC-15). The waiter has no MCP session, so the body names none and the
    // route opens none (req-installation-and-agent-guidance AC-12.7). The
    // mutation touches the session that asked, recorded on the decision.
    path: "/svc/decisions/watch",
    method: "POST",
    handler: serviceRoute(z.object({ userId: id, decisionId: id }), (ctx, input) =>
      ctx.runMutation(decisions.operations.watch, input),
    ),
  },
  {
    // MCP `check`.
    path: "/svc/decisions/check",
    method: "POST",
    handler: serviceRoute(
      z.object({ userId: id, agentSessionId: id, decisionIds: z.array(z.string()) }),
      (ctx, input) => ctx.runMutation(decisions.operations.check, input),
    ),
  },
  {
    // MCP `cancel` with a session, the public API without one.
    path: "/svc/decisions/cancel",
    method: "POST",
    handler: serviceRoute(
      z.object({ userId: id, decisionId: id, agentSessionId: id.optional() }),
      (ctx, input) => ctx.runMutation(decisions.operations.cancel, input),
    ),
  },
  {
    // MCP `resolve`: relays an answer the user gave in the calling agent's
    // chat (req-agent-tools REQ-9; DEC-13). The body schema refuses a missing,
    // blank, or over-long `chatMessage` before any read, so a refused message
    // touches nothing (AC-9.1; req-decision-requests AC-8.2). The answer is
    // validated against the decision inside the mutation, after the settled
    // check, so a settled decision is 409 whatever the answer holds (AC-9.2).
    path: "/svc/decisions/resolve",
    method: "POST",
    handler: serviceRoute(
      z.object({
        userId: id,
        agentSessionId: id,
        decisionId: id,
        // Absent or not, the answer reaches the mutation.
        answer: z.unknown().optional(),
        chatMessage: chatMessageSchema,
      }),
      (ctx, input) => ctx.runMutation(decisions.operations.resolve, input),
    ),
  },
];
