import { z } from "zod";
import { authenticate, type Caller, unauthorized } from "./auth.js";
import { type ServiceCall, ServiceError } from "./convex.js";
import type { Env } from "./env.js";
import { callTool, hasTool, listTools } from "./tools.js";

// component-gateway §MCP transport: Streamable HTTP with hand-written JSON-RPC
// handling. Sessions live in Convex (component-agent-presence), so any Worker
// instance serves any session and the gateway keeps no session registry.

// Newest first: a client asking for an unsupported version gets the newest.
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;

const SERVER_INFO = { name: "agentdesk", version: "0.0.0" };

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SESSION_NOT_FOUND = -32001;

const idSchema = z.union([z.string(), z.number()]);
const paramsSchema = z.record(z.string(), z.unknown());

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  method: z.string(),
  params: paramsSchema.optional(),
});
const notificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: paramsSchema.optional(),
});
const responseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: idSchema, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: idSchema.nullable(),
    error: z.object({ code: z.number(), message: z.string() }),
  }),
]);

const initializeParamsSchema = z.object({
  protocolVersion: z.string(),
  clientInfo: z.object({ name: z.string().min(1), version: z.string() }),
});
const callParamsSchema = z.object({
  name: z.string(),
  arguments: paramsSchema.optional(),
});

type Id = z.infer<typeof idSchema>;
type Message =
  | { kind: "request"; id: Id; method: string; params: Record<string, unknown> }
  | { kind: "notification" }
  | { kind: "response" };

export async function handleMcp(request: Request, env: Env, svc: ServiceCall): Promise<Response> {
  // Streamable HTTP requires an Origin check against DNS rebinding. Native
  // clients send no Origin.
  const origin = request.headers.get("Origin");
  if (origin !== null && !allowedOrigins(request, env).has(origin)) {
    return Response.json(
      { error: { code: "forbidden", message: "Origin not allowed" } },
      {
        status: 403,
      },
    );
  }

  const caller = await authenticate(request, svc);
  if (caller === null) {
    return unauthorized(env);
  }

  switch (request.method) {
    case "POST":
      return await post(request, svc, caller);
    case "DELETE": {
      // The session ends by going stale; Convex has no route that deletes it.
      const session = await resolveSession(request, svc, caller, null);
      return session instanceof Response ? session : new Response(null, { status: 200 });
    }
    default:
      // The server never opens its own event stream.
      return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
  }
}

async function post(request: Request, svc: ServiceCall, caller: Caller): Promise<Response> {
  if (!isJson(request.headers.get("Content-Type"))) {
    return rpcError(null, INVALID_REQUEST, "Content-Type must be application/json", 415);
  }
  if (!acceptsJson(request.headers.get("Accept"))) {
    return rpcError(null, INVALID_REQUEST, "Accept must allow application/json", 406);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, PARSE_ERROR, "Parse error", 400);
  }
  const message = classify(body);
  if (message === null) {
    // Protocol versions 2025-06-18 and later send no batches.
    return rpcError(null, INVALID_REQUEST, "Invalid JSON-RPC message", 400);
  }

  if (message.kind === "request" && message.method === "initialize") {
    return await initialize(svc, caller, message.id, message.params);
  }

  const version = request.headers.get("MCP-Protocol-Version");
  if (version !== null && !isSupported(version)) {
    return rpcError(
      message.kind === "request" ? message.id : null,
      INVALID_REQUEST,
      `Unsupported MCP-Protocol-Version ${version}`,
      400,
    );
  }

  const session = await resolveSession(
    request,
    svc,
    caller,
    message.kind === "request" ? message.id : null,
  );
  if (session instanceof Response) {
    return session;
  }
  if (message.kind !== "request") {
    return new Response(null, { status: 202 });
  }

  const toolCaller = { userId: caller.userId, agentSessionId: session.agentSessionId };
  switch (message.method) {
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: listTools() });
    case "tools/call": {
      const params = callParamsSchema.safeParse(message.params);
      if (!params.success) {
        return rpcError(message.id, INVALID_PARAMS, "tools/call requires a tool name", 200);
      }
      if (!hasTool(params.data.name)) {
        return rpcError(message.id, INVALID_PARAMS, `Unknown tool: ${params.data.name}`, 200);
      }
      const result = await callTool(svc, toolCaller, params.data.name, params.data.arguments);
      return rpcResult(message.id, result);
    }
    default:
      return rpcError(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`, 200);
  }
}

async function initialize(
  svc: ServiceCall,
  caller: Caller,
  id: Id,
  rawParams: Record<string, unknown>,
): Promise<Response> {
  const params = initializeParamsSchema.safeParse(rawParams);
  if (!params.success) {
    return rpcError(id, INVALID_PARAMS, "initialize requires protocolVersion and clientInfo", 200);
  }
  const requested = params.data.protocolVersion;
  const protocolVersion = isSupported(requested) ? requested : PROTOCOL_VERSIONS[0];
  const opened = (await svc("agents/open", {
    userId: caller.userId,
    credentialId: caller.credentialId,
    clientName: params.data.clientInfo.name,
    clientVersion: params.data.clientInfo.version,
  })) as { mcpSessionId: string };
  return rpcResult(
    id,
    { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
    { "Mcp-Session-Id": opened.mcpSessionId },
  );
}

// Resolves `Mcp-Session-Id` to the caller's agent session. A missing header
// is a 400; an unknown id, or one owned by another user, is a 404 so the
// client initializes again (req-agent-tools REQ-7).
async function resolveSession(
  request: Request,
  svc: ServiceCall,
  caller: Caller,
  id: Id | null,
): Promise<{ agentSessionId: string } | Response> {
  const mcpSessionId = request.headers.get("Mcp-Session-Id");
  if (mcpSessionId === null || mcpSessionId === "") {
    return rpcError(id, INVALID_REQUEST, "Mcp-Session-Id header is required", 400);
  }
  try {
    return (await svc("agents/session", { userId: caller.userId, mcpSessionId })) as {
      agentSessionId: string;
    };
  } catch (error) {
    if (error instanceof ServiceError && error.code === "not_found") {
      return rpcError(id, SESSION_NOT_FOUND, "Session not found", 404);
    }
    throw error;
  }
}

function classify(body: unknown): Message | null {
  const request = requestSchema.safeParse(body);
  if (request.success) {
    const { id, method, params } = request.data;
    return { kind: "request", id, method, params: params ?? {} };
  }
  if (notificationSchema.safeParse(body).success && !hasKey(body, "id")) {
    return { kind: "notification" };
  }
  if (responseSchema.safeParse(body).success) {
    return { kind: "response" };
  }
  return null;
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && key in value;
}

function isSupported(version: string): boolean {
  return (PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

// PUBLIC_ORIGIN in production, and the Worker's own origin, which is
// `http://localhost:8787` under `wrangler dev`.
function allowedOrigins(request: Request, env: Pick<Env, "PUBLIC_ORIGIN">): Set<string> {
  const origins = new Set([new URL(request.url).origin]);
  if (URL.canParse(env.PUBLIC_ORIGIN)) {
    origins.add(new URL(env.PUBLIC_ORIGIN).origin);
  }
  return origins;
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

// A missing Accept header admits any type.
function acceptsJson(accept: string | null): boolean {
  if (accept === null) {
    return true;
  }
  return accept
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase())
    .some((type) => type === "application/json" || type === "application/*" || type === "*/*");
}

function rpcResult(id: Id, result: unknown, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { status: 200, headers });
}

function rpcError(id: Id | null, code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}
