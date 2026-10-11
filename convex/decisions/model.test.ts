import { type Decision, decisionSchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { answerDecision, cancelDecision, expireDecision, getDecision } from "./model";
import { decisions } from "./refs";

const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const HOUR = 60 * 60_000;

const approve = { title: "Ship it?", input_type: "approve_reject", topic: "Repo/X" };
const choice = {
  title: "Which database?",
  body: "Pick one",
  input_type: "single_choice",
  topic: "repo/x",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sq", label: "SQLite" },
  ],
};

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
  const openSession = async (owner: Id<"users">, activate = true) => {
    const { agentSessionId } = await t.mutation(agents.sessions.open, {
      userId: owner,
      credentialId,
      clientName: "Claude Code",
      clientVersion: "2.1.0",
    });
    if (activate) {
      await t.run((ctx) => touch(ctx, owner, agentSessionId, "repo/x", Date.now()));
    }
    return agentSessionId;
  };
  const sessionId = await openSession(userId);
  const ask = (input: Record<string, unknown>, owner = userId, agentSessionId = sessionId) =>
    t.mutation(decisions.operations.create, { userId: owner, agentSessionId, input });
  const load = (id: string) => t.run((ctx) => ctx.db.get("decisions", id as Id<"decisions">));
  const all = () => t.run((ctx) => ctx.db.query("decisions").collect());
  const answer = (id: string, payload: unknown, note?: string, via = "app") =>
    t.run(async (ctx) => {
      const doc = await ctx.db.get("decisions", id as Id<"decisions">);
      if (doc === null) throw new Error("missing");
      return answerDecision(ctx, doc, payload, note, via, Date.now());
    });
  const cancel = (id: string) =>
    t.run(async (ctx) => {
      const doc = await ctx.db.get("decisions", id as Id<"decisions">);
      if (doc === null) throw new Error("missing");
      return cancelDecision(ctx, doc, Date.now());
    });
  return {
    t,
    userId,
    otherUserId,
    sessionId,
    openSession,
    ask,
    load,
    all,
    answer,
    cancel,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("create", () => {
  // req-decision-requests AC-1.3, AC-1.4; req-agent-tools AC-2.1, AC-8.1
  test("inserts a pending decision and returns the Decision read shape", async () => {
    const { ask, sessionId } = await setup();

    const decision = await ask(approve);

    expect(decisionSchema.parse(decision)).toEqual({
      id: decision.id,
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
      agent_session_id: sessionId,
      created_at: new Date(START).toISOString(),
    });
  });

  test("stores the deadline, default, recommendation, and searchable text", async () => {
    const { ask, load } = await setup();
    const deadline = new Date(START + HOUR).toISOString();

    const decision = await ask({
      ...choice,
      priority: "urgent",
      recommendation: { kind: "option", option_id: "pg" },
      deadline,
      default: { kind: "option", option_id: "sq" },
    });

    expect(decision).toMatchObject({
      priority: "urgent",
      deadline,
      recommendation: { kind: "option", option_id: "pg" },
      default: { kind: "option", option_id: "sq" },
    });
    const doc = await load(decision.id);
    expect(doc?.searchText).toBe("Which database?\nPick one\nPostgres\nSQLite");
    expect(doc?.expiryJobId).toBeDefined();
  });

  // req-decision-requests REQ-2
  test.each([
    [{ ...approve }, { kind: "reject" }],
    [{ ...choice }, { kind: "option", option_id: "sq" }],
    [
      { ...choice, input_type: "multiple_choice" },
      { kind: "options", option_ids: ["pg", "sq"] },
    ],
    [
      { ...approve, input_type: "free_text" },
      { kind: "text", text: "Use Postgres" },
    ],
    [
      { ...choice, input_type: "single_choice_or_text" },
      { kind: "text", text: "Neither" },
    ],
  ])("accepts and answers input type %#", async (input, payload) => {
    const { ask, answer } = await setup();

    const decision = await ask(input);
    const answered = await answer(decision.id, payload);

    expect(answered).toMatchObject({ state: "answered", answer: payload });
  });

  // req-decision-requests AC-1.1, AC-1.2, AC-2.1, AC-3.1, AC-5.3; req-agent-tools AC-1.3
  test.each<[string, Record<string, unknown>, string]>([
    ["no title", { input_type: "approve_reject", topic: "repo/x" }, "title"],
    ["a long title", { ...approve, title: "x".repeat(121) }, "title"],
    ["a long body", { ...approve, body: "x".repeat(16001) }, "body"],
    ["no input type", { title: "t", topic: "repo/x" }, "input_type"],
    ["no topic", { title: "t", input_type: "approve_reject" }, "topic"],
    ["an invalid topic", { ...approve, topic: "repo x" }, "topic"],
    ["one option", { ...choice, options: [{ id: "pg", label: "Postgres" }] }, "options"],
    ["no options", { ...choice, options: undefined }, "options"],
    [
      "an invalid recommendation",
      { ...choice, recommendation: { kind: "option", option_id: "nope" } },
      "recommendation.option_id",
    ],
    ["a past deadline", { ...approve, deadline: new Date(START).toISOString() }, "deadline"],
    ["a default without deadline", { ...approve, default: { kind: "approve" } }, "default"],
    [
      "an invalid default",
      {
        ...approve,
        deadline: new Date(START + HOUR).toISOString(),
        default: { kind: "text", text: "x" },
      },
      "default.kind",
    ],
  ])("rejects %s naming the field and inserts nothing", async (_name, input, field) => {
    const { t, ask, all, sessionId } = await setup();
    const before = await t.run((ctx) => ctx.db.get("agentSessions", sessionId));
    vi.setSystemTime(START + 1000);

    await expect(ask(input)).rejects.toMatchObject({ data: { code: "invalid", field } });
    expect(await all()).toHaveLength(0);
    const after = await t.run((ctx) => ctx.db.get("agentSessions", sessionId));
    expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
  });

  // req-decision-requests REQ-6, AC-6.1, AC-6.2
  test("links a follow-up to its parent in both directions", async () => {
    const { t, userId, ask } = await setup();
    const parent = await ask(approve);

    const child = await ask({ ...approve, parent_id: parent.id });

    expect(child.parent_id).toBe(parent.id);
    const read = await t.run((ctx) => getDecision(ctx, userId, parent.id as Id<"decisions">));
    expect(read.follow_up_ids).toEqual([child.id]);
  });

  test("rejects a missing parent and another user's parent alike", async () => {
    const { t, otherUserId, openSession, ask, all } = await setup();
    const otherSession = await openSession(otherUserId);
    const foreign = await ask(approve, otherUserId, otherSession);
    const deleted = await ask(approve);
    await t.run((ctx) => ctx.db.delete("decisions", deleted.id as Id<"decisions">));

    for (const parent_id of [foreign.id, deleted.id, "not-an-id"]) {
      await expect(ask({ ...approve, parent_id })).rejects.toMatchObject({
        data: { code: "invalid", field: "parent_id", message: "parent_id names no decision" },
      });
    }
    expect(await all()).toHaveLength(1);
  });
});

// req-agent-tools AC-2.2
describe("idempotent ask", () => {
  test("returns the first decision for the same key within 24 hours", async () => {
    const { t, userId, openSession, ask, all } = await setup();
    const input = {
      ...approve,
      idempotency_key: "k1",
      deadline: new Date(START + 48 * HOUR).toISOString(),
    };
    const jobs = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const first = await ask(input);
    // The first create schedules its expiry and its event's route.
    const jobsAfterFirst = (await jobs()).length;

    vi.setSystemTime(START + 24 * HOUR - 1);
    const otherSession = await openSession(userId);
    const retried = await ask({ ...input, title: "Changed" }, userId, otherSession);

    expect(retried).toEqual(first);
    expect(await all()).toHaveLength(1);
    const after = await jobs();
    expect(after.filter((job) => job.name === "decisions/expire:run")).toHaveLength(1);
    expect(after).toHaveLength(jobsAfterFirst);
  });

  test("returns the first decision in its current state", async () => {
    const { ask, answer } = await setup();
    const first = await ask({ ...approve, idempotency_key: "k1" });
    await answer(first.id, { kind: "approve" });

    const retried = await ask({ ...approve, idempotency_key: "k1" });

    expect(retried).toMatchObject({ id: first.id, state: "answered" });
  });

  test("creates a new decision once 24 hours have passed", async () => {
    const { ask, all, load } = await setup();
    const first = await ask({ ...approve, idempotency_key: "k1" });
    // Creation times carry sub-millisecond offsets, so the window ends at the
    // first whole millisecond 24 hours after the stored creation time.
    const createdAt = (await load(first.id))?._creationTime ?? START;

    vi.setSystemTime(Math.ceil(createdAt) + 24 * HOUR);
    const second = await ask({ ...approve, idempotency_key: "k1" });
    vi.setSystemTime(START + 30 * HOUR);
    const third = await ask({ ...approve, idempotency_key: "k1" });

    expect(second.id).not.toBe(first.id);
    expect(third.id).toBe(second.id);
    expect(await all()).toHaveLength(2);
  });

  test("scopes the key to the user", async () => {
    const { otherUserId, openSession, ask, all } = await setup();
    const otherSession = await openSession(otherUserId);

    const mine = await ask({ ...approve, idempotency_key: "k1" });
    const theirs = await ask({ ...approve, idempotency_key: "k1" }, otherUserId, otherSession);

    expect(theirs.id).not.toBe(mine.id);
    expect(await all()).toHaveLength(2);
  });
});

describe("answer", () => {
  // req-decision-requests AC-2.5, AC-4.3
  test("records the answer, note, time, and surface and extends the search text", async () => {
    const { ask, answer, load } = await setup();
    const decision = await ask({ ...choice, input_type: "multiple_choice" });
    vi.setSystemTime(START + 5000);

    const answered = await answer(
      decision.id,
      { kind: "options", option_ids: ["sq", "pg"] },
      "Both, for now",
      "notification",
    );

    expect(answered).toMatchObject({
      state: "answered",
      answer: { kind: "options", option_ids: ["sq", "pg"] },
      note: "Both, for now",
      answered_at: new Date(START + 5000).toISOString(),
      answered_via: "notification",
      applied_by_default: false,
    });
    const doc = await load(decision.id);
    expect(doc?.settledAt).toBe(START + 5000);
    expect(doc?.searchText).toBe(
      "Which database?\nPick one\nPostgres\nSQLite\nSQLite\nPostgres\nBoth, for now",
    );
  });

  test("adds free text to the search text", async () => {
    const { ask, answer, load } = await setup();
    const decision = await ask({ ...approve, input_type: "free_text" });

    await answer(decision.id, { kind: "text", text: "Use Postgres" });

    expect((await load(decision.id))?.searchText).toBe("Ship it?\nUse Postgres");
  });

  // req-decision-requests AC-2.2, AC-2.3, AC-2.4, AC-2.5
  test.each<[string, Record<string, unknown>, unknown, string | undefined, string, string]>([
    ["a wrong kind", approve, { kind: "text", text: "x" }, undefined, "app", "answer.kind"],
    [
      "an unknown option",
      choice,
      { kind: "option", option_id: "zz" },
      undefined,
      "app",
      "answer.option_id",
    ],
    [
      "a repeated option",
      { ...choice, input_type: "multiple_choice" },
      { kind: "options", option_ids: ["pg", "pg"] },
      undefined,
      "app",
      "answer.option_ids.1",
    ],
    [
      "an option and text at once",
      { ...choice, input_type: "single_choice_or_text" },
      { kind: "option", option_id: "pg", text: "x" },
      undefined,
      "app",
      "answer",
    ],
    ["a long note", approve, { kind: "approve" }, "x".repeat(2001), "app", "note"],
    ["the default surface", approve, { kind: "approve" }, undefined, "default", "answeredVia"],
  ])("rejects %s and stays pending", async (_name, input, payload, note, via, field) => {
    const { ask, answer, load } = await setup();
    const decision = await ask(input);

    await expect(answer(decision.id, payload, note, via)).rejects.toMatchObject({
      data: { code: "invalid", field },
    });
    const doc = await load(decision.id);
    expect(doc?.state).toBe("pending");
    expect(doc?.answer).toBeUndefined();
  });

  test("accepts a note of exactly 2,000 characters", async () => {
    const { ask, answer } = await setup();
    const decision = await ask(approve);

    const answered = await answer(decision.id, { kind: "approve" }, "x".repeat(2000));

    expect(answered.note).toHaveLength(2000);
  });
});

// req-decision-requests REQ-4, AC-4.1, AC-4.4, AC-7.3
describe("settled decisions", () => {
  test("cancel records no answer", async () => {
    const { ask, cancel, load } = await setup();
    const decision = await ask(approve);
    vi.setSystemTime(START + 1000);

    const cancelled = await cancel(decision.id);

    expect(cancelled).toMatchObject({ state: "cancelled", answer: null, answered_at: null });
    expect((await load(decision.id))?.settledAt).toBe(START + 1000);
  });

  test.each([
    ["answered", "answer"],
    ["answered", "cancel"],
    ["cancelled", "answer"],
    ["cancelled", "cancel"],
    ["expired", "answer"],
    ["expired", "cancel"],
  ])("a %s decision refuses %s with conflict carrying the stored decision", async (state, act) => {
    const { t, ask, answer, cancel, load } = await setup();
    const decision = await ask({
      ...approve,
      deadline: new Date(START + HOUR).toISOString(),
      default: { kind: "approve" },
    });
    let settled: Decision;
    if (state === "answered") {
      settled = await answer(decision.id, { kind: "approve" });
    } else if (state === "cancelled") {
      settled = await cancel(decision.id);
    } else {
      vi.setSystemTime(START + HOUR);
      settled = await t.run(async (ctx) => {
        const doc = await ctx.db.get("decisions", decision.id as Id<"decisions">);
        if (doc === null) throw new Error("missing");
        return expireDecision(ctx, doc, Date.now());
      });
      expect(settled).toMatchObject({ state: "expired", applied_by_default: true });
    }
    const stored = await load(decision.id);

    const attempt =
      act === "answer" ? answer(decision.id, { kind: "reject" }) : cancel(decision.id);

    await expect(attempt).rejects.toMatchObject({
      data: { code: "conflict", decision: settled },
    });
    expect(await load(decision.id)).toEqual(stored);
  });
});

// req-agent-tools AC-4.1, AC-4.2, AC-7.1
describe("check", () => {
  const check = (setupResult: Awaited<ReturnType<typeof setup>>, decisionIds: string[]) =>
    setupResult.t.mutation(decisions.operations.check, {
      userId: setupResult.userId,
      agentSessionId: setupResult.sessionId,
      decisionIds,
    });

  test("returns each decision in request order, keeping duplicates", async () => {
    const s = await setup();
    const a = await s.ask(approve);
    const b = await s.ask(choice);
    await s.answer(b.id, { kind: "option", option_id: "pg" }, "Postgres it is");

    const result = await check(s, [b.id, a.id, b.id]);

    expect(result.map((d) => d.id)).toEqual([b.id, a.id, b.id]);
    expect(result[0]).toMatchObject({
      state: "answered",
      answer: { kind: "option", option_id: "pg" },
      note: "Postgres it is",
    });
    expect(result[1]?.state).toBe("pending");
  });

  test("returns an empty result for no ids", async () => {
    const s = await setup();

    expect(await check(s, [])).toEqual([]);
  });

  test("accepts 50 ids and rejects 51", async () => {
    const s = await setup();
    const decision = await s.ask(approve);

    expect(await check(s, Array(50).fill(decision.id))).toHaveLength(50);
    await expect(check(s, Array(51).fill(decision.id))).rejects.toMatchObject({
      data: { code: "invalid", field: "decisionIds" },
    });
  });

  test("rejects a malformed id naming its element", async () => {
    const s = await setup();
    const decision = await s.ask(approve);

    await expect(check(s, [decision.id, "nope"])).rejects.toMatchObject({
      data: { code: "invalid", field: "decisionIds.1" },
    });
  });

  test("fails the whole call with the same not_found for unknown and foreign ids", async () => {
    const s = await setup();
    const mine = await s.ask(approve);
    const otherSession = await s.openSession(s.otherUserId);
    const foreign = await s.ask(approve, s.otherUserId, otherSession);
    const deleted = await s.ask(approve);
    await s.t.run((ctx) => ctx.db.delete("decisions", deleted.id as Id<"decisions">));

    const errors = [];
    for (const id of [foreign.id, deleted.id]) {
      errors.push(await check(s, [mine.id, id]).catch((error) => error.data));
    }

    expect(errors[0]).toEqual({ code: "not_found", message: "Decision not found" });
    expect(errors[1]).toEqual(errors[0]);
  });
});

// req-decision-requests REQ-7, AC-7.1, AC-7.2; component-agent-presence §Sweep
test("a decision stays readable and answerable after its session is purged", async () => {
  const { t, userId, sessionId, openSession, ask, answer } = await setup();
  const decision = await ask(approve);
  await t.run((ctx) => ctx.db.delete("agentSessions", sessionId));

  const otherSession = await openSession(userId);
  const polled = await t.mutation(decisions.operations.poll, {
    userId,
    agentSessionId: otherSession,
    decisionId: decision.id,
  });
  const answered = await answer(decision.id, { kind: "approve" });

  expect(polled).toMatchObject({ state: "pending", agent_session_id: sessionId });
  expect(answered).toMatchObject({ state: "answered", agent_session_id: sessionId });
});
