import {
  agentSessionSchema,
  decisionPageSchema,
  decisionSchema,
  errorBodySchema,
} from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { decodeCursorJson, encodeCursorJson } from "./cursor";
import { decisions } from "./refs";

const SECRET = "test-service-secret";
const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;

const approve = { title: "Ship it?", input_type: "approve_reject", topic: "Repo/X" };
const options = [
  { id: "pg", label: "Postgres" },
  { id: "sq", label: "SQLite" },
];
const single = { title: "Which database?", input_type: "single_choice", topic: "repo/x", options };
const multiple = {
  title: "Which checks?",
  input_type: "multiple_choice",
  topic: "repo/x",
  options,
};
const freeText = { title: "Name it", input_type: "free_text", topic: "repo/x" };
const choiceOrText = {
  title: "Which database, or another?",
  input_type: "single_choice_or_text",
  topic: "repo/x",
  options,
};

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
    const created = decisionSchema.parse(await response.json());
    // The create response precedes routing; later reads carry the routed
    // action, `push` by default (req-notification-rules REQ-4).
    expect(created.notification_action).toBeNull();
    await t.finishAllScheduledFunctions(() => {});
    return created;
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

  // req-agent-tools AC-10.1
  test("stores interactive as given and an omitted flag as false", async () => {
    const { t, open, ask } = await setup();
    const agentSessionId = await open();
    const stored = (id: string) =>
      t.run(async (ctx) => (await ctx.db.get("decisions", id as Id<"decisions">))?.interactive);

    const watched = await ask(agentSessionId, { ...approve, interactive: true });
    const unwatched = await ask(agentSessionId, { ...approve, interactive: false });
    const omitted = await ask(agentSessionId);

    expect([watched.interactive, unwatched.interactive, omitted.interactive]).toEqual([
      true,
      false,
      false,
    ]);
    expect([
      await stored(watched.id),
      await stored(unwatched.id),
      await stored(omitted.id),
    ]).toEqual([true, false, false]);
  });

  // req-agent-tools AC-10.1: a row stored before the field existed reads false.
  test("reads a row without interactive as false", async () => {
    const { t, userId, open, ask } = await setup();
    const agentSessionId = await open();
    const decision = await ask(agentSessionId, { ...approve, interactive: true });
    await t.run((ctx) =>
      ctx.db.patch("decisions", decision.id as Id<"decisions">, { interactive: undefined }),
    );

    const response = await post(t, "/svc/decisions/poll", {
      userId,
      agentSessionId,
      decisionId: decision.id,
    });

    expect(decisionSchema.parse(await response.json()).interactive).toBe(false);
  });

  test("returns 400 naming interactive for a value that is not a boolean", async () => {
    const { t, userId, open } = await setup();
    const agentSessionId = await open();

    const response = await post(t, "/svc/decisions/create", {
      userId,
      agentSessionId,
      ...approve,
      interactive: "yes",
    });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "interactive" });
    expect(await t.run((ctx) => ctx.db.query("decisions").collect())).toHaveLength(0);
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
    expect(decisionSchema.parse(await response.json())).toEqual({
      ...decision,
      notification_action: "push",
    });
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

