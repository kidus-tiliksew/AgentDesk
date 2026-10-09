import {
  type AgentSession,
  agentSessionListQuerySchema,
  agentSessionPageSchema,
  agentSessionSchema,
  answerSubmissionSchema,
  type Decision,
  decisionListQuerySchema,
  decisionPageSchema,
  decisionSchema,
  ERROR_CODES,
  ERROR_STATUS,
  ROUTES,
  type RouteDefinition,
} from "@agentdesk/contract";
import { describe, expect, test } from "vitest";

// component-contract §Route table and specification;
// req-public-api-and-webhooks REQ-2.

const decision: Decision = {
  id: "d1",
  topic: "repo/x",
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
  agent_session_id: null,
  created_at: "2026-01-01T00:00:00Z",
};

const session: AgentSession = {
  id: "s1",
  display_name: "Claude Code · repo/x",
  topic: "repo/x",
  state: null,
  line: null,
  link: null,
  status_at: null,
  last_activity_at: "2026-01-01T00:00:00Z",
  stale: false,
  ended_at: null,
  pending_decision_count: 0,
};

const routes: readonly RouteDefinition[] = ROUTES;

const byId = (id: string): RouteDefinition => {
  const route = routes.find((r) => r.id === id);
  if (route === undefined) throw new Error(`no route ${id}`);
  return route;
};

describe("route table", () => {
  test("lists exactly the six REQ-2 operations", () => {
    expect(ROUTES.map((r) => [r.id, r.method, r.path])).toEqual([
      ["decisions.list", "get", "/v1/decisions"],
      ["decisions.get", "get", "/v1/decisions/{decision_id}"],
      ["decisions.answer", "post", "/v1/decisions/{decision_id}/answer"],
      ["decisions.cancel", "post", "/v1/decisions/{decision_id}/cancel"],
      ["agent_sessions.list", "get", "/v1/agent-sessions"],
      ["agent_sessions.get", "get", "/v1/agent-sessions/{agent_session_id}"],
    ]);
  });

  test("route ids and method/path pairs are unique", () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
  });

  test.each(routes.map((r) => [r.id, r] as const))("%s declares its path parameters", (_, r) => {
    const templated = [...r.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    const declared = Object.keys(r.pathParams?.shape ?? {});
    expect(declared).toEqual(templated);
  });

  test("every operation requires a bearer token", () => {
    for (const r of ROUTES) expect(r.security, r.id).toBe("bearer");
  });

  test("only answer carries a request body, and it is the answer submission", () => {
    expect(routes.filter((r) => r.body !== undefined).map((r) => r.id)).toEqual([
      "decisions.answer",
    ]);
    expect(byId("decisions.answer")).toHaveProperty("body", answerSubmissionSchema);
  });

  test("responses use the contract's read shapes", () => {
    expect(Object.fromEntries(ROUTES.map((r) => [r.id, r.response]))).toEqual({
      "decisions.list": decisionPageSchema,
      "decisions.get": decisionSchema,
      "decisions.answer": decisionSchema,
      "decisions.cancel": decisionSchema,
      "agent_sessions.list": agentSessionPageSchema,
      "agent_sessions.get": agentSessionSchema,
    });
  });

  test("errors per operation", () => {
    expect(Object.fromEntries(ROUTES.map((r) => [r.id, r.errors]))).toEqual({
      "decisions.list": ["invalid", "unauthenticated", "rate_limited"],
      "decisions.get": ["invalid", "unauthenticated", "not_found", "rate_limited"],
      "decisions.answer": [
        "invalid",
        "unauthenticated",
        "not_found",
        "conflict",
        "locked",
        "rate_limited",
      ],
      "decisions.cancel": [
        "invalid",
        "unauthenticated",
        "not_found",
        "conflict",
        "locked",
        "rate_limited",
      ],
      "agent_sessions.list": ["invalid", "unauthenticated", "rate_limited"],
      "agent_sessions.get": ["invalid", "unauthenticated", "not_found", "rate_limited"],
    });
  });
});

