import { type AgentSession, ROUTES, type RouteId } from "@agentdesk/contract";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/auth.js";
import { ServiceError, type ServiceRoute, UpstreamError } from "../src/convex.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { decision, env, fakeConvex, fakeLimiter, routeRequest, TOKEN, USER } from "./fake.js";

// component-gateway §Public HTTP API: the `/v1` router, its API-token
// authentication, rate limit, validation, service calls, and error mapping.

const API_TOKEN = `adp_${"b".repeat(43)}`;
const API_CREDENTIAL = "cred_api";
// An `adp_` token whose credential identity reports as another kind.
const MISKIND_TOKEN = `adp_${"c".repeat(43)}`;
const DECISION = "decision_1";
const AGENT = "agent_session_a";

function agentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: AGENT,
    display_name: "Claude Code · repo/main",
    topic: "repo/main",
    state: "working",
    line: "Reading files",
    link: null,
    status_at: "2026-10-11T00:00:00.000Z",
    last_activity_at: "2026-10-11T00:00:00.000Z",
    stale: false,
    ended_at: null,
    pending_decision_count: 0,
    ...overrides,
  };
}

type Handler = (body: Record<string, unknown>) => unknown;

// The fake identity resolves the API token, the connection token, and the
// mis-kinded token; any other hash is unauthenticated, as for a revoked one.
function fakeApi(overrides: Partial<Record<ServiceRoute, Handler>> = {}) {
  return fakeConvex({
    "identity/resolve-token": async (body) => {
      if (body.token_hash === (await hashToken(API_TOKEN))) {
        return { userId: USER, credentialId: API_CREDENTIAL, kind: "api_token" };
      }
      if (body.token_hash === (await hashToken(MISKIND_TOKEN))) {
        return { userId: USER, credentialId: "cred_other", kind: "connection_token" };
      }
      if (body.token_hash === (await hashToken(TOKEN))) {
        return { userId: USER, credentialId: "cred_a", kind: "connection_token" };
      }
      throw new ServiceError("unauthenticated", "Invalid credential");
    },
    "decisions/list": () => ({ items: [decision()], next_cursor: null }),
    "decisions/get": () => decision(),
    "decisions/answer": () =>
      decision({ state: "answered", answer: { kind: "approve" }, answered_via: "api" }),
    "decisions/cancel": () => decision({ state: "cancelled" }),
    "agents/list": () => ({ items: [agentSession()], next_cursor: null }),
    "agents/get": () => agentSession(),
    ...overrides,
  });
}

function withLimit(limit = 120): Env {
  return { ...env, API_LIMIT: fakeLimiter(limit).binding };
}

function v1(method: string, path: string, body?: unknown, token: string | null = API_TOKEN) {
  return routeRequest(method, path, body, {
    Authorization: token === null ? null : `Bearer ${token}`,
  });
}

// One valid request per route, with the service route it calls and the body
// the gateway sends.
const CASES: Record<
  RouteId,
  { method: string; path: string; body?: unknown; route: ServiceRoute; sent: object }
> = {
  "decisions.list": {
    method: "GET",
    path: "/v1/decisions?state=pending&topic=Repo/Main&limit=10&cursor=abc",
    route: "decisions/list",
    sent: { userId: USER, state: "pending", topic: "repo/main", limit: 10, cursor: "abc" },
  },
  "decisions.get": {
    method: "GET",
    path: `/v1/decisions/${DECISION}`,
    route: "decisions/get",
    sent: { userId: USER, decisionId: DECISION },
  },
  "decisions.answer": {
    method: "POST",
    path: `/v1/decisions/${DECISION}/answer`,
    body: { answer: { kind: "approve" }, note: "Ship it" },
    route: "decisions/answer",
    sent: { userId: USER, decisionId: DECISION, answer: { kind: "approve" }, note: "Ship it" },
  },
  "decisions.cancel": {
    method: "POST",
    path: `/v1/decisions/${DECISION}/cancel`,
    route: "decisions/cancel",
    sent: { userId: USER, decisionId: DECISION },
  },
  "agent_sessions.list": {
    method: "GET",
    path: "/v1/agent-sessions?limit=5",
    route: "agents/list",
    sent: { userId: USER, limit: 5 },
  },
  "agent_sessions.get": {
    method: "GET",
    path: `/v1/agent-sessions/${AGENT}`,
    route: "agents/get",
    sent: { userId: USER, agentSessionId: AGENT },
  },
};

const IDS = ROUTES.map((route) => route.id);

function request(id: RouteId, token: string | null = API_TOKEN) {
  const { method, path, body } = CASES[id];
  return v1(method, path, body, token);
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; field?: string } })
    .error;
}

describe("routing", () => {
  it("serves exactly the contract's route ids", () => {
    expect(Object.keys(CASES).sort()).toEqual([...IDS].sort());
  });

  it.each([
    ["DELETE", "/v1/decisions"],
    ["POST", "/v1/decisions"],
    ["GET", "/v1/decisions/decision_1/answer"],
    ["GET", "/v1/decisions/"],
    ["GET", "/v1/unknown"],
    ["GET", "/v1/agent-sessions/a/b"],
  ])("answers %s %s with 404 and calls nothing", async (method, path) => {
    const convex = fakeApi();

    const response = await handle(v1(method, path), withLimit(), convex.svc);

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({ code: "not_found", message: "Not found" });
    expect(convex.calls).toEqual([]);
  });
});

