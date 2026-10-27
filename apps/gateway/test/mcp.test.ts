import { describe, expect, it, vi } from "vitest";
import { ServiceError, type ServiceRoute, UpstreamError } from "../src/convex.js";
import { handle } from "../src/index.js";
import {
  CREDENTIAL,
  env,
  fakeConvex,
  mcpRequest,
  rpc,
  SESSION,
  TOKEN,
  TRANSPORT_ROUTES,
  USER,
} from "./fake.js";

function initialize(protocolVersion: string) {
  return rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.0" },
  });
}

// Initialization carries no session and no protocol version header yet.
const FIRST = { "Mcp-Session-Id": null, "MCP-Protocol-Version": null };

function authenticated(method: string, headers: Record<string, string> = {}): Request {
  return new Request("https://agentdesk.example/mcp", {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

describe("initialize", () => {
  it.each([
    ["2025-06-18", "2025-06-18"],
    ["2025-11-25", "2025-11-25"],
    ["2024-11-05", "2025-11-25"],
  ])("answers a client asking for %s with %s", async (requested, answered) => {
    const convex = fakeConvex();

    const response = await handle(mcpRequest(initialize(requested), FIRST), env, convex.svc);

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBe(SESSION);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: answered,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentdesk", version: "0.0.0" },
      },
    });
  });

  it("opens the session for the resolved user and credential with the client's name", async () => {
    const convex = fakeConvex();

    await handle(mcpRequest(initialize("2025-11-25"), FIRST), env, convex.svc);

    expect(convex.calls[1]).toEqual({
      route: "agents/open",
      body: {
        userId: USER,
        credentialId: CREDENTIAL,
        clientName: "claude-code",
        clientVersion: "2.1.0",
      },
    });
    expect(convex.routes()).toEqual(["identity/resolve-token", "agents/open"]);
  });

  it("rejects initialize without clientInfo and opens nothing", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("initialize", { protocolVersion: "2025-11-25" }), FIRST),
      env,
      convex.svc,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });
});

