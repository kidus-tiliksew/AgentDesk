import { agentSessionSchema, decisionSchema, errorBodySchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { decisions } from "./refs";

const SECRET = "test-service-secret";
const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;

const approve = { title: "Ship it?", input_type: "approve_reject", topic: "Repo/X" };

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

// The modules map includes convex/http.ts, so t.fetch reaches each route
// through the real router.
async function setup() {
  const t = convexTest(schema, modules);
  const { userId, otherUserId, credentialId } = await t.run(async (ctx) => {
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
  // An unactivated session, as MCP `initialize` leaves it.
  const open = async (owner: Id<"users"> = userId) =>
    (
      await t.mutation(agents.sessions.open, {
        userId: owner,
        credentialId,
        clientName: "Claude Code",
        clientVersion: "2.1.0",
      })
    ).agentSessionId;
  const session = (id: Id<"agentSessions">) => t.run((ctx) => ctx.db.get("agentSessions", id));
  const ask = async (agentSessionId: Id<"agentSessions">, input: object = approve) => {
    const response = await post(t, "/svc/decisions/create", { userId, agentSessionId, ...input });
    expect(response.status).toBe(200);
    return decisionSchema.parse(await response.json());
  };
  return { t, userId, otherUserId, open, session, ask };
}

beforeEach(() => {
  vi.stubEnv("SERVICE_SECRET", SECRET);
  // Only the clock is faked, so convex-test's own timers still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("/svc/decisions/create", () => {
  // req-agent-tools AC-2.1, AC-8.1; component-agent-presence §Lifecycle
  test("returns 200 with the Decision and activates the session with its topic", async () => {
    const { userId, open, session, ask } = await setup();
    const agentSessionId = await open();
    vi.setSystemTime(START + MINUTE);

    const decision = await ask(agentSessionId);

    expect(decision).toMatchObject({
      topic: "repo/x",
      state: "pending",
      priority: "normal",
      agent_session_id: agentSessionId,
    });
    expect(await session(agentSessionId)).toMatchObject({
      userId,
      topic: "repo/x",
      activatedAt: START + MINUTE,
      lastActivityAt: START + MINUTE,
    });
  });

  // req-agent-status AC-3.3 via touch: a stale mark and an idle end clear.
  test("clears a stale mark and an idle end on the session", async () => {
    const { t, open, session, ask } = await setup();
    const agentSessionId = await open();
    await ask(agentSessionId);
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", agentSessionId, {
        staleSince: START,
        endedAt: START,
        endReason: "idle",
      }),
    );
    vi.setSystemTime(START + 2 * MINUTE);

    await ask(agentSessionId);

    const touched = await session(agentSessionId);
    expect(touched?.lastActivityAt).toBe(START + 2 * MINUTE);
    expect(touched?.staleSince).toBeUndefined();
    expect(touched?.endedAt).toBeUndefined();
    expect(touched?.endReason).toBeUndefined();
  });

  test("returns 401 for a wrong secret and inserts nothing", async () => {
    const { t, userId, open } = await setup();
    const agentSessionId = await open();

    const response = await post(
      t,
      "/svc/decisions/create",
      { userId, agentSessionId, ...approve },
      "Bearer nope",
    );

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
    expect(await t.run((ctx) => ctx.db.query("decisions").collect())).toHaveLength(0);
  });

  test("returns 400 naming the field for a malformed body", async () => {
    const { t, userId, open } = await setup();
    const agentSessionId = await open();

    const noUser = await post(t, "/svc/decisions/create", { agentSessionId, ...approve });
    expect(noUser.status).toBe(400);
    expect(await errorOf(noUser)).toMatchObject({ code: "invalid", field: "userId" });

    const noTitle = await post(t, "/svc/decisions/create", {
      userId,
      agentSessionId,
      input_type: "approve_reject",
      topic: "repo/x",
    });
    expect(noTitle.status).toBe(400);
    expect(await errorOf(noTitle)).toMatchObject({ code: "invalid", field: "title" });
  });

  // req-agent-tools AC-1.3: a rejected ask changes no state, session included.
  test("returns 400 for a cross-field failure and rolls back the touch", async () => {
    const { t, userId, open, session } = await setup();
    const agentSessionId = await open();
    const before = await session(agentSessionId);
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/create", {
      userId,
      agentSessionId,
      ...approve,
      deadline: new Date(START).toISOString(),
    });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "deadline" });
    expect(await session(agentSessionId)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("decisions").collect())).toHaveLength(0);
  });

  // req-agent-tools AC-7.1
  test("returns 404 for another user's session", async () => {
    const { t, userId, otherUserId, open } = await setup();
    const foreignSession = await open(otherUserId);

    const response = await post(t, "/svc/decisions/create", {
      userId,
      agentSessionId: foreignSession,
      ...approve,
    });

    expect(response.status).toBe(404);
    expect(await t.run((ctx) => ctx.db.query("decisions").collect())).toHaveLength(0);
  });
});

