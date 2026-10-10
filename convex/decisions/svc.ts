import { decisionInputFieldsSchema } from "@agentdesk/contract";
import type { RouteSpec } from "convex/server";
import { z } from "zod";
import { serviceRoute } from "../lib/svc";
import { decisions } from "./refs";

// The decisions domain's service routes, mounted by convex/http.ts
// (component-backend-foundation §Composition; component-decisions §Service
// routes). The gateway resolved the caller before calling, so `userId` and
// `agentSessionId` are trusted and nothing else in the body names an identity
// (req-agent-tools REQ-7). Each handler runs one mutation that touches the
// session and acts in the same transaction. No route accepts an answer
// (req-agent-tools AC-7.3).
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
];