// component-decisions §Relayed answers; req-agent-tools REQ-9;
// req-decision-requests REQ-8; DEC-13.
describe("/svc/decisions/resolve", () => {
  const MESSAGE = "  Go with the second one.\n\nThanks!\n";
  const DEADLINE = START + 60 * MINUTE;

  async function relaySetup() {
    const base = await setup();
    const { t, userId, open, session } = base;
    // The asking session asks; a second session of the same user relays.
    const asker = await open();
    const relayer = await open();
    const asA = t.withIdentity({ subject: "user_a" });
    const resolve = (body: Record<string, unknown>) =>
      post(t, "/svc/decisions/resolve", { userId, agentSessionId: relayer, ...body });
    const load = (id: string) => t.run((ctx) => ctx.db.get("decisions", id as Id<"decisions">));
    const kinds = (id: string) =>
      t.run(async (ctx) =>
        (await ctx.db.query("events").collect())
          .filter((event) => event.decisionId === id)
          .map((event) => event.kind),
      );
    const jobState = async (id: string) => {
      const jobId = (await load(id))?.expiryJobId;
      return jobId === undefined
        ? undefined
        : (await t.run((ctx) => ctx.db.system.get(jobId)))?.state.kind;
    };
    // Everything a refused relay must leave unchanged.
    const snapshot = async (id: string) => ({
      decision: await load(id),
      asker: await session(asker),
      relayer: await session(relayer),
      // The scheduled routing job annotates events on its own clock, so only
      // their identity and kind are compared.
      events: (await t.run((ctx) => ctx.db.query("events").collect())).map((event) => [
        event._id,
        event.kind,
      ]),
      job: await jobState(id),
    });
    const poll = async (id: string, agentSessionId = asker) =>
      decisionSchema.parse(
        await (
          await post(t, "/svc/decisions/poll", { userId, agentSessionId, decisionId: id })
        ).json(),
      );
    return { ...base, asker, relayer, asA, resolve, load, kinds, jobState, snapshot, poll };
  }

  // req-decision-requests AC-4.3, AC-8.1; req-agent-tools AC-9.1
  test.each<[string, Record<string, unknown>, Record<string, unknown>, string[]]>([
    ["approve-or-reject", approve, { kind: "approve" }, []],
    ["single choice", single, { kind: "option", option_id: "sq" }, ["SQLite"]],
    [
      "multiple choice",
      multiple,
      { kind: "options", option_ids: ["pg", "sq"] },
      ["Postgres", "SQLite"],
    ],
    ["free text", freeText, { kind: "text", text: "Orbit" }, ["Orbit"]],
    [
      "an option of single choice with text",
      choiceOrText,
      { kind: "option", option_id: "pg" },
      ["Postgres"],
    ],
    [
      "the text of single choice with text",
      choiceOrText,
      { kind: "text", text: "MySQL" },
      ["MySQL"],
    ],
  ])(
    "relays a %s answer from another session of the owner",
    async (_name, input, answer, words) => {
      const { asker, relayer, ask, resolve, load, kinds, jobState, session, snapshot } =
        await relaySetup();
      const pending = await ask(asker, { ...input, deadline: new Date(DEADLINE).toISOString() });
      const before = await snapshot(pending.id);
      vi.setSystemTime(START + MINUTE);

      const response = await resolve({ decisionId: pending.id, answer, chatMessage: MESSAGE });

      expect(response.status).toBe(200);
      expect(decisionSchema.parse(await response.json())).toEqual({
        ...pending,
        notification_action: "push",
        state: "answered",
        answer,
        note: null,
        answered_at: new Date(START + MINUTE).toISOString(),
        answered_via: "chat",
        chat_message: MESSAGE,
        relayed_by_agent_session_id: relayer,
        applied_by_default: false,
        agent_session_id: asker,
      });
      const row = await load(pending.id);
      expect(row).toMatchObject({
        answeredAt: START + MINUTE,
        settledAt: START + MINUTE,
        chatMessage: MESSAGE,
        relayedByAgentSessionId: relayer,
        searchText: [before.decision?.searchText, ...words, MESSAGE].join("\n"),
      });
      expect(row?.note).toBeUndefined();
      expect(await jobState(pending.id)).toBe("canceled");
      expect(await kinds(pending.id)).toEqual(["decision.created", "decision.answered"]);
      // The relaying session is touched with the decision's topic; the asking
      // session is not.
      expect(await session(relayer)).toMatchObject({
        topic: "repo/x",
        activatedAt: START + MINUTE,
        lastActivityAt: START + MINUTE,
      });
      expect(await session(asker)).toEqual(before.asker);
    },
  );

  test("the asking session may relay its own decision", async () => {
    const { userId, asker, ask, t } = await relaySetup();
    const pending = await ask(asker);

    const response = await post(t, "/svc/decisions/resolve", {
      userId,
      agentSessionId: asker,
      decisionId: pending.id,
      answer: { kind: "reject" },
      chatMessage: "no",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      answer: { kind: "reject" },
      relayed_by_agent_session_id: asker,
      agent_session_id: asker,
    });
  });

  // req-decision-requests AC-8.2: the limit is inclusive and nothing is trimmed.
  test("accepts a 4,000-character message unchanged", async () => {
    const { asker, ask, resolve } = await relaySetup();
    const pending = await ask(asker);
    const message = ` ${"y".repeat(3998)}\n`;

    const response = await resolve({
      decisionId: pending.id,
      answer: { kind: "approve" },
      chatMessage: message,
    });

    expect(response.status).toBe(200);
    expect(decisionSchema.parse(await response.json()).chat_message).toBe(message);
  });

  // req-agent-tools AC-9.1; req-decision-requests AC-8.2
  test.each<[string, unknown]>([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", " \n\t "],
    ["not a string", 42],
    ["4,001 characters long", "y".repeat(4001)],
  ])("refuses a message that is %s with 400 and touches nothing", async (_name, chatMessage) => {
    const { asker, ask, resolve, snapshot } = await relaySetup();
    const pending = await ask(asker, { ...approve, deadline: new Date(DEADLINE).toISOString() });
    const before = await snapshot(pending.id);
    vi.setSystemTime(START + MINUTE);

    const response = await resolve({
      decisionId: pending.id,
      answer: { kind: "approve" },
      ...(chatMessage === undefined ? {} : { chatMessage }),
    });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "chatMessage" });
    expect(await snapshot(pending.id)).toEqual(before);
  });

  // req-decision-requests AC-2.2: an invalid answer leaves the row pending.
  test.each<[string, Record<string, unknown>, unknown, string]>([
    ["a wrong kind", approve, { kind: "text", text: "x" }, "answer.kind"],
    ["an unknown option", single, { kind: "option", option_id: "zz" }, "answer.option_id"],
    [
      "an option and text at once",
      choiceOrText,
      { kind: "option", option_id: "pg", text: "x" },
      "answer",
    ],
    ["no answer", approve, undefined, "answer"],
  ])("refuses %s with 400 and leaves the decision pending", async (_name, input, answer, field) => {
    const { asker, ask, resolve, snapshot } = await relaySetup();
    const pending = await ask(asker, { ...input, deadline: new Date(DEADLINE).toISOString() });
    const before = await snapshot(pending.id);
    vi.setSystemTime(START + MINUTE);

    const response = await resolve({
      decisionId: pending.id,
      ...(answer === undefined ? {} : { answer }),
      chatMessage: MESSAGE,
    });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field });
    expect(await snapshot(pending.id)).toEqual(before);
  });

  // req-agent-tools AC-9.2; req-decision-requests AC-4.1
  test.each([
    ["answered in the app", "answered"],
    ["answered in chat", "answered"],
    ["cancelled", "cancelled"],
    ["expired with a default", "expired"],
    ["expired without a default", "expired"],
  ])("refuses a decision %s with 409 whatever the answer holds", async (how, state) => {
    const { t, userId, asker, ask, resolve, snapshot, poll } = await relaySetup();
    const pending = await ask(asker, {
      ...approve,
      deadline: new Date(DEADLINE).toISOString(),
      ...(how === "expired with a default" ? { default: { kind: "approve" } } : {}),
    });
    if (how === "answered in the app") {
      await t.mutation(decisions.devAnswer.answer, {
        decisionId: pending.id,
        answer: { kind: "approve" },
        answeredVia: "app",
      });
    } else if (how === "answered in chat") {
      expect(
        (await resolve({ decisionId: pending.id, answer: { kind: "approve" }, chatMessage: "yes" }))
          .status,
      ).toBe(200);
    } else if (how === "cancelled") {
      await post(t, "/svc/decisions/cancel", { userId, decisionId: pending.id });
    } else {
      vi.setSystemTime(DEADLINE);
      await t.mutation(decisions.expire.run, { decisionId: pending.id as Id<"decisions"> });
    }
    const stored = await poll(pending.id);
    expect(stored.state).toBe(state);
    const before = await snapshot(pending.id);
    vi.setSystemTime(DEADLINE + MINUTE);

    for (const answer of [{ kind: "reject" }, { kind: "bogus" }, undefined]) {
      const response = await resolve({
        decisionId: pending.id,
        ...(answer === undefined ? {} : { answer }),
        chatMessage: MESSAGE,
      });

      expect(response.status).toBe(409);
      expect(await errorOf(response)).toEqual({
        code: "conflict",
        message: `Decision is already ${state}`,
      });
      expect(await snapshot(pending.id)).toEqual(before);
    }
    // The gateway reads the recorded outcome with poll (component-decisions
    // §State machine).
    expect(await poll(pending.id)).toEqual(stored);
  });

  // req-agent-tools AC-7.1: missing and foreign ids are alike.
  test("returns 404 for a missing or foreign decision or session and touches nothing", async () => {
    const { t, userId, otherUserId, open, asker, relayer, ask, resolve, snapshot } =
      await relaySetup();
    const pending = await ask(asker);
    const gone = await ask(asker);
    await t.run((ctx) => ctx.db.delete("decisions", gone.id as Id<"decisions">));
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
    const goneSession = await open();
    await t.run((ctx) => ctx.db.delete("agentSessions", goneSession));
    const before = await snapshot(pending.id);
    const valid = { answer: { kind: "approve" }, chatMessage: MESSAGE };
    vi.setSystemTime(START + MINUTE);

    for (const body of [
      { decisionId: gone.id, ...valid },
      { decisionId: foreign.id, ...valid },
      { decisionId: pending.id, agentSessionId: foreignSession, ...valid },
      { decisionId: pending.id, agentSessionId: goneSession, ...valid },
    ]) {
      const response = await resolve(body);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
    }
    expect(await snapshot(pending.id)).toEqual(before);
    expect(
      (await t.run((ctx) => ctx.db.get("decisions", foreign.id as Id<"decisions">)))?.state,
    ).toBe("pending");
    expect(relayer).not.toBe(foreignSession);
  });

  test("returns 400 naming a malformed id and 401 for a wrong secret", async () => {
    const { t, userId, relayer, asker, ask, resolve, snapshot } = await relaySetup();
    const pending = await ask(asker);
    const before = await snapshot(pending.id);
    const valid = { answer: { kind: "approve" }, chatMessage: MESSAGE };

    const badDecision = await resolve({ decisionId: "nope", ...valid });
    expect(badDecision.status).toBe(400);
    expect(await errorOf(badDecision)).toMatchObject({ code: "invalid", field: "decisionId" });

    const badSession = await resolve({ decisionId: pending.id, agentSessionId: "nope", ...valid });
    expect(badSession.status).toBe(400);
    expect(await errorOf(badSession)).toMatchObject({ code: "invalid", field: "agentSessionId" });

    const wrong = await post(
      t,
      "/svc/decisions/resolve",
      { userId, agentSessionId: relayer, decisionId: pending.id, ...valid },
      "Bearer nope",
    );
    expect(wrong.status).toBe(401);
    expect(await snapshot(pending.id)).toEqual(before);
  });

  // req-decision-requests AC-5.4: a late expiry never replaces a relay.
  test("a stale expiry job cannot overwrite a relayed answer", async () => {
    const { t, asker, ask, resolve, load, kinds } = await relaySetup();
    const pending = await ask(asker, {
      ...approve,
      deadline: new Date(DEADLINE).toISOString(),
      default: { kind: "reject" },
    });
    await resolve({ decisionId: pending.id, answer: { kind: "approve" }, chatMessage: MESSAGE });
    const relayed = await load(pending.id);
    vi.setSystemTime(DEADLINE);

    await expect(
      t.mutation(decisions.expire.run, { decisionId: pending.id as Id<"decisions"> }),
    ).rejects.toMatchObject({ data: { code: "conflict" } });
    expect(await load(pending.id)).toEqual(relayed);
    expect(await kinds(pending.id)).toEqual(["decision.created", "decision.answered"]);
  });

  // req-decision-requests AC-4.2: one winner for each pair of settlements.
  describe("races", () => {
    test("a relay and an app answer record exactly one", async () => {
      const { asker, ask, asA, resolve, load, kinds } = await relaySetup();
      const pending = await ask(asker, single);

      const [relay, app] = await Promise.all([
        resolve({
          decisionId: pending.id,
          answer: { kind: "option", option_id: "pg" },
          chatMessage: MESSAGE,
        }),
        asA
          .mutation(decisions.app.answer, {
            decisionId: pending.id,
            answer: { kind: "option", option_id: "sq" },
          })
          .then(
            (decision) => ({ ok: true as const, decision }),
            (error: { data: unknown }) => ({ ok: false as const, error }),
          ),
      ]);

      const row = await load(pending.id);
      if (relay.status === 200) {
        expect(app).toMatchObject({ ok: false, error: { data: { code: "conflict" } } });
        expect(row).toMatchObject({ answeredVia: "chat", chatMessage: MESSAGE });
      } else {
        expect(relay.status).toBe(409);
        expect(app.ok).toBe(true);
        expect(row).toMatchObject({
          answeredVia: "app",
          answer: { kind: "option", option_id: "sq" },
        });
        expect(row?.chatMessage).toBeUndefined();
        expect(row?.relayedByAgentSessionId).toBeUndefined();
      }
      expect(await kinds(pending.id)).toEqual(["decision.created", "decision.answered"]);
    });

    test("two relays record exactly one", async () => {
      const { t, userId, asker, relayer, ask, load, kinds } = await relaySetup();
      const pending = await ask(asker, single);
      const relayFrom = (agentSessionId: Id<"agentSessions">, optionId: string) =>
        post(t, "/svc/decisions/resolve", {
          userId,
          agentSessionId,
          decisionId: pending.id,
          answer: { kind: "option", option_id: optionId },
          chatMessage: `use ${optionId}`,
        });

      const responses = await Promise.all([relayFrom(asker, "pg"), relayFrom(relayer, "sq")]);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      const winner = decisionSchema.parse(
        await responses.find((response) => response.status === 200)?.json(),
      );
      const row = await load(pending.id);
      expect(row).toMatchObject({
        answer: winner.answer,
        chatMessage: winner.chat_message,
        relayedByAgentSessionId: winner.relayed_by_agent_session_id,
      });
      expect(winner.chat_message).toBe(`use ${(winner.answer as { option_id: string }).option_id}`);
      expect(await kinds(pending.id)).toEqual(["decision.created", "decision.answered"]);
    });

    test("a relay and a due expiry record exactly one", async () => {
      const { t, asker, ask, resolve, load, kinds } = await relaySetup();
      const pending = await ask(asker, {
        ...approve,
        deadline: new Date(DEADLINE).toISOString(),
        default: { kind: "reject" },
      });
      vi.setSystemTime(DEADLINE);

      const [relay, expiry] = await Promise.all([
        resolve({ decisionId: pending.id, answer: { kind: "approve" }, chatMessage: MESSAGE }),
        t.mutation(decisions.expire.run, { decisionId: pending.id as Id<"decisions"> }).then(
          () => true,
          () => false,
        ),
      ]);

      const row = await load(pending.id);
      if (relay.status === 200) {
        expect(expiry).toBe(false);
        expect(row).toMatchObject({ state: "answered", answeredVia: "chat" });
        expect(await kinds(pending.id)).toEqual(["decision.created", "decision.answered"]);
      } else {
        expect(relay.status).toBe(409);
        expect(expiry).toBe(true);
        expect(row).toMatchObject({ state: "expired", answeredVia: "default" });
        expect(row?.chatMessage).toBeUndefined();
        expect(await kinds(pending.id)).toEqual(["decision.created", "decision.expired"]);
      }
    });
  });

  // req-decision-requests AC-8.3, REQ-7: the relay fields survive both
  // sessions being purged, on every read.
  test("every read returns the relay fields after both sessions are purged", async () => {
    const { t, userId, open, asker, relayer, ask, asA, resolve } = await relaySetup();
    const pending = await ask(asker, freeText);
    await t.run((ctx) => ctx.db.delete("agentSessions", asker));

    const response = await resolve({
      decisionId: pending.id,
      answer: { kind: "text", text: "Orbit" },
      chatMessage: "Call it Orbit, the rollout name we agreed on",
    });
    expect(response.status).toBe(200);
    const relayed = decisionSchema.parse(await response.json());
    await t.run((ctx) => ctx.db.delete("agentSessions", relayer));
    const reader = await open();
    const fields = {
      answered_via: "chat",
      chat_message: "Call it Orbit, the rollout name we agreed on",
      relayed_by_agent_session_id: relayer,
      agent_session_id: asker,
    };

    expect(relayed).toMatchObject(fields);
    const polled = await post(t, "/svc/decisions/poll", {
      userId,
      agentSessionId: reader,
      decisionId: pending.id,
    });
    expect(decisionSchema.parse(await polled.json())).toEqual(relayed);
    const checked = await post(t, "/svc/decisions/check", {
      userId,
      agentSessionId: reader,
      decisionIds: [pending.id],
    });
    expect(decisionSchema.array().parse(await checked.json())).toEqual([relayed]);
    expect(await asA.query(decisions.app.get, { decisionId: pending.id })).toEqual(relayed);
    // History search finds the decision by a word only the chat message holds.
    const history = await asA.query(decisions.app.searchHistory, {
      query: "agreed",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history.page.map((item) => item.decision)).toEqual([relayed]);
  });

  // req-decision-requests AC-8.3: only a relay sets the relay fields.
  test("the relay fields are null while pending and on every other settlement", async () => {
    const { t, userId, asker, ask, asA, poll } = await relaySetup();
    const deadline = new Date(DEADLINE).toISOString();
    const pending = await ask(asker);
    const app = await ask(asker);
    const notification = await ask(asker);
    const api = await ask(asker);
    const cancelled = await ask(asker);
    const withDefault = await ask(asker, { ...approve, deadline, default: { kind: "approve" } });
    const withoutDefault = await ask(asker, { ...approve, deadline });
    await asA.mutation(decisions.app.answer, { decisionId: app.id, answer: { kind: "approve" } });
    await asA.mutation(decisions.app.answerFromNotification, {
      decisionId: notification.id,
      action: "reject",
    });
    await t.mutation(decisions.devAnswer.answer, {
      decisionId: api.id,
      answer: { kind: "approve" },
      answeredVia: "api",
    });
    await post(t, "/svc/decisions/cancel", { userId, decisionId: cancelled.id });
    vi.setSystemTime(DEADLINE);
    for (const { id } of [withDefault, withoutDefault]) {
      await t.mutation(decisions.expire.run, { decisionId: id as Id<"decisions"> });
    }

    const reads = [];
    for (const { id } of [
      pending,
      app,
      notification,
      api,
      cancelled,
      withDefault,
      withoutDefault,
    ]) {
      reads.push(await poll(id));
    }

    expect(reads.map((d) => [d.state, d.answered_via])).toEqual([
      ["pending", null],
      ["answered", "app"],
      ["answered", "notification"],
      ["answered", "api"],
      ["cancelled", null],
      ["expired", "default"],
      ["expired", null],
    ]);
    for (const read of reads) {
      expect(read).toMatchObject({ chat_message: null, relayed_by_agent_session_id: null });
    }
  });
});

