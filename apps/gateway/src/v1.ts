import {
  ERROR_STATUS,
  type ErrorBody,
  type ErrorCode,
  ROUTES,
  type RouteDefinition,
  type RouteId,
} from "@agentdesk/contract";
import type { z } from "zod";
import { authenticate, type Caller } from "./auth.js";
import { type ServiceCall, ServiceError, type ServiceRoute, UpstreamError } from "./convex.js";
import type { Env } from "./env.js";

// component-gateway §Public HTTP API: the `/v1` operations of the contract's
// route table (req-public-api-and-webhooks REQ-2). Handlers are registered by
// route id, so the served API and `spec/openapi.json` cannot diverge. Each
// request authenticates an API token, takes the `API_LIMIT` rate limit for its
// credential, validates its path, query, and body with the route's schemas,
// makes one service call, and checks the result against the route's response
// schema. Errors carry the contract body with the status `ERROR_STATUS`
// names. A Convex outage or a result of the wrong shape throws, and `handle`
// answers it with 503.

interface Input {
  caller: Caller;
  path: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
}

// The service call each operation makes. `userId` comes from the credential
// alone; nothing the client sends names an identity (req-agent-tools REQ-7).
const HANDLERS: Record<RouteId, (input: Input) => [ServiceRoute, Record<string, unknown>]> = {
  "decisions.list": ({ caller, query }) => ["decisions/list", { userId: caller.userId, ...query }],
  "decisions.get": ({ caller, path }) => [
    "decisions/get",
    { userId: caller.userId, decisionId: path.decision_id },
  ],
  // The service records `answeredVia: "api"` (AC-2.2).
  "decisions.answer": ({ caller, path, body }) => [
    "decisions/answer",
    { userId: caller.userId, decisionId: path.decision_id, ...body },
  ],
  // No agent session: the public API cancels as the user (req-decision-requests
  // AC-4.4).
  "decisions.cancel": ({ caller, path }) => [
    "decisions/cancel",
    { userId: caller.userId, decisionId: path.decision_id },
  ],
  "agent_sessions.list": ({ caller, query }) => [
    "agents/list",
    { userId: caller.userId, ...query },
  ],
  "agent_sessions.get": ({ caller, path }) => [
    "agents/get",
    { userId: caller.userId, agentSessionId: path.agent_session_id },
  ],
};

interface CompiledRoute {
  route: RouteDefinition & { id: RouteId };
  pattern: RegExp;
  params: string[];
}

// Each path template becomes a matcher whose groups are its parameters in
// order. A parameter matches one non-empty path segment.
const COMPILED: CompiledRoute[] = ROUTES.map((route) => {
  const params: string[] = [];
  const source = route.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    params.push(name);
    return "([^/]+)";
  });
  return { route, pattern: new RegExp(`^${source}$`), params };
});

// Service fields that name a request field of the public API, by their
// public name (§Tools restates MCP fields the same way).
const PUBLIC_FIELDS: Record<string, string> = {
  decisionId: "decision_id",
  agentSessionId: "agent_session_id",
};
const KEPT_FIELDS = ["answer", "note", "state", "topic", "cursor", "limit"];

const MALFORMED_ID: Record<string, string> = {
  decisionId: "decision_id is not a valid decision id",
  agentSessionId: "agent_session_id is not a valid agent session id",
};