describe("sessions", () => {
  it("requires Mcp-Session-Id after initialization", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("tools/list"), { "Mcp-Session-Id": null }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(400);
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("answers an unknown session id with 404", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("tools/list", undefined, 9), { "Mcp-Session-Id": "mcp_session_unknown" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ id: 9, error: { code: -32001 } });
  });

  it("answers another user's session id with 404", async () => {
    // Convex holds mcp_session_b for user_b and refuses it to anyone else, as
    // `agents/session` does. The caller is user_a.
    const owners: Record<string, string> = { [SESSION]: USER, mcp_session_b: "user_b" };
    const convex = fakeConvex({
      "agents/session": (body) => {
        if (owners[String(body.mcpSessionId)] !== body.userId) {
          throw new ServiceError("not_found", "Not found");
        }
        return { agentSessionId: `agent_${body.mcpSessionId}` };
      },
    });

    const response = await handle(
      mcpRequest(rpc("tools/list"), { "Mcp-Session-Id": "mcp_session_b" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(404);
    expect(convex.calls[1]).toEqual({
      route: "agents/session",
      body: { userId: USER, mcpSessionId: "mcp_session_b" },
    });
  });

  it("resolves the session from Convex on every request, so any Worker instance serves it", async () => {
    const first = fakeConvex();
    const second = fakeConvex();

    expect((await handle(mcpRequest(rpc("ping")), env, first.svc)).status).toBe(200);
    expect((await handle(mcpRequest(rpc("ping")), env, second.svc)).status).toBe(200);
    expect(first.routes()).toEqual(TRANSPORT_ROUTES);
    expect(second.routes()).toEqual(TRANSPORT_ROUTES);
  });
});

describe("HTTP methods and message kinds", () => {
  it("accepts a client notification with 202", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(convex.routes()).toEqual(TRANSPORT_ROUTES);
  });

  it.each([
    ["a result", { jsonrpc: "2.0", id: 4, result: {} }],
    ["an error", { jsonrpc: "2.0", id: 4, error: { code: -1, message: "declined" } }],
  ])("accepts a client response carrying %s with 202", async (_name, body) => {
    const response = await handle(mcpRequest(body), env, fakeConvex().svc);

    expect(response.status).toBe(202);
  });

  it("answers an authenticated GET with 405", async () => {
    const response = await handle(
      authenticated("GET", { Accept: "text/event-stream" }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, DELETE");
  });

  it("answers an unauthenticated GET with 401", async () => {
    const response = await handle(
      new Request("https://agentdesk.example/mcp"),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(401);
  });

  it("answers DELETE of the caller's session with 200", async () => {
    const convex = fakeConvex();

    const response = await handle(
      authenticated("DELETE", { "Mcp-Session-Id": SESSION }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(200);
    expect(convex.routes()).toEqual(TRANSPORT_ROUTES);
  });

  it("answers DELETE of an unknown session with 404", async () => {
    const response = await handle(
      authenticated("DELETE", { "Mcp-Session-Id": "mcp_session_unknown" }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(404);
  });

  it.each(["2025-06-18", "2025-11-25"])(
    "answers DELETE with MCP-Protocol-Version %s",
    async (version) => {
      const response = await handle(
        authenticated("DELETE", { "Mcp-Session-Id": SESSION, "MCP-Protocol-Version": version }),
        env,
        fakeConvex().svc,
      );

      expect(response.status).toBe(200);
    },
  );

  it("rejects DELETE with an unsupported MCP-Protocol-Version before resolving the session", async () => {
    const convex = fakeConvex();

    const response = await handle(
      authenticated("DELETE", { "Mcp-Session-Id": SESSION, "MCP-Protocol-Version": "2024-11-05" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(400);
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("answers any other path with 404", async () => {
    const response = await handle(
      new Request("https://agentdesk.example/v2/decisions"),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(404);
  });
});

describe("JSON-RPC envelopes", () => {
  it.each([
    ["a string", "abc"],
    ["a number", 7],
  ])("preserves %s request id", async (_name, id) => {
    const response = await handle(mcpRequest(rpc("ping", undefined, id)), env, fakeConvex().svc);

    expect(await response.json()).toEqual({ jsonrpc: "2.0", id, result: {} });
  });

  it("answers a body that is not JSON with a parse error", async () => {
    const convex = fakeConvex();

    const response = await handle(mcpRequest("{not json"), env, convex.svc);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it.each([
    ["a wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["a null id on a request", { jsonrpc: "2.0", id: null, method: "ping" }],
    ["a batch", [{ jsonrpc: "2.0", id: 1, method: "ping" }]],
    ["a non-object", 42],
    ["params that are not an object", { jsonrpc: "2.0", id: 1, method: "ping", params: [1] }],
  ])("answers %s with an invalid request error", async (_name, body) => {
    const response = await handle(mcpRequest(body), env, fakeConvex().svc);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("answers an unknown method with method not found and its id", async () => {
    const response = await handle(
      mcpRequest(rpc("resources/list", undefined, "r1")),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "r1", error: { code: -32601 } });
  });

  it("answers a call to an unknown tool with invalid params", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("tools/call", { name: "answer", arguments: {} })),
      env,
      convex.svc,
    );

    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(convex.routes()).toEqual(TRANSPORT_ROUTES);
  });
});

describe("transport headers", () => {
  it("rejects an unsupported MCP-Protocol-Version with 400", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("tools/list"), { "MCP-Protocol-Version": "2024-11-05" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(400);
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it.each(["2025-06-18", "2025-11-25"])("accepts MCP-Protocol-Version %s", async (version) => {
    const response = await handle(
      mcpRequest(rpc("ping"), { "MCP-Protocol-Version": version }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(200);
  });

  it("accepts a request without MCP-Protocol-Version", async () => {
    const response = await handle(
      mcpRequest(rpc("ping"), { "MCP-Protocol-Version": null }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(200);
  });

  it("rejects a foreign Origin with 403 before resolving the credential", async () => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("ping"), { Origin: "https://attacker.example" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(403);
    expect(convex.calls).toEqual([]);
  });

  it.each([
    ["PUBLIC_ORIGIN", "https://agentdesk.example"],
    ["no Origin", null],
  ])("accepts a request with %s", async (_name, origin) => {
    const response = await handle(
      mcpRequest(rpc("ping"), { Origin: origin }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(200);
  });

  it("accepts the Worker's own origin under wrangler dev", async () => {
    const request = new Request("http://localhost:8787/mcp", mcpRequest(rpc("ping")));
    request.headers.set("Origin", "http://localhost:8787");

    const response = await handle(request, env, fakeConvex().svc);

    expect(response.status).toBe(200);
  });

  it("rejects a body that is not JSON-typed with 415", async () => {
    const response = await handle(
      mcpRequest(rpc("ping"), { "Content-Type": "text/plain" }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(415);
  });

  it("rejects an Accept header that excludes JSON with 406", async () => {
    const response = await handle(
      mcpRequest(rpc("ping"), { Accept: "text/html" }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(406);
  });
});

// Once a body parses as a JSON-RPC request, a failure at any step answers a
// JSON-RPC error carrying the request's id: `unavailable` for an outage, the
// service's own code for a refusal, and "Internal error" for a gateway fault.
describe("failures after parsing", () => {
  const STEPS = [
    ["identity resolution", "identity/resolve-token", () => rpc("tools/list"), {}],
    ["initialize", "agents/open", () => initialize("2025-11-25"), FIRST],
    ["session lookup", "agents/session", () => rpc("ping"), {}],
    [
      "a non-await tool call",
      "decisions/check",
      () => rpc("tools/call", { name: "check", arguments: { decision_ids: ["d1"] } }),
      {},
    ],
  ] as const;

  const IDS = [7, "req-7"] as const;

  function failing(route: ServiceRoute, failure: Error) {
    return fakeConvex({
      [route]: () => {
        throw failure;
      },
    });
  }

  async function send(
    body: { jsonrpc: string; id: string | number; method: string },
    headers: Record<string, string | null>,
    id: string | number,
    convex: ReturnType<typeof fakeConvex>,
  ) {
    const response = await handle(mcpRequest({ ...body, id }, headers), env, convex.svc);
    const text = await response.text();
    return { response, text, json: JSON.parse(text) as unknown };
  }

  describe.each(STEPS)("during %s", (_, route, body, headers) => {
    it.each(IDS)("answers an outage with unavailable and id %j", async (id) => {
      const convex = failing(route, new UpstreamError(`Service call ${route} timed out`));

      const { response, text, json } = await send(body(), headers, id, convex);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(json).toEqual({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: "AgentDesk is temporarily unavailable",
          data: { code: "unavailable" },
        },
      });
      expect(text).not.toContain(route);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(env.SERVICE_SECRET);
    });

    it.each(IDS)("answers an unexpected fault with Internal error and id %j", async (id) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const convex = failing(route, new Error(`stack at /svc/${route} with ${env.SERVICE_SECRET}`));

      const { response, text, json } = await send(body(), headers, id, convex);

      expect(response.status).toBe(200);
      expect(json).toEqual({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Internal error" },
      });
      expect(text).not.toContain("/svc/");
      expect(text).not.toContain(env.SERVICE_SECRET);
      vi.restoreAllMocks();
    });
  });

  describe.each(STEPS.filter(([, route]) => route !== "decisions/check"))(
    "a service refusal during %s",
    (_, route, body, headers) => {
      it.each(IDS)("keeps its own code, not unavailable, with id %j", async (id) => {
        const convex = failing(
          route,
          new ServiceError("rate_limited", `rate_limited at /svc/${route}`),
        );

        const { response, text, json } = await send(body(), headers, id, convex);

        expect(response.status).toBe(200);
        expect(json).toEqual({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: "Too many requests; try again later",
            data: { code: "rate_limited" },
          },
        });
        expect(text).not.toContain("unavailable");
        expect(text).not.toContain("/svc/");
      });
    },
  );

  it("names clientInfo when initialize is refused on the client name", async () => {
    const convex = failing(
      "agents/open",
      new ServiceError(
        "invalid",
        "Too big: expected string to have <=100 characters",
        "clientName",
      ),
    );

    const { json, text } = await send(initialize("2025-11-25"), FIRST, 1, convex);

    expect(json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message: "AgentDesk refused the request as invalid: clientInfo.name",
        data: { code: "invalid", field: "clientInfo.name" },
      },
    });
    expect(text).not.toContain("clientName");
  });

  it("leaves out a refusal's internal field during session lookup", async () => {
    const convex = failing(
      "agents/session",
      new ServiceError("invalid", "Invalid userId", "userId"),
    );

    const { json, text } = await send(rpc("ping"), {}, 2, convex);

    expect(json).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32603,
        message: "AgentDesk refused the request as invalid",
        data: { code: "invalid" },
      },
    });
    expect(text).not.toContain("userId");
  });

  it("keeps a tool's service refusal in the tool result", async () => {
    const convex = failing("decisions/check", new ServiceError("not_found", "Decision not found"));

    const { response, json } = await send(
      rpc("tools/call", { name: "check", arguments: { decision_ids: ["d1"] } }),
      {},
      "c1",
      convex,
    );

    expect(response.status).toBe(200);
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: "c1",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: { code: "not_found", message: "Decision not found", field: "decision_ids" },
            }),
          },
        ],
        isError: true,
      },
    });
  });

  it("keeps 404 and -32001 for an unknown session", async () => {
    const response = await handle(
      mcpRequest(rpc("ping", undefined, 5), { "Mcp-Session-Id": "mcp_session_other" }),
      env,
      fakeConvex().svc,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32001, message: "Session not found" },
    });
  });

  it("answers a failing notification without inventing an id", async () => {
    const convex = failing(
      "agents/session",
      new UpstreamError("Service call agents/session failed"),
    );

    const response = await handle(
      mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
    });
  });
});