describe("/svc/decisions/poll", () => {
  test("returns 200 with the Decision and touches the session", async () => {
    const { t, userId, open, session, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);
    // Another session of the same user reads it and is activated with its topic.
    const reader = await open();
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/poll", {
      userId,
      agentSessionId: reader,
      decisionId: decision.id,
    });

    expect(response.status).toBe(200);
    expect(decisionSchema.parse(await response.json())).toEqual(decision);
    expect(await session(reader)).toMatchObject({
      topic: "repo/x",
      activatedAt: START + MINUTE,
      lastActivityAt: START + MINUTE,
    });
  });

  test("returns 401 for a wrong secret", async () => {
    const { t, userId, open, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);

    const response = await post(
      t,
      "/svc/decisions/poll",
      { userId, agentSessionId, decisionId: decision.id },
      "Bearer nope",
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 naming the field for a malformed body and a malformed id", async () => {
    const { t, userId, open } = await setup();
    const agentSessionId = await open();

    const missing = await post(t, "/svc/decisions/poll", { userId, agentSessionId });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toMatchObject({ code: "invalid", field: "decisionId" });

    const malformed = await post(t, "/svc/decisions/poll", {
      userId,
      agentSessionId,
      decisionId: "nope",
    });
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({ code: "invalid", field: "decisionId" });
  });

  // req-agent-tools AC-7.1
  test("returns 404 for another user's decision and rolls back the touch", async () => {
    const { t, userId, otherUserId, open, session, ask } = await setup();
    const agentSessionId = await open();
    await ask(agentSessionId);
    const before = await session(agentSessionId);
    const foreignSession = await open(otherUserId);
    const foreignResponse = await post(t, "/svc/decisions/create", {
      userId: otherUserId,
      agentSessionId: foreignSession,
      ...approve,
    });
    const foreign = decisionSchema.parse(await foreignResponse.json());
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/poll", {
      userId,
      agentSessionId,
      decisionId: foreign.id,
    });

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({ code: "not_found", message: "Decision not found" });
    expect(await session(agentSessionId)).toEqual(before);
  });
});

describe("/svc/decisions/check", () => {
  // req-agent-tools AC-4.1
  test("returns 200 with each Decision in request order and touches the session", async () => {
    const { t, userId, open, session, ask } = await setup();
    const agentSessionId = await open();
    const a = await ask(agentSessionId);
    const b = await ask(agentSessionId, { ...approve, title: "Second" });
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId,
      decisionIds: [b.id, a.id],
    });

    expect(response.status).toBe(200);
    const body = decisionSchema.array().parse(await response.json());
    expect(body.map((d) => d.id)).toEqual([b.id, a.id]);
    expect((await session(agentSessionId))?.lastActivityAt).toBe(START + MINUTE);
  });

  test("an empty batch returns [] on an activated session and 400 on an unactivated one", async () => {
    const { t, userId, open, ask } = await setup();
    const activated = await open();
    await ask(activated);
    const unactivated = await open();

    const empty = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId: activated,
      decisionIds: [],
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const noTopic = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId: unactivated,
      decisionIds: [],
    });
    expect(noTopic.status).toBe(400);
    expect(await errorOf(noTopic)).toMatchObject({ code: "invalid", field: "topic" });
  });

  test("returns 401 for a wrong secret", async () => {
    const { t, userId, open } = await setup();
    const agentSessionId = await open();

    const response = await post(
      t,
      "/svc/decisions/check",
      { userId, agentSessionId, decisionIds: [] },
      "Bearer nope",
    );

    expect(response.status).toBe(401);
  });

  // req-agent-tools AC-4.2
  test("returns 400 for a malformed body and for more than 50 ids", async () => {
    const { t, userId, open, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);

    const malformed = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId,
      decisionIds: decision.id,
    });
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({ code: "invalid", field: "decisionIds" });

    const tooMany = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId,
      decisionIds: Array(51).fill(decision.id),
    });
    expect(tooMany.status).toBe(400);
    expect(await errorOf(tooMany)).toMatchObject({ code: "invalid", field: "decisionIds" });
  });

  // req-agent-tools AC-7.1
  test("returns 404 when any id belongs to another user", async () => {
    const { t, userId, otherUserId, open, ask } = await setup();
    const agentSessionId = await open();
    const mine = await ask(agentSessionId);
    const foreignSession = await open(otherUserId);
    const foreign = decisionSchema.parse(
      await (
        await post(t, "/svc/decisions/create", {
          userId: otherUserId,
          agentSessionId: foreignSession,
          ...approve,
        })
      ).json(),
    );

    const response = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId,
      decisionIds: [mine.id, foreign.id],
    });

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({ code: "not_found", message: "Decision not found" });
  });
});

