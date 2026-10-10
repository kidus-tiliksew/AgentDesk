import { agentSessionSchema, errorBodySchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";

const SECRET = "test-service-secret";

// The modules map includes convex/http.ts, so t.fetch reaches each route
// through the real router.
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const otherUserId = await ctx.db.insert("users", {
      clerkUserId: "user_b",
      email: "b@example.com",
    });
    const credentialId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: "0".repeat(64),
    });
    return { userId, otherUserId, credentialId };
  });
  return { t, ...ids };
}

type T = ReturnType<typeof convexTest>;

function post(t: T, path: string, body: unknown, authorization = `Bearer ${SECRET}`) {
  return t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  return errorBodySchema.parse(await response.json()).error;
}

async function open(t: T, userId: string, credentialId: string) {
  const response = await post(t, "/svc/agents/open", {
    userId,
    credentialId,
    clientName: "Claude Code",
    clientVersion: "2.1.0",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { agentSessionId: string; mcpSessionId: string };
}

beforeEach(() => {
  vi.stubEnv("SERVICE_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/svc/agents/open", () => {
  test("returns 200 with the session and mcp session ids", async () => {
    const { t, userId, credentialId } = await setup();

    const opened = await open(t, userId, credentialId);

    expect(opened.mcpSessionId).toMatch(/^[0-9a-f]{64}$/);
    const session = await t.run((ctx) =>
      ctx.db
        .query("agentSessions")
        .withIndex("by_mcp", (q) => q.eq("mcpSessionId", opened.mcpSessionId))
        .unique(),
    );
    expect(session?._id).toBe(opened.agentSessionId);
    expect(session?.activatedAt).toBeUndefined();
  });

  test("returns 401 for a wrong secret without opening", async () => {
    const { t, userId, credentialId } = await setup();

    const response = await post(
      t,
      "/svc/agents/open",
      { userId, credentialId, clientName: "Claude Code", clientVersion: "2.1.0" },
      `Bearer ${SECRET}x`,
    );

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
    expect(await t.run((ctx) => ctx.db.query("agentSessions").collect())).toHaveLength(0);
  });

  test("returns 400 naming the missing field", async () => {
    const { t, userId } = await setup();

    const response = await post(t, "/svc/agents/open", { userId, clientName: "Claude Code" });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "credentialId" });
  });
});

describe("/svc/agents/status", () => {
  test("returns 200 with the AgentSession read shape", async () => {
    const { t, userId, credentialId } = await setup();
    const { agentSessionId } = await open(t, userId, credentialId);

    const response = await post(t, "/svc/agents/status", {
      userId,
      agentSessionId,
      topic: "Repo/X",
      state: "working",
      line: "Reading the plan",
      link: "https://example.com/plan",
    });

    expect(response.status).toBe(200);
    expect(agentSessionSchema.parse(await response.json())).toMatchObject({
      id: agentSessionId,
      display_name: "Claude Code · repo/x",
      topic: "repo/x",
      state: "working",
      line: "Reading the plan",
      link: "https://example.com/plan",
      stale: false,
      ended_at: null,
      pending_decision_count: 0,
    });
  });

  test("returns 401 for a wrong secret", async () => {
    const { t, userId, credentialId } = await setup();
    const { agentSessionId } = await open(t, userId, credentialId);

    const response = await post(
      t,
      "/svc/agents/status",
      { userId, agentSessionId, topic: "repo/x", state: "working", line: "x" },
      "Bearer nope",
    );

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  test("returns 400 naming the field for a malformed body and for an invalid state", async () => {
    const { t, userId, credentialId } = await setup();
    const { agentSessionId } = await open(t, userId, credentialId);

    const malformed = await post(t, "/svc/agents/status", { userId, agentSessionId });
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({ code: "invalid", field: "topic" });

    const invalid = await post(t, "/svc/agents/status", {
      userId,
      agentSessionId,
      topic: "repo/x",
      state: "sleeping",
      line: "x",
    });
    expect(invalid.status).toBe(400);
    expect(await errorOf(invalid)).toMatchObject({ code: "invalid", field: "state" });
  });

  // req-agent-tools AC-7.1
  test("returns 404 for another user's session", async () => {
    const { t, userId, otherUserId, credentialId } = await setup();
    const { agentSessionId } = await open(t, userId, credentialId);

    const response = await post(t, "/svc/agents/status", {
      userId: otherUserId,
      agentSessionId,
      topic: "repo/x",
      state: "working",
      line: "x",
    });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });
});

describe("/svc/agents/session", () => {
  test("returns 200 with the agentSessionId", async () => {
    const { t, userId, credentialId } = await setup();
    const { agentSessionId, mcpSessionId } = await open(t, userId, credentialId);

    const response = await post(t, "/svc/agents/session", { userId, mcpSessionId });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agentSessionId });
  });

  test("returns 401 for a wrong secret", async () => {
    const { t, userId } = await setup();

    const response = await post(
      t,
      "/svc/agents/session",
      { userId, mcpSessionId: "a".repeat(64) },
      "Bearer nope",
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 naming the field for a malformed body", async () => {
    const { t, userId } = await setup();

    const response = await post(t, "/svc/agents/session", { userId, mcpSessionId: "" });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "mcpSessionId" });
  });

  // req-agent-tools AC-7.1
  test("returns 404 for another user's or an unknown mcpSessionId", async () => {
    const { t, userId, otherUserId, credentialId } = await setup();
    const { mcpSessionId } = await open(t, userId, credentialId);

    const foreign = await post(t, "/svc/agents/session", { userId: otherUserId, mcpSessionId });
    expect(foreign.status).toBe(404);
    expect((await errorOf(foreign)).code).toBe("not_found");

    const unknown = await post(t, "/svc/agents/session", { userId, mcpSessionId: "f".repeat(64) });
    expect(unknown.status).toBe(404);
  });
});