// component-decisions §Service routes: the resume waiter's read (DEC-15). The
// request names no session; the touch goes to the asking session recorded on
// the decision (req-agent-status AC-3.3, AC-3.5).
describe("/svc/decisions/watch", () => {
  const DEADLINE = START + 60 * MINUTE;

  async function watchSetup() {
    const base = await setup();
    const { t, userId, otherUserId, open, ask } = base;
    // The asking session asks; a second activated session of the same user and
    // another user's session must stay as they are.
    const asker = await open();
    const bystander = await open();
    await ask(bystander);
    const foreignSession = await open(otherUserId);
    const asA = t.withIdentity({ subject: "user_a" });
    const watch = (body: Record<string, unknown>) =>
      post(t, "/svc/decisions/watch", { userId, ...body });
    const load = (id: string) => t.run((ctx) => ctx.db.get("decisions", id as Id<"decisions">));
    const sessions = () => t.run((ctx) => ctx.db.query("agentSessions").collect());
    // Everything a watch leaves unchanged apart from the asking session's
    // activity: decisions, their expiry jobs, and events.
    const decisionState = () =>
      t.run(async (ctx) => {
        const rows = await ctx.db.query("decisions").collect();
        const jobs = [];
        for (const row of rows) {
          jobs.push(
            row.expiryJobId === undefined
              ? null
              : ((await ctx.db.system.get(row.expiryJobId))?.state.kind ?? null),
          );
        }
        // The scheduled routing job annotates events on its own clock, so only
        // their identity and kind are compared.
        const events = (await ctx.db.query("events").collect()).map((event) => [
          event._id,
          event.kind,
        ]);
        return { rows, jobs, events };
      });
    return {
      ...base,
      asker,
      bystander,
      foreignSession,
      asA,
      watch,
      load,
      sessions,
      decisionState,
    };
  }

  test("returns 200 with the Decision and touches only the asking session", async () => {
    const { t, asker, bystander, ask, session, sessions, watch, decisionState } =
      await watchSetup();
    const decision = await ask(asker);
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", asker, {
        staleSince: START,
        endedAt: START,
        endReason: "idle",
      }),
    );
    const askerBefore = await session(asker);
    const bystanderBefore = await session(bystander);
    const sessionIds = (await sessions()).map((row) => row._id);
    const before = await decisionState();
    vi.setSystemTime(START + MINUTE);

    // A session named in the body is not the caller's: the schema drops it.
    const response = await watch({ decisionId: decision.id, agentSessionId: bystander });

    expect(response.status).toBe(200);
    expect(decisionSchema.parse(await response.json())).toEqual({
      ...decision,
      notification_action: "push",
    });
    const touched = await session(asker);
    expect(touched).toMatchObject({
      topic: askerBefore?.topic,
      activatedAt: askerBefore?.activatedAt,
      lastActivityAt: START + MINUTE,
    });
    expect(touched?.staleSince).toBeUndefined();
    expect(touched?.endedAt).toBeUndefined();
    expect(touched?.endReason).toBeUndefined();
    expect(await session(bystander)).toEqual(bystanderBefore);
    expect((await sessions()).map((row) => row._id)).toEqual(sessionIds);
    expect(await decisionState()).toEqual(before);
  });

  // component-agent-presence §Lifecycle: a `done` end stays through a touch.
  test("keeps a done end on the asking session", async () => {
    const { t, asker, ask, session, watch } = await watchSetup();
    const decision = await ask(asker);
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", asker, {
        staleSince: START,
        endedAt: START,
        endReason: "done",
      }),
    );
    vi.setSystemTime(START + MINUTE);

    const response = await watch({ decisionId: decision.id });

    expect(response.status).toBe(200);
    const touched = await session(asker);
    expect(touched).toMatchObject({
      lastActivityAt: START + MINUTE,
      endedAt: START,
      endReason: "done",
    });
    expect(touched?.staleSince).toBeUndefined();
  });

  // component-decisions §State machine: watch reads every state and settles,
  // cancels, or schedules nothing.
  test("returns each state's stored Decision and changes no decision", async () => {
    const { t, userId, asker, asA, ask, session, watch, decisionState } = await watchSetup();
    const deadline = new Date(DEADLINE).toISOString();
    const pending = await ask(asker, { ...approve, deadline });
    const answered = await ask(asker, single);
    // The pending decision keeps a scheduled expiry job; the clock never
    // reaches its deadline.
    const soon = new Date(START + MINUTE).toISOString();
    const withDefault = await ask(asker, {
      ...approve,
      deadline: soon,
      default: { kind: "approve" },
    });
    const withoutDefault = await ask(asker, { ...approve, deadline: soon });
    const cancelled = await ask(asker);
    await asA.mutation(decisions.app.answer, {
      decisionId: answered.id,
      answer: { kind: "option", option_id: "sq" },
      note: "Smaller footprint",
    });
    await post(t, "/svc/decisions/cancel", { userId, decisionId: cancelled.id });
    vi.setSystemTime(START + MINUTE);
    for (const { id } of [withDefault, withoutDefault]) {
      await t.mutation(decisions.expire.run, { decisionId: id as Id<"decisions"> });
    }
    const ids = [pending, answered, withDefault, withoutDefault, cancelled].map(({ id }) => id);
    const stored = [];
    for (const id of ids) {
      stored.push(await asA.query(decisions.app.get, { decisionId: id }));
    }
    const before = await decisionState();
    vi.setSystemTime(START + 2 * MINUTE);

    const reads = [];
    for (const id of ids) {
      const response = await watch({ decisionId: id });
      expect(response.status).toBe(200);
      reads.push(decisionSchema.parse(await response.json()));
    }

    expect(reads).toEqual(stored);
    expect(reads.map((d) => [d.state, d.answered_via])).toEqual([
      ["pending", null],
      ["answered", "app"],
      ["expired", "default"],
      ["expired", null],
      ["cancelled", null],
    ]);
    expect(reads[1]).toMatchObject({
      answer: { kind: "option", option_id: "sq" },
      note: "Smaller footprint",
    });
    expect(reads[2]?.answer).toEqual({ kind: "approve" });
    expect(await decisionState()).toEqual(before);
    expect(before.jobs).toContain("pending");
    expect((await session(asker))?.lastActivityAt).toBe(START + 2 * MINUTE);
  });

  // req-decision-requests REQ-7; req-agent-status AC-4.2: a decision outlives
  // its asking session, and no session replaces it.
  test("returns the Decision after the asking session is deleted and touches nothing", async () => {
    const { t, asker, ask, sessions, watch, decisionState } = await watchSetup();
    const decision = await ask(asker);
    await t.run((ctx) => ctx.db.delete("agentSessions", asker));
    const sessionsBefore = await sessions();
    const before = await decisionState();
    vi.setSystemTime(START + MINUTE);

    const response = await watch({ decisionId: decision.id });

    expect(response.status).toBe(200);
    expect(decisionSchema.parse(await response.json())).toEqual({
      ...decision,
      notification_action: "push",
    });
    expect(await sessions()).toEqual(sessionsBefore);
    expect(await decisionState()).toEqual(before);
  });

  // Only a missing asking session skips the touch: an existing session that
  // touch refuses still fails the call, which rolls back.
  test("returns 404 when the recorded asking session belongs to another user", async () => {
    const { t, asker, foreignSession, ask, sessions, watch, decisionState } = await watchSetup();
    const decision = await ask(asker);
    await t.run((ctx) =>
      ctx.db.patch("decisions", decision.id as Id<"decisions">, {
        agentSessionId: foreignSession,
      }),
    );
    const sessionsBefore = await sessions();
    const before = await decisionState();
    vi.setSystemTime(START + MINUTE);

    const response = await watch({ decisionId: decision.id });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
    expect(await sessions()).toEqual(sessionsBefore);
    expect(await decisionState()).toEqual(before);
  });

  // req-agent-tools AC-7.1: missing and foreign decisions are alike.
  test("returns the same 404 for a missing or foreign decision and touches nothing", async () => {
    const { t, otherUserId, asker, foreignSession, ask, sessions, watch, decisionState } =
      await watchSetup();
    const gone = await ask(asker);
    await t.run((ctx) => ctx.db.delete("decisions", gone.id as Id<"decisions">));
    const foreign = decisionSchema.parse(
      await (
        await post(t, "/svc/decisions/create", {
          userId: otherUserId,
          agentSessionId: foreignSession,
          ...approve,
        })
      ).json(),
    );
    const sessionsBefore = await sessions();
    const before = await decisionState();
    vi.setSystemTime(START + MINUTE);

    for (const decisionId of [gone.id, foreign.id]) {
      const response = await watch({ decisionId });
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toEqual({ code: "not_found", message: "Decision not found" });
    }
    expect(await sessions()).toEqual(sessionsBefore);
    expect(await decisionState()).toEqual(before);
  });

  test("returns 400 naming a missing, empty, or malformed id and touches nothing", async () => {
    const { t, userId, asker, ask, sessions, decisionState } = await watchSetup();
    const decision = await ask(asker);
    const sessionsBefore = await sessions();
    const before = await decisionState();
    vi.setSystemTime(START + MINUTE);

    for (const [body, field] of [
      [{ decisionId: decision.id }, "userId"],
      [{ userId: "", decisionId: decision.id }, "userId"],
      [{ userId: "nope", decisionId: decision.id }, "userId"],
      // An id of another table is malformed for this field.
      [{ userId: asker, decisionId: decision.id }, "userId"],
      [{ userId }, "decisionId"],
      [{ userId, decisionId: "" }, "decisionId"],
      [{ userId, decisionId: "nope" }, "decisionId"],
      [{ userId, decisionId: asker }, "decisionId"],
    ] as const) {
      const response = await post(t, "/svc/decisions/watch", body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: "invalid", field });
    }
    expect(await sessions()).toEqual(sessionsBefore);
    expect(await decisionState()).toEqual(before);
  });

  test("returns 401 for a wrong or missing secret and touches nothing", async () => {
    const { t, userId, asker, ask, sessions, decisionState } = await watchSetup();
    const decision = await ask(asker);
    const sessionsBefore = await sessions();
    const before = await decisionState();
    vi.setSystemTime(START + MINUTE);

    for (const authorization of ["Bearer nope", ""]) {
      const response = await post(
        t,
        "/svc/decisions/watch",
        { userId, decisionId: decision.id },
        authorization,
      );
      expect(response.status).toBe(401);
    }
    expect(await sessions()).toEqual(sessionsBefore);
    expect(await decisionState()).toEqual(before);
  });
});