describe.each(IDS)("%s", (id) => {
  const { route, sent } = CASES[id];

  it("answers 200 with the route's response after one service call", async () => {
    const convex = fakeApi();

    const response = await handle(request(id), withLimit(), convex.svc);

    expect(response.status).toBe(200);
    const definition = ROUTES.find((r) => r.id === id);
    expect(definition?.response.safeParse(await response.json()).success).toBe(true);
    expect(convex.routes()).toEqual(["identity/resolve-token", route]);
    expect(convex.calls[1]?.body).toEqual(sent);
  });

  // req-public-api-and-webhooks AC-3.2
  it.each([
    ["no credential", null],
    ["a malformed API token", "adp_not/base64url"],
    ["an unknown or revoked API token", `adp_${"d".repeat(43)}`],
    ["a connection token", TOKEN],
    ["an API token resolving to another kind", MISKIND_TOKEN],
  ])("answers 401 for %s and calls no domain route", async (_name, token) => {
    const convex = fakeApi();

    const response = await handle(request(id, token), withLimit(), convex.svc);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await errorOf(response)).code).toBe("unauthenticated");
    expect(convex.routes().filter((r) => r !== "identity/resolve-token")).toEqual([]);
  });

  it("answers 429 past the limit, keyed by the API credential", async () => {
    const convex = fakeApi();
    const limiter = fakeLimiter(1);
    const limited = { ...env, API_LIMIT: limiter.binding };

    const first = await handle(request(id), limited, convex.svc);
    const second = await handle(request(id), limited, convex.svc);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect((await errorOf(second)).code).toBe("rate_limited");
    expect(limiter.keys).toEqual([API_CREDENTIAL, API_CREDENTIAL]);
    expect(convex.routes().filter((r) => r === route)).toHaveLength(1);
  });

  it("answers 503 without the API_LIMIT binding and calls no domain route", async () => {
    const convex = fakeApi();

    const response = await handle(request(id), env, convex.svc);

    expect(response.status).toBe(503);
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("answers 503 on an outage and on a result of the wrong shape", async () => {
    const outage = fakeApi({
      [route]: () => {
        throw new UpstreamError("timed out");
      },
    });
    const wrongShape = fakeApi({ [route]: () => ({ unexpected: true }) });

    expect((await handle(request(id), withLimit(), outage.svc)).status).toBe(503);
    expect((await handle(request(id), withLimit(), wrongShape.svc)).status).toBe(503);
  });

  it("answers a service rate_limited with 429", async () => {
    const convex = fakeApi({
      [route]: () => {
        throw new ServiceError("rate_limited", "Slow down");
      },
    });

    expect((await handle(request(id), withLimit(), convex.svc)).status).toBe(429);
  });
});

describe("400", () => {
  it.each<[string, string, string, unknown, string]>([
    ["decisions.list state", "GET", "/v1/decisions?state=done", undefined, "state"],
    ["decisions.list topic", "GET", "/v1/decisions?topic=a%20b", undefined, "topic"],
    ["decisions.list limit", "GET", "/v1/decisions?limit=0", undefined, "limit"],
    ["decisions.list non-integer limit", "GET", "/v1/decisions?limit=ten", undefined, "limit"],
    ["decisions.list empty cursor", "GET", "/v1/decisions?cursor=", undefined, "cursor"],
    ["decisions.answer answer", "POST", "/v1/decisions/d/answer", { note: "x" }, "answer"],
    [
      "decisions.answer note",
      "POST",
      "/v1/decisions/d/answer",
      { answer: { kind: "approve" }, note: "x".repeat(2001) },
      "note",
    ],
    ["agent_sessions.list limit", "GET", "/v1/agent-sessions?limit=101", undefined, "limit"],
    ["agent_sessions.list cursor", "GET", "/v1/agent-sessions?cursor=", undefined, "cursor"],
  ])(
    "answers %s with 400 naming the field and calls no domain route",
    async (_n, method, path, body, field) => {
      const convex = fakeApi();

      const response = await handle(v1(method, path, body), withLimit(), convex.svc);

      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("invalid");
      expect(error.field).toBe(field);
      expect(convex.routes()).toEqual(["identity/resolve-token"]);
    },
  );

  it("answers a body that is not JSON with 400", async () => {
    const convex = fakeApi();

    const response = await handle(
      v1("POST", "/v1/decisions/d/answer", "{not json"),
      withLimit(),
      convex.svc,
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid");
  });

  it.each<[RouteId, string, string]>([
    ["decisions.get", "decisionId", "decision_id"],
    ["decisions.answer", "decisionId", "decision_id"],
    ["decisions.cancel", "decisionId", "decision_id"],
    ["agent_sessions.get", "agentSessionId", "agent_session_id"],
  ])("%s restates a malformed service id as %s", async (id, serviceField, publicField) => {
    const convex = fakeApi({
      [CASES[id].route]: () => {
        throw new ServiceError("invalid", `Invalid ${serviceField}`, serviceField);
      },
    });

    const response = await handle(request(id), withLimit(), convex.svc);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).field).toBe(publicField);
  });

  it.each([
    ["answer.kind", "answer.kind"],
    ["note", "note"],
    ["cursor", "cursor"],
    ["userId", undefined],
    ["somethingInternal", undefined],
  ])("keeps or hides the service field %s", async (serviceField, publicField) => {
    const convex = fakeApi({
      "decisions/answer": () => {
        throw new ServiceError("invalid", "Refused", serviceField);
      },
    });

    const response = await handle(request("decisions.answer"), withLimit(), convex.svc);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).field).toBe(publicField);
  });
});

