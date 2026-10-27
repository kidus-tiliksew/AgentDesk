import { agentSessionPageSchema, agentSessionSchema, errorBodySchema } from "@agentdesk/contract";
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

// component-agent-presence §Service routes: the public HTTP API's agent
// session reads.
describe("public API routes", () => {
  const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Row = {
    owner?: "user" | "other";
    activated?: boolean;
    lastActivityAt: number;
    endedAt?: number;
    name: string;
  };

  // Inserts sessions as rows, so activity and end times are exact.
  async function seed(rows: Row[]) {
    const ctx = await setup();
    const ids = await ctx.t.run(async (db) => {
      const ids: Record<string, string> = {};
      for (const row of rows) {
        ids[row.name] = await db.db.insert("agentSessions", {
          userId: row.owner === "other" ? ctx.otherUserId : ctx.userId,
          credentialId: ctx.credentialId,
          mcpSessionId: row.name.padEnd(64, "0"),
          clientName: "Claude Code",
          clientVersion: "2.1.0",
          displayName: row.name,
          ...(row.activated === false ? {} : { activatedAt: NOW - DAY, topic: "repo/x" }),
          lastActivityAt: row.lastActivityAt,
          ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt, endReason: "done" }),
        });
      }
      return ids;
    });
    return { ...ctx, ids };
  }

  const page = agentSessionPageSchema;

  const rows: Row[] = [
    { name: "live-old", lastActivityAt: NOW - 30 * MINUTE },
    { name: "ended-new", lastActivityAt: NOW - 2 * MINUTE, endedAt: NOW - MINUTE },
    { name: "live-new", lastActivityAt: NOW - MINUTE },
    { name: "ended-old", lastActivityAt: NOW - DAY, endedAt: NOW - 2 * DAY },
    { name: "ended-purgeable", lastActivityAt: NOW - 9 * DAY, endedAt: NOW - 8 * DAY },
    { name: "initialized", activated: false, lastActivityAt: NOW },
    { name: "foreign-live", owner: "other", lastActivityAt: NOW },
    { name: "foreign-ended", owner: "other", lastActivityAt: NOW, endedAt: NOW - MINUTE },
  ];

  describe("/svc/agents/list", () => {
    test("lists live sessions in liveAgents order, then ended ones in recentAgents order", async () => {
      const { t, userId } = await seed(rows);

      const response = await post(t, "/svc/agents/list", { userId, limit: 50 });

      expect(response.status).toBe(200);
      const result = page.parse(await response.json());
      expect(result.items.map((s) => s.display_name)).toEqual([
        "live-new",
        "live-old",
        "ended-new",
        "ended-old",
      ]);
      expect(result.items.map((s) => s.ended_at === null)).toEqual([true, true, false, false]);
      expect(result.next_cursor).toBeNull();
    });

    test("pages across the live-to-ended boundary without duplicates or omissions", async () => {
      const { t, userId } = await seed(rows);
      const names: string[] = [];
      const cursors: (string | null)[] = [];
      let cursor: string | undefined;
      do {
        const response = await post(t, "/svc/agents/list", {
          userId,
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(response.status).toBe(200);
        const result = page.parse(await response.json());
        names.push(...result.items.map((s) => s.display_name));
        cursors.push(result.next_cursor);
        cursor = result.next_cursor ?? undefined;
      } while (cursor !== undefined && cursors.length < 5);

      expect(names).toEqual(["live-new", "live-old", "ended-new", "ended-old"]);
      expect(cursors.at(-1)).toBeNull();
      expect(cursors).toHaveLength(2);
    });

    test("an exactly full last page ends with a null cursor", async () => {
      const { t, userId } = await seed(rows);

      const response = await post(t, "/svc/agents/list", { userId, limit: 4 });

      expect(page.parse(await response.json()).next_cursor).toBeNull();
    });

    test("returns 400 naming cursor or limit, and 401 for a wrong secret", async () => {
      const { t, userId } = await seed(rows);

      const malformed = await post(t, "/svc/agents/list", { userId, cursor: "bad!", limit: 1 });
      const wrongShape = await post(t, "/svc/agents/list", {
        userId,
        cursor: btoa(JSON.stringify({ v: 2 })),
        limit: 1,
      });
      const limit = await post(t, "/svc/agents/list", { userId, limit: 101 });
      const secret = await post(t, "/svc/agents/list", { userId, limit: 1 }, "Bearer wrong");

      expect((await errorOf(malformed)).field).toBe("cursor");
      expect((await errorOf(wrongShape)).field).toBe("cursor");
      expect((await errorOf(limit)).field).toBe("limit");
      expect(secret.status).toBe(401);
    });
  });

  describe("/svc/agents/get", () => {
    test("returns an owned activated session, live or ended", async () => {
      const { t, userId, ids } = await seed(rows);

      for (const name of ["live-new", "ended-old"]) {
        const response = await post(t, "/svc/agents/get", {
          userId,
          agentSessionId: ids[name],
        });
        expect(response.status).toBe(200);
        expect(agentSessionSchema.parse(await response.json())).toMatchObject({
          id: ids[name],
          display_name: name,
          pending_decision_count: 0,
        });
      }
    });

    test("returns 404 for only-initialized, foreign, and missing sessions", async () => {
      const { t, userId, ids } = await seed(rows);
      const missing = ids["live-old"] as string;
      await t.run((ctx) => ctx.db.delete("agentSessions", missing as never));

      for (const agentSessionId of [ids.initialized, ids["foreign-live"], missing]) {
        const response = await post(t, "/svc/agents/get", { userId, agentSessionId });
        expect(response.status).toBe(404);
        expect(await errorOf(response)).toEqual({
          code: "not_found",
          message: "Agent session not found",
        });
      }
    });

    test("returns 400 naming agentSessionId for a malformed id", async () => {
      const { t, userId } = await seed(rows);

      const response = await post(t, "/svc/agents/get", { userId, agentSessionId: "nope" });

      expect(response.status).toBe(400);
      expect((await errorOf(response)).field).toBe("agentSessionId");
    });
  });
});