// Answers one `/v1` request. An unknown method and path pair is 404.
export async function handleV1(request: Request, env: Env, svc: ServiceCall): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  const matched = match(request.method, pathname);
  if (matched === null) {
    return failure("not_found", "Not found");
  }
  const { route, path } = matched;

  const caller = await authenticate(request, svc, "api_token");
  if (caller === null) {
    return failure("unauthenticated", "Missing or invalid API token", undefined, {
      "WWW-Authenticate": "Bearer",
    });
  }
  if (env.API_LIMIT === undefined) {
    console.error("/v1 needs the API_LIMIT binding");
    throw new UpstreamError("The API rate limit is not configured");
  }
  const { success } = await env.API_LIMIT.limit({ key: caller.credentialId });
  if (!success) {
    return failure("rate_limited", "Too many requests; try again in a minute");
  }

  const pathResult = parse(route.pathParams, path);
  if (!pathResult.success) {
    return pathResult.response;
  }
  const queryResult = parse(route.query, queryOf(searchParams));
  if (!queryResult.success) {
    return queryResult.response;
  }
  let bodyResult: ParseResult = { success: true, data: {} };
  if (route.body !== undefined) {
    const raw = await jsonBody(request);
    if (raw === undefined) {
      return failure("invalid", "Body must be JSON");
    }
    bodyResult = parse(route.body, raw);
    if (!bodyResult.success) {
      return bodyResult.response;
    }
  }

  const [serviceRoute, serviceBody] = HANDLERS[route.id]({
    caller,
    path: pathResult.data as Record<string, string>,
    query: queryResult.data,
    body: bodyResult.data,
  });
  let result: unknown;
  try {
    result = await svc(serviceRoute, serviceBody, request.signal);
  } catch (error) {
    if (error instanceof ServiceError) {
      return serviceFailure(error);
    }
    throw error;
  }
  const response = route.response.safeParse(result);
  if (!response.success) {
    throw new UpstreamError(`Service call ${serviceRoute} returned an unexpected result`);
  }
  return Response.json(response.data, { headers: { "Cache-Control": "no-store" } });
}

function match(
  method: string,
  pathname: string,
): { route: CompiledRoute["route"]; path: Record<string, string> } | null {
  for (const { route, pattern, params } of COMPILED) {
    if (route.method.toUpperCase() !== method) {
      continue;
    }
    const groups = pattern.exec(pathname);
    if (groups === null) {
      continue;
    }
    const path: Record<string, string> = {};
    for (const [index, name] of params.entries()) {
      let value: string;
      try {
        value = decodeURIComponent(groups[index + 1] ?? "");
      } catch {
        return null;
      }
      path[name] = value;
    }
    return { route, path };
  }
  return null;
}

// Query values arrive as strings. `limit` is parsed to an integer before
// validation; a value that is not one stays a string, so the schema refuses it
// naming `limit`. The first value of a repeated parameter is used.
function queryOf(searchParams: URLSearchParams): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const [name, value] of searchParams) {
    if (name in query) {
      continue;
    }
    query[name] = name === "limit" && /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return query;
}

type ParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; response: Response };

// Parses with an optional schema; no schema accepts nothing and yields `{}`.
// A failure answers 400 naming the first issue's dotted path.
function parse(schema: z.ZodType | undefined, value: unknown): ParseResult {
  if (schema === undefined) {
    return { success: true, data: {} };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { success: true, data: parsed.data as Record<string, unknown> };
  }
  const issue = parsed.error.issues[0];
  const field = issue?.path.map(String).join(".");
  return {
    success: false,
    response: failure("invalid", issue?.message ?? "Invalid request", field || undefined),
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// A service refusal keeps its code. Its field is restated as the public
// request field, or left out when it names a field the gateway fills in.
function serviceFailure(error: ServiceError): Response {
  const { code, field } = error;
  if (field === undefined) {
    return failure(code, error.message);
  }
  const publicField = PUBLIC_FIELDS[field];
  if (publicField !== undefined) {
    const message =
      code === "invalid" && error.message === `Invalid ${field}`
        ? (MALFORMED_ID[field] ?? error.message)
        : error.message;
    return failure(code, message, publicField);
  }
  if (KEPT_FIELDS.some((kept) => field === kept || field.startsWith(`${kept}.`))) {
    return failure(code, error.message, field);
  }
  if (field === "userId") {
    return failure(code, "AgentDesk refused the credential");
  }
  return failure(code, "AgentDesk refused the request");
}

function failure(
  code: ErrorCode,
  message: string,
  field?: string,
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = {
    error: field === undefined ? { code, message } : { code, message, field },
  };
  return Response.json(body, { status: ERROR_STATUS[code], headers });
}
