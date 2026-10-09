import { z } from "zod";
import { answerSubmissionSchema } from "../answers.js";
import type { ErrorCode } from "../errors.js";
import { agentSessionSchema, decisionSchema, decisionStateSchema } from "../read-shapes.js";
import { topicInputSchema } from "../topics.js";

// component-contract §Route table and specification: every public HTTP
// operation of req-public-api-and-webhooks REQ-2, listed once. The gateway
// registers its handlers by route id (component-gateway §Public HTTP API),
// and packages/contract/scripts/spec.ts publishes spec/openapi.json from this
// table, so the served API and the published document cannot diverge.

// The HTTP status for each error code (component-gateway §Public HTTP API).
export const ERROR_STATUS = {
  invalid: 400,
  unauthenticated: 401,
  not_found: 404,
  conflict: 409,
  locked: 409,
  rate_limited: 429,
} as const satisfies Record<ErrorCode, number>;

// A list cursor is opaque. It is valid only with the filters it was issued
// for, so a client keeps its filters unchanged while paging.
export const cursorSchema = z.string().min(1);

const cursorParamSchema = cursorSchema.describe(
  "The next_cursor of the previous page. Keep the other filters unchanged while paging.",
);

// Query values arrive as strings; the handler parses `limit` to an integer
// before validation.
export const pageLimitSchema = z
  .int()
  .min(1)
  .max(100)
  .default(50)
  .describe("The maximum number of items in the page.");

// A null `next_cursor` ends pagination.
export const decisionPageSchema = z.object({
  items: z.array(decisionSchema),
  next_cursor: cursorSchema.nullable(),
});
export type DecisionPage = z.infer<typeof decisionPageSchema>;

export const agentSessionPageSchema = z.object({
  items: z.array(agentSessionSchema),
  next_cursor: cursorSchema.nullable(),
});
export type AgentSessionPage = z.infer<typeof agentSessionPageSchema>;

// `topic` is normalized and then matched with topicMatches, so `a/b` also
// lists decisions under `a/b/c` (req-public-api-and-webhooks AC-2.1).
export const decisionListQuerySchema = z.object({
  state: decisionStateSchema.optional(),
  topic: topicInputSchema
    .describe(
      "Lowercased, then matched against the pattern. Lists decisions in this topic and every topic under it.",
    )
    .optional(),
  cursor: cursorParamSchema.optional(),
  limit: pageLimitSchema,
});

export const agentSessionListQuerySchema = z.object({
  cursor: cursorParamSchema.optional(),
  limit: pageLimitSchema,
});

export const decisionPathSchema = z.object({ decision_id: z.string().min(1) });
export const agentSessionPathSchema = z.object({ agent_session_id: z.string().min(1) });

export type HttpMethod = "get" | "post";

export interface RouteDefinition {
  // Stable; the OpenAPI operationId.
  readonly id: string;
  readonly method: HttpMethod;
  // An OpenAPI path template under /v1.
  readonly path: `/v1/${string}`;
  readonly summary: string;
  readonly description?: string;
  // Every operation requires an API token in `Authorization: Bearer`.
  readonly security: "bearer";
  readonly pathParams?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  // The 200 response body.
  readonly response: z.ZodType;
  readonly errors: readonly ErrorCode[];
}

const LIST_ERRORS = ["invalid", "unauthenticated", "rate_limited"] as const;
const READ_ERRORS = ["invalid", "unauthenticated", "not_found", "rate_limited"] as const;
const WRITE_ERRORS = [
  "invalid",
  "unauthenticated",
  "not_found",
  "conflict",
  "locked",
  "rate_limited",
] as const;

export const ROUTES = [
  {
    id: "decisions.list",
    method: "get",
    path: "/v1/decisions",
    summary: "List decisions",
    description:
      "Filters by state and topic. A topic filter also matches decisions under it: `a/b` matches `a/b/c` but not `a/bc`.",
    security: "bearer",
    query: decisionListQuerySchema,
    response: decisionPageSchema,
    errors: LIST_ERRORS,
  },
  {
    id: "decisions.get",
    method: "get",
    path: "/v1/decisions/{decision_id}",
    summary: "Get a decision",
    security: "bearer",
    pathParams: decisionPathSchema,
    response: decisionSchema,
    errors: READ_ERRORS,
  },
  {
    id: "decisions.answer",
    method: "post",
    path: "/v1/decisions/{decision_id}/answer",
    summary: "Answer a decision",
    description:
      "The answer must be valid for the decision's input type and options. The server applies the same validation, state, and concurrency rules as every other surface and records `answered_via` as `api`.",
    security: "bearer",
    pathParams: decisionPathSchema,
    body: answerSubmissionSchema,
    response: decisionSchema,
    errors: WRITE_ERRORS,
  },
  {
    id: "decisions.cancel",
    method: "post",
    path: "/v1/decisions/{decision_id}/cancel",
    summary: "Cancel a decision",
    security: "bearer",
    pathParams: decisionPathSchema,
    response: decisionSchema,
    errors: WRITE_ERRORS,
  },
  {
    id: "agent_sessions.list",
    method: "get",
    path: "/v1/agent-sessions",
    summary: "List agent sessions",
    security: "bearer",
    query: agentSessionListQuerySchema,
    response: agentSessionPageSchema,
    errors: LIST_ERRORS,
  },
  {
    id: "agent_sessions.get",
    method: "get",
    path: "/v1/agent-sessions/{agent_session_id}",
    summary: "Get an agent session",
    security: "bearer",
    pathParams: agentSessionPathSchema,
    response: agentSessionSchema,
    errors: READ_ERRORS,
  },
] as const satisfies readonly RouteDefinition[];

export type RouteId = (typeof ROUTES)[number]["id"];
