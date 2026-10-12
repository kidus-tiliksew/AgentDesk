import type { Decision } from "@agentdesk/contract";
import { hashToken } from "../src/auth.js";
import { type ServiceCall, ServiceError, type ServiceRoute } from "../src/convex.js";
import type { Env } from "../src/env.js";

// Test doubles for the gateway: a fake Convex service client that records
// every call, a fixed environment, and request builders.

export const TOKEN = `adc_${"a".repeat(43)}`;
export const USER = "user_a";
export const CREDENTIAL = "cred_a";
export const SESSION = "mcp_session_a";
export const AGENT_SESSION = "agent_session_a";

export const env: Env = {
  PUBLIC_ORIGIN: "https://agentdesk.example",
  CONVEX_SITE_URL: "https://convex.example",
  CLERK_PUBLISHABLE_KEY: "pk_test",
  SERVICE_SECRET: "service-secret-value",
};

type Handler = (body: Record<string, unknown>, signal?: AbortSignal) => unknown;

export interface Call {
  route: ServiceRoute;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

// The default handlers know one user with one connection token and one MCP
// session. Anything else is refused the way the service routes refuse it.
export function fakeConvex(overrides: Partial<Record<ServiceRoute, Handler>> = {}) {
  const calls: Call[] = [];
  const handlers: Partial<Record<ServiceRoute, Handler>> = {
    "identity/resolve-token": async (body) => {
      if (body.token_hash !== (await hashToken(TOKEN))) {
        throw new ServiceError("unauthenticated", "Invalid credential");
      }
      return { userId: USER, credentialId: CREDENTIAL, kind: "connection_token" };
    },
    "agents/open": () => ({ agentSessionId: AGENT_SESSION, mcpSessionId: SESSION }),
    "agents/session": (body) => {
      if (body.userId !== USER || body.mcpSessionId !== SESSION) {
        throw new ServiceError("not_found", "Not found");
      }
      return { agentSessionId: AGENT_SESSION };
    },
    ...overrides,
  };
  const svc: ServiceCall = async (route, body, signal) => {
    calls.push(signal === undefined ? { route, body } : { route, body, signal });
    const handler = handlers[route];
    if (handler === undefined) {
      throw new Error(`Unexpected service call ${route}`);
    }
    return await handler(body, signal);
  };
  return { svc, calls, routes: () => calls.map((call) => call.route) };
}

// The routes every authenticated, session-bound request makes before any tool
// runs.
export const TRANSPORT_ROUTES: ServiceRoute[] = ["identity/resolve-token", "agents/session"];

// A POST /mcp request with a valid credential, session, and protocol version.
// A header set to null is left out.
export function mcpRequest(body: unknown, headers: Record<string, string | null> = {}): Request {
  const all: Record<string, string | null> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Session-Id": SESSION,
    "MCP-Protocol-Version": "2025-11-25",
    ...headers,
  };
  return new Request("https://agentdesk.example/mcp", {
    method: "POST",
    headers: Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Reads a `text/event-stream` body to its end and returns its comment lines
// and the data of each `message` event, parsed as JSON.
export async function readEvents(
  response: Response,
): Promise<{ comments: string[]; messages: unknown[] }> {
  return parseEvents(await response.text());
}

export function parseEvents(text: string): { comments: string[]; messages: unknown[] } {
  const comments: string[] = [];
  const messages: unknown[] = [];
  for (const frame of text.split("\n\n").filter((part) => part !== "")) {
    if (frame.startsWith(":")) {
      comments.push(frame);
      continue;
    }
    const lines = frame.split("\n");
    if (lines[0] !== "event: message" || !lines[1]?.startsWith("data: ")) {
      throw new Error(`Unexpected event frame ${JSON.stringify(frame)}`);
    }
    messages.push(JSON.parse(lines[1].slice("data: ".length)));
  }
  return { comments, messages };
}

export function rpc(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision_1",
    topic: "repo/main",
    title: "Ship it?",
    body: null,
    input_type: "approve_reject",
    options: null,
    recommendation: null,
    priority: "normal",
    deadline: null,
    default: null,
    state: "pending",
    answer: null,
    note: null,
    answered_at: null,
    answered_via: null,
    applied_by_default: false,
    parent_id: null,
    follow_up_ids: [],
    agent_session_id: AGENT_SESSION,
    created_at: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

// A per-key stand-in for the `DEVICE_START_LIMIT` binding: `limit` calls per
// fixed window of `periodMs` on the given clock. It records every key asked.
export function fakeLimiter(limit = 10, periodMs = 60_000, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  const keys: string[] = [];
  const binding: RateLimit = {
    async limit({ key }) {
      keys.push(key);
      const at = now();
      const current = windows.get(key);
      const window =
        current === undefined || at - current.start >= periodMs ? { start: at, count: 0 } : current;
      window.count++;
      windows.set(key, window);
      return { success: window.count <= limit };
    },
  };
  return { binding, keys };
}

// A request to a gateway route other than `/mcp`. A JSON body is sent as
// text, and a string body as it is. A header set to null is left out.
export function routeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string | null> = {},
): Request {
  const all: Record<string, string | null> = {
    "Content-Type": body === undefined ? null : "application/json",
    ...headers,
  };
  return new Request(`https://agentdesk.example${path}`, {
    method,
    headers: Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
