import type { RouteSpec } from "convex/server";
import { z } from "zod";
import { serviceRoute } from "../lib/svc";
import { agents } from "./refs";

// The agents domain's service routes, mounted by convex/http.ts
// (component-backend-foundation §Composition; component-agent-presence
// §Service routes). The gateway resolved the caller before calling, so
// `userId` is trusted and nothing else in the body names an identity
// (req-agent-tools REQ-7). Status fields pass through as strings; the
// mutation validates them with the contract and names the failing field.
export const routes: RouteSpec[] = [
  {
    // MCP `initialize`.
    path: "/svc/agents/open",
    method: "POST",
    handler: serviceRoute(
      z.object({
        userId: z.string().min(1),
        credentialId: z.string().min(1),
        clientName: z.string().min(1),
        clientVersion: z.string(),
      }),
      (ctx, input) => ctx.runMutation(agents.sessions.open, input),
    ),
  },
  {
    // MCP `status`, with `touch`.
    path: "/svc/agents/status",
    method: "POST",
    handler: serviceRoute(
      z.object({
        userId: z.string().min(1),
        agentSessionId: z.string().min(1),
        topic: z.string(),
        state: z.string(),
        line: z.string(),
        link: z.string().optional(),
        display_name: z.string().optional(),
      }),
      (ctx, input) => ctx.runMutation(agents.sessions.status, input),
    ),
  },
  {
    // Resolves `Mcp-Session-Id` to the caller's session, or 404.
    path: "/svc/agents/session",
    method: "POST",
    handler: serviceRoute(
      z.object({ userId: z.string().min(1), mcpSessionId: z.string().min(1) }),
      (ctx, input) => ctx.runQuery(agents.sessions.session, input),
    ),
  },
  {
    // The public API's `agent_sessions.list`: live sessions, then ended ones.
    path: "/svc/agents/list",
    method: "POST",
    handler: serviceRoute(
      z.object({
        userId: z.string().min(1),
        cursor: z.string().min(1).optional(),
        limit: z.int().min(1).max(100),
      }),
      (ctx, input) => ctx.runQuery(agents.api.list, input),
    ),
  },
  {
    // The public API's `agent_sessions.get`.
    path: "/svc/agents/get",
    method: "POST",
    handler: serviceRoute(
      z.object({ userId: z.string().min(1), agentSessionId: z.string().min(1) }),
      (ctx, input) => ctx.runQuery(agents.api.get, input),
    ),
  },
];