describe("/svc/decisions/cancel", () => {
  // req-decision-requests AC-4.4
  test("with a session returns 200 with the cancelled Decision and touches the session", async () => {
    const { t, userId, open, session, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/cancel", {
      userId,
      agentSessionId,
      decisionId: decision.id,
    });

    expect(response.status).toBe(200);
    expect(decisionSchema.parse(await response.json())).toMatchObject({
      id: decision.id,
      state: "cancelled",
      answer: null,
    });
    expect((await session(agentSessionId))?.lastActivityAt).toBe(START + MINUTE);
  });

  test("without a session cancels and touches no session", async () => {
    const { t, userId, open, session, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);
    const before = await session(agentSessionId);
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/cancel", { userId, decisionId: decision.id });

    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("cancelled");
    expect(await session(agentSessionId)).toEqual(before);
  });

  // req-decision-requests AC-4.1
  test("returns 409 for a settled decision and rolls back the touch", async () => {
    const { t, userId, open, session, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);
    await post(t, "/svc/decisions/cancel", { userId, decisionId: decision.id });
    const before = await session(agentSessionId);
    vi.setSystemTime(START + MINUTE);

    const response = await post(t, "/svc/decisions/cancel", {
      userId,
      agentSessionId,
      decisionId: decision.id,
    });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({
      code: "conflict",
      message: "Decision is already cancelled",
    });
    expect(await session(agentSessionId)).toEqual(before);
  });

  test("returns 401 for a wrong secret and 400 for a malformed body", async () => {
    const { t, userId, open, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);

    const wrong = await post(
      t,
      "/svc/decisions/cancel",
      { userId, decisionId: decision.id },
      "Bearer nope",
    );
    expect(wrong.status).toBe(401);

    const malformed = await post(t, "/svc/decisions/cancel", { userId });
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({ code: "invalid", field: "decisionId" });
  });

  // req-agent-tools AC-7.1
  test("returns 404 for another user's decision", async () => {
    const { t, otherUserId, open, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId);

    const response = await post(t, "/svc/decisions/cancel", {
      userId: otherUserId,
      decisionId: decision.id,
    });

    expect(response.status).toBe(404);
  });
});

// req-agent-tools AC-7.3
test("no decision route accepts an answer", async () => {
  const { t, userId, open, ask } = await setup();
  const agentSessionId = await open();
  const decision = await ask(agentSessionId);

  const response = await post(t, "/svc/decisions/answer", {
    userId,
    decisionId: decision.id,
    answer: { kind: "approve" },
  });

  expect(response.status).toBe(404);
});

// component-decisions §Reads `pendingCountForAgent`, through the agent card
// read shape that /svc/agents/status returns.
describe("pending decision count", () => {
  test("counts only the session's pending decisions as they are created and settle", async () => {
    const { t, userId, open, ask } = await setup();
    const agentSessionId = await open();
    const otherSession = await open();
    const status = async (id: Id<"agentSessions">) => {
      const response = await post(t, "/svc/agents/status", {
        userId,
        agentSessionId: id,
        topic: "repo/x",
        state: "waiting",
        line: "Waiting on decisions",
      });
      expect(response.status).toBe(200);
      return agentSessionSchema.parse(await response.json()).pending_decision_count;
    };

    const answered = await ask(agentSessionId);
    const cancelled = await ask(agentSessionId);
    const expiring = await ask(agentSessionId, {
      ...approve,
      deadline: new Date(START + 10 * MINUTE).toISOString(),
    });
    await ask(otherSession);
    expect(await status(agentSessionId)).toBe(3);
    expect(await status(otherSession)).toBe(1);

    await t.mutation(decisions.devAnswer.answer, {
      decisionId: answered.id,
      answer: { kind: "approve" },
      answeredVia: "app",
    });
    expect(await status(agentSessionId)).toBe(2);

    await post(t, "/svc/decisions/cancel", { userId, decisionId: cancelled.id });
    expect(await status(agentSessionId)).toBe(1);

    vi.setSystemTime(START + 10 * MINUTE);
    await t.mutation(decisions.expire.run, { decisionId: expiring.id as Id<"decisions"> });
    expect(await status(agentSessionId)).toBe(0);
    expect(await status(otherSession)).toBe(1);
  });
});