// req-agent-tools AC-7.3: resolve is the only MCP route that takes an answer.
// The public API's `/svc/decisions/answer` records only `api`, whatever
// surface the body names (req-public-api-and-webhooks AC-2.2).
test("no MCP route but resolve accepts an answer, and the API route records only api", async () => {
  const { t, userId, open, ask } = await setup();
  const agentSessionId = await open();
  const decision = await ask(agentSessionId);
  const answer = { kind: "approve" };

  await post(t, "/svc/decisions/poll", { userId, agentSessionId, decisionId: decision.id, answer });
  await post(t, "/svc/decisions/check", {
    userId,
    agentSessionId,
    decisionIds: [decision.id],
    answer,
  });
  const read = await post(t, "/svc/decisions/get", { userId, decisionId: decision.id });
  expect((await read.json()).state).toBe("pending");

  const response = await post(t, "/svc/decisions/answer", {
    userId,
    decisionId: decision.id,
    answer,
    answeredVia: "chat",
    agentSessionId,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "answered",
    answered_via: "api",
    chat_message: null,
    relayed_by_agent_session_id: null,
  });
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

// component-decisions §Service routes: the public HTTP API's routes, which
// name no agent session.
describe("public API routes", () => {
  const page = decisionPageSchema;

  // Asks one decision per topic, a minute apart, so creation order is known.
  async function askAll(topics: string[]) {
    const ctx = await setup();
    const agentSessionId = await ctx.open();
    const asked = [];
    for (const [index, topic] of topics.entries()) {
      vi.setSystemTime(START + (index + 1) * MINUTE);
      asked.push(await ctx.ask(agentSessionId, { ...approve, topic }));
    }
    return { ...ctx, agentSessionId, asked };
  }

  async function foreignDecision(t: T, otherUserId: Id<"users">) {
    const credentialId = await t.run((ctx) =>
      ctx.db.insert("credentials", {
        userId: otherUserId,
        kind: "connection_token",
        tokenHash: "1".repeat(64),
      }),
    );
    const { agentSessionId } = await t.mutation(agents.sessions.open, {
      userId: otherUserId,
      credentialId,
      clientName: "Codex",
      clientVersion: "1.0.0",
    });
    const response = await post(t, "/svc/decisions/create", {
      userId: otherUserId,
      agentSessionId,
      ...approve,
    });
    return decisionSchema.parse(await response.json());
  }

  describe("/svc/decisions/list", () => {
    // req-public-api-and-webhooks AC-2.1, AC-2.3
    test("lists the user's decisions newest first with their notification action", async () => {
      const { t, userId, otherUserId, asked } = await askAll(["repo/a", "repo/b", "repo/c"]);
      await foreignDecision(t, otherUserId);

      const response = await post(t, "/svc/decisions/list", { userId, limit: 50 });

      expect(response.status).toBe(200);
      const result = page.parse(await response.json());
      expect(result.items.map((d) => d.id)).toEqual(asked.map((d) => d.id).reverse());
      expect(result.items.every((d) => d.notification_action === "push")).toBe(true);
      expect(result.next_cursor).toBeNull();
    });

    test("filters by state", async () => {
      const { t, userId, asked } = await askAll(["repo/a", "repo/b", "repo/c"]);
      await post(t, "/svc/decisions/cancel", { userId, decisionId: asked[1]?.id });

      const pending = page.parse(
        await (
          await post(t, "/svc/decisions/list", { userId, state: "pending", limit: 50 })
        ).json(),
      );
      const cancelled = page.parse(
        await (
          await post(t, "/svc/decisions/list", { userId, state: "cancelled", limit: 50 })
        ).json(),
      );

      expect(pending.items.map((d) => d.id)).toEqual([asked[2]?.id, asked[0]?.id]);
      expect(cancelled.items.map((d) => d.id)).toEqual([asked[1]?.id]);
    });

    test("filters by topic, matching the topic and every topic under it", async () => {
      const { t, userId, asked } = await askAll(["acme", "acme/billing", "acmecorp", "acme-x"]);

      const response = await post(t, "/svc/decisions/list", { userId, topic: "ACME", limit: 50 });

      expect(page.parse(await response.json()).items.map((d) => d.id)).toEqual([
        asked[1]?.id,
        asked[0]?.id,
      ]);
    });

    test("pages to a null next_cursor without duplicates or omissions", async () => {
      const topics = ["repo/a", "repo/b", "repo/c", "repo/d", "repo/e"];
      const { t, userId, asked } = await askAll(topics);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await post(t, "/svc/decisions/list", {
          userId,
          state: "pending",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(response.status).toBe(200);
        const result = page.parse(await response.json());
        seen.push(...result.items.map((d) => d.id));
        cursor = result.next_cursor ?? undefined;
        pages++;
      } while (cursor !== undefined && pages < 10);

      expect(seen).toEqual(asked.map((d) => d.id).reverse());
    });

    test("refuses a cursor reused with other filters and a malformed cursor as invalid", async () => {
      const { t, userId } = await askAll(["repo/a", "repo/b", "repo/c"]);
      const first = page.parse(
        await (await post(t, "/svc/decisions/list", { userId, limit: 1 })).json(),
      );
      expect(first.next_cursor).not.toBeNull();

      const reused = await post(t, "/svc/decisions/list", {
        userId,
        state: "pending",
        cursor: first.next_cursor,
        limit: 1,
      });
      const malformed = await post(t, "/svc/decisions/list", {
        userId,
        cursor: "not a cursor!",
        limit: 1,
      });

      for (const response of [reused, malformed]) {
        expect(response.status).toBe(400);
        expect((await errorOf(response)).field).toBe("cursor");
      }
    });

    // A structurally valid envelope whose native cursor was not issued by
    // this list never reaches `.paginate`.
    test("refuses an envelope with a corrupt, empty, or re-signed native cursor as invalid", async () => {
      const { t, userId } = await askAll(["repo/a", "repo/b", "repo/c"]);
      const first = page.parse(
        await (await post(t, "/svc/decisions/list", { userId, limit: 1 })).json(),
      );
      const issued = decodeCursorJson(first.next_cursor as string) as Record<string, unknown>;
      expect(issued).toMatchObject({ v: 1, state: null, topic: null });

      const forged = [
        // No signature, as before signing.
        { v: 1, state: null, topic: null, cursor: "not-a-native-cursor" },
        // The issued signature over another native cursor.
        { ...issued, cursor: "not-a-native-cursor" },
        { ...issued, cursor: "" },
        // A signature that is not the list's, including encodings `atob`
        // refuses.
        { ...issued, sig: "AAAA" },
        { ...issued, sig: "" },
        { ...issued, sig: "x" },
        { ...issued, sig: "aaaaa" },
      ];
      for (const envelope of forged) {
        const response = await post(t, "/svc/decisions/list", {
          userId,
          cursor: encodeCursorJson(envelope),
          limit: 1,
        });
        expect(response.status).toBe(400);
        expect(await errorOf(response)).toEqual({
          code: "invalid",
          message: "cursor is not a cursor of this list with these filters",
          field: "cursor",
        });
      }
    });

    // Lengths of 1 modulo 4 are not base64url; `atob` throws on them.
    test.each(["a", "aaaaa"])("refuses the malformed cursor %s as invalid", async (cursor) => {
      const { t, userId } = await askAll(["repo/a"]);

      const response = await post(t, "/svc/decisions/list", { userId, cursor, limit: 1 });

      expect(response.status).toBe(400);
      expect((await errorOf(response)).field).toBe("cursor");
    });

    test("refuses a cursor signed under another service secret", async () => {
      const { t, userId } = await askAll(["repo/a", "repo/b"]);
      const first = page.parse(
        await (await post(t, "/svc/decisions/list", { userId, limit: 1 })).json(),
      );
      vi.stubEnv("SERVICE_SECRET", "rotated-secret");

      const response = await post(
        t,
        "/svc/decisions/list",
        { userId, cursor: first.next_cursor, limit: 1 },
        "Bearer rotated-secret",
      );

      expect(response.status).toBe(400);
      expect((await errorOf(response)).field).toBe("cursor");
    });

    test("returns 400 naming state, topic, or limit", async () => {
      const { t, userId } = await setup();

      for (const [body, field] of [
        [{ state: "done", limit: 1 }, "state"],
        [{ topic: "", limit: 1 }, "topic"],
        [{ limit: 0 }, "limit"],
      ] as const) {
        const response = await post(t, "/svc/decisions/list", { userId, ...body });
        expect(response.status).toBe(400);
        expect((await errorOf(response)).field).toBe(field);
      }
    });

    test("returns 401 for a wrong secret", async () => {
      const { t, userId } = await setup();

      const response = await post(t, "/svc/decisions/list", { userId, limit: 1 }, "Bearer wrong");

      expect(response.status).toBe(401);
    });
  });

  describe("/svc/decisions/get", () => {
    test("returns the owned Decision with its notification action", async () => {
      const { t, userId, asked } = await askAll(["repo/a"]);

      const response = await post(t, "/svc/decisions/get", { userId, decisionId: asked[0]?.id });

      expect(response.status).toBe(200);
      expect(decisionSchema.parse(await response.json())).toMatchObject({
        id: asked[0]?.id,
        notification_action: "push",
      });
    });

    test("returns 404 for a missing or foreign decision and 400 for a malformed id", async () => {
      const { t, userId, otherUserId, asked } = await askAll(["repo/a"]);
      const foreign = await foreignDecision(t, otherUserId);
      await t.run((ctx) => ctx.db.delete("decisions", asked[0]?.id as Id<"decisions">));

      for (const decisionId of [foreign.id, asked[0]?.id]) {
        const response = await post(t, "/svc/decisions/get", { userId, decisionId });
        expect(response.status).toBe(404);
        expect(await errorOf(response)).toEqual({
          code: "not_found",
          message: "Decision not found",
        });
      }
      const malformed = await post(t, "/svc/decisions/get", { userId, decisionId: "nope" });
      expect(malformed.status).toBe(400);
      expect((await errorOf(malformed)).field).toBe("decisionId");
    });
  });

  describe("/svc/decisions/answer", () => {
    // req-public-api-and-webhooks AC-2.2
    test("records the answer and note with answered_via api and touches no session", async () => {
      const { t, userId, agentSessionId, session, asked } = await askAll(["repo/a"]);
      const before = await session(agentSessionId);
      vi.setSystemTime(START + 10 * MINUTE);

      const response = await post(t, "/svc/decisions/answer", {
        userId,
        decisionId: asked[0]?.id,
        answer: { kind: "approve" },
        note: "Ship it",
      });

      expect(response.status).toBe(200);
      expect(decisionSchema.parse(await response.json())).toMatchObject({
        state: "answered",
        answer: { kind: "approve" },
        note: "Ship it",
        answered_via: "api",
        answered_at: new Date(START + 10 * MINUTE).toISOString(),
        chat_message: null,
      });
      expect(await session(agentSessionId)).toEqual(before);
    });

    test("leaves the decision pending for an invalid answer or note", async () => {
      const { t, userId, asked } = await askAll(["repo/a"]);
      const decisionId = asked[0]?.id;

      for (const [body, field] of [
        [{ answer: { kind: "option", option_id: "pg" } }, "answer.kind"],
        [{}, "answer"],
        [{ answer: { kind: "approve" }, note: 3 }, "note"],
        [{ answer: { kind: "approve" }, note: "x".repeat(2001) }, "note"],
      ] as const) {
        const response = await post(t, "/svc/decisions/answer", { userId, decisionId, ...body });
        expect(response.status).toBe(400);
        expect((await errorOf(response)).field).toMatch(new RegExp(`^${field}`));
      }
      const stored = await post(t, "/svc/decisions/get", { userId, decisionId });
      expect((await stored.json()).state).toBe("pending");
    });

    test("returns 409 for a settled decision and changes nothing", async () => {
      const { t, userId, asked } = await askAll(["repo/a"]);
      const decisionId = asked[0]?.id;
      await post(t, "/svc/decisions/cancel", { userId, decisionId });

      const response = await post(t, "/svc/decisions/answer", {
        userId,
        decisionId,
        answer: { kind: "approve" },
      });

      expect(response.status).toBe(409);
      expect(await errorOf(response)).toEqual({
        code: "conflict",
        message: "Decision is already cancelled",
      });
      const stored = await post(t, "/svc/decisions/get", { userId, decisionId });
      expect(await stored.json()).toMatchObject({ state: "cancelled", answer: null });
    });

    // req-decision-requests AC-4.2
    test("of two racing API answers exactly one wins and the other is 409", async () => {
      const { t, userId, asked } = await askAll(["repo/a"]);
      const decisionId = asked[0]?.id;

      const responses = await Promise.all(
        (["approve", "reject"] as const).map((kind) =>
          post(t, "/svc/decisions/answer", { userId, decisionId, answer: { kind } }),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = responses.find((r) => r.status === 200) as Response;
      const stored = await (await post(t, "/svc/decisions/get", { userId, decisionId })).json();
      expect(stored.answer).toEqual((await winner.json()).answer);
    });

    test("returns 404 for a foreign decision and 401 for a wrong secret", async () => {
      const { t, userId, otherUserId } = await setup();
      const foreign = await foreignDecision(t, otherUserId);
      const body = { userId, decisionId: foreign.id, answer: { kind: "approve" } };

      expect((await post(t, "/svc/decisions/answer", body)).status).toBe(404);
      expect((await post(t, "/svc/decisions/answer", body, "Bearer wrong")).status).toBe(401);
    });
  });
});