describe("error statuses", () => {
  test("map every error code to its HTTP status", () => {
    expect(ERROR_STATUS).toEqual({
      invalid: 400,
      unauthenticated: 401,
      not_found: 404,
      conflict: 409,
      locked: 409,
      rate_limited: 429,
    });
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe("list queries", () => {
  test.each([
    ["decisions", decisionListQuerySchema],
    ["agent sessions", agentSessionListQuerySchema],
  ] as const)("%s: limit defaults to 50 and accepts 1 to 100", (_, schema) => {
    expect(schema.parse({})).toEqual({ limit: 50 });
    for (const limit of [1, 100]) expect(schema.safeParse({ limit }).success).toBe(true);
    for (const limit of [0, 101, 1.5, "10"])
      expect(schema.safeParse({ limit }).success).toBe(false);
  });

  test.each([
    ["decisions", decisionListQuerySchema],
    ["agent sessions", agentSessionListQuerySchema],
  ] as const)("%s: the cursor is a nonempty string", (_, schema) => {
    expect(schema.parse({ cursor: "c" })).toEqual({ cursor: "c", limit: 50 });
    expect(schema.safeParse({ cursor: "" }).success).toBe(false);
  });

  test("decisions filter by each state", () => {
    for (const state of ["pending", "answered", "expired", "cancelled"]) {
      expect(decisionListQuerySchema.parse({ state }).state).toBe(state);
    }
    expect(decisionListQuerySchema.safeParse({ state: "open" }).success).toBe(false);
  });

  test("the decision topic filter is normalized like every other topic", () => {
    expect(decisionListQuerySchema.parse({ topic: "Repo/X" }).topic).toBe("repo/x");
    expect(decisionListQuerySchema.safeParse({ topic: "a b" }).success).toBe(false);
    expect(decisionListQuerySchema.safeParse({ topic: "" }).success).toBe(false);
  });

  test("agent sessions take no state or topic filter", () => {
    expect(agentSessionListQuerySchema.parse({ state: "pending", topic: "a" })).toEqual({
      limit: 50,
    });
  });
});

describe("path parameters", () => {
  test.each(routes.flatMap((r) => (r.pathParams ? [[r.id, r.pathParams] as const] : [])))(
    "%s requires a nonempty id",
    (_, params) => {
      const [name] = Object.keys(params.shape);
      expect(params.safeParse({ [name as string]: "x" }).success).toBe(true);
      expect(params.safeParse({ [name as string]: "" }).success).toBe(false);
      expect(params.safeParse({}).success).toBe(false);
    },
  );
});

describe("pages", () => {
  test("a decision page carries decisions and a cursor or null", () => {
    expect(decisionPageSchema.parse({ items: [decision], next_cursor: "c" })).toEqual({
      items: [decision],
      next_cursor: "c",
    });
    expect(decisionPageSchema.safeParse({ items: [], next_cursor: null }).success).toBe(true);
    expect(decisionPageSchema.safeParse({ items: [] }).success).toBe(false);
    expect(decisionPageSchema.safeParse({ items: [session], next_cursor: null }).success).toBe(
      false,
    );
  });

  test("an agent session page carries sessions and a cursor or null", () => {
    expect(agentSessionPageSchema.safeParse({ items: [session], next_cursor: null }).success).toBe(
      true,
    );
    expect(agentSessionPageSchema.safeParse({ items: [], next_cursor: "" }).success).toBe(false);
  });
});

describe("answer body", () => {
  test("is an answer with an optional note of at most 2,000 characters", () => {
    const body = byId("decisions.answer").body;
    expect(body?.safeParse({ answer: { kind: "approve" } }).success).toBe(true);
    expect(body?.safeParse({ answer: { kind: "approve" }, note: "x".repeat(2000) }).success).toBe(
      true,
    );
    expect(body?.safeParse({ answer: { kind: "approve" }, note: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(body?.safeParse({ note: "x" }).success).toBe(false);
  });
});