describe("404", () => {
  it.each<RouteId>(["decisions.get", "decisions.answer", "decisions.cancel", "agent_sessions.get"])(
    "%s passes a service not_found through as 404",
    async (id) => {
      const convex = fakeApi({
        [CASES[id].route]: () => {
          throw new ServiceError("not_found", "Decision not found");
        },
      });

      const response = await handle(request(id), withLimit(), convex.svc);

      expect(response.status).toBe(404);
      expect(await errorOf(response)).toEqual({ code: "not_found", message: "Decision not found" });
    },
  );
});

describe("409", () => {
  it.each<RouteId>(["decisions.answer", "decisions.cancel"])(
    "%s answers a settled decision with 409 and the contract body",
    async (id) => {
      const convex = fakeApi({
        [CASES[id].route]: () => {
          throw new ServiceError("conflict", "Decision is already answered");
        },
      });

      const response = await handle(request(id), withLimit(), convex.svc);

      expect(response.status).toBe(409);
      expect(await errorOf(response)).toEqual({
        code: "conflict",
        message: "Decision is already answered",
      });
    },
  );

  // req-decision-requests AC-4.2: the service settles exactly one of two
  // concurrent answers; the gateway answers the other's conflict with 409.
  it("answers the loser of two concurrent answers with 409", async () => {
    let settled = false;
    const convex = fakeApi({
      "decisions/answer": (body) => {
        if (settled) {
          throw new ServiceError("conflict", "Decision is already answered");
        }
        settled = true;
        return decision({ state: "answered", answer: body.answer as never, answered_via: "api" });
      },
    });
    const limited = withLimit();

    const responses = await Promise.all(
      (["approve", "reject"] as const).map((kind) =>
        handle(
          v1("POST", `/v1/decisions/${DECISION}/answer`, { answer: { kind } }),
          limited,
          convex.svc,
        ),
      ),
    );

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe("decisions.list", () => {
  it("pages with next_cursor until it is null, keeping the filters", async () => {
    const pages = [
      { items: [decision({ id: "d3" }), decision({ id: "d2" })], next_cursor: "page2" },
      { items: [decision({ id: "d1" })], next_cursor: null },
    ];
    const convex = fakeApi({
      "decisions/list": (body) => (body.cursor === undefined ? pages[0] : pages[1]),
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${cursor}`;
      const response = await handle(
        v1("GET", `/v1/decisions?state=pending&topic=acme&limit=2${query}`),
        withLimit(),
        convex.svc,
      );
      const page = (await response.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      ids.push(...page.items.map((d) => d.id));
      cursor = page.next_cursor;
    } while (cursor !== null);

    expect(ids).toEqual(["d3", "d2", "d1"]);
    const listCalls = convex.calls.filter((c) => c.route === "decisions/list");
    expect(listCalls.map((c) => c.body)).toEqual([
      { userId: USER, state: "pending", topic: "acme", limit: 2 },
      { userId: USER, state: "pending", topic: "acme", limit: 2, cursor: "page2" },
    ]);
  });

  it("defaults limit to 50 and omits absent filters", async () => {
    const convex = fakeApi();

    await handle(v1("GET", "/v1/decisions"), withLimit(), convex.svc);

    expect(convex.calls[1]?.body).toEqual({ userId: USER, limit: 50 });
  });
});

describe("decisions.answer", () => {
  // req-public-api-and-webhooks AC-2.2
  it("forwards the answer and returns the decision answered through the API", async () => {
    const convex = fakeApi();

    const response = await handle(request("decisions.answer"), withLimit(), convex.svc);

    expect(await response.json()).toMatchObject({ state: "answered", answered_via: "api" });
    expect(convex.calls[1]).toMatchObject({
      route: "decisions/answer",
      body: { userId: USER, decisionId: DECISION, answer: { kind: "approve" } },
    });
  });

  it("drops body fields that name an identity", async () => {
    const convex = fakeApi();

    await handle(
      v1("POST", `/v1/decisions/${DECISION}/answer`, {
        answer: { kind: "approve" },
        userId: "user_other",
        answeredVia: "app",
      }),
      withLimit(),
      convex.svc,
    );

    expect(convex.calls[1]?.body).toEqual({
      userId: USER,
      decisionId: DECISION,
      answer: { kind: "approve" },
    });
  });
});
