import { type Decision, decisionSchema } from "@agentdesk/contract";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { comparePending } from "./appReads";
import { cancelDecision } from "./model";
import { decisions } from "./refs";

const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found", message: "Decision not found" } };

const approve = { title: "Ship it?", input_type: "approve_reject", topic: "repo/x" };
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
  const openSession = async (owner: Id<"users">) => {
    const { agentSessionId } = await t.mutation(agents.sessions.open, {
      userId: owner,
      credentialId,
      clientName: "Claude Code",
      clientVersion: "2.1.0",
    });
    await t.run((ctx) => touch(ctx, owner, agentSessionId, "repo/x", Date.now()));
    return agentSessionId;
  };
  const sessionId = await openSession(userId);
  const otherSessionId = await openSession(otherUserId);
  const ask = (input: Record<string, unknown>, owner = userId, agentSessionId = sessionId) =>
    t.mutation(decisions.operations.create, { userId: owner, agentSessionId, input });
  const asA = t.withIdentity({ subject: "user_a" });
  const asB = t.withIdentity({ subject: "user_b" });
  const load = (id: string) => t.run((ctx) => ctx.db.get("decisions", id as Id<"decisions">));
  const answer = (decisionId: string, payload: unknown, note?: unknown) =>
    asA.mutation(decisions.app.answer, {
      decisionId,
      answer: payload,
      ...(note === undefined ? {} : { note }),
    });
  return {
    t,
    userId,
    otherUserId,
    sessionId,
    otherSessionId,
    ask,
    asA,
    asB,
    load,
    answer,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("listPending", () => {
  // req-mobile-app AC-2.1
  test("orders urgent first, then deadline with none last, then oldest", async () => {
    const { ask, asA } = await setup();
    const at = (offset: number) => new Date(START + offset).toISOString();
    const normalNone = await ask({ ...approve, title: "normal, no deadline" });
    const normalLate = await ask({ ...approve, title: "normal, late", deadline: at(2 * HOUR) });
    const urgentNone = await ask({ ...approve, title: "urgent, no deadline", priority: "urgent" });
    const normalEarly = await ask({ ...approve, title: "normal, early", deadline: at(HOUR) });
    const urgentLate = await ask({
      ...approve,
      title: "urgent, late",
      priority: "urgent",
      deadline: at(2 * HOUR),
    });
    const urgentEarly = await ask({
      ...approve,
      title: "urgent, early",
      priority: "urgent",
      deadline: at(HOUR),
    });
    const normalNoneNewer = await ask({ ...approve, title: "normal, no deadline, newer" });
    const urgentEarlyNewer = await ask({
      ...approve,
      title: "urgent, early, newer",
      priority: "urgent",
      deadline: at(HOUR),
    });

    const listed = await asA.query(decisions.app.listPending, {});

    expect(listed.map((d) => d.id)).toEqual(
      [
        urgentEarly,
        urgentEarlyNewer,
        urgentLate,
        urgentNone,
        normalEarly,
        normalLate,
        normalNone,
        normalNoneNewer,
      ].map((d) => d.id),
    );
    for (const decision of listed) {
      expect(decisionSchema.parse(decision)).toEqual(decision);
    }
  });

  // Rows cannot share a creation time under convex-test, so the id tie-break
  // is checked on the comparator itself.
  test("breaks a creation-time tie by id", () => {
    const row = (id: string) =>
      ({
        _id: id,
        _creationTime: START,
        priority: "normal",
        deadline: undefined,
      }) as unknown as Doc<"decisions">;

    expect([row("b"), row("a"), row("c")].sort(comparePending).map((d) => d._id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  // req-mobile-app AC-2.1, AC-2.3; req-decision-requests REQ-4, REQ-5
  test("excludes every settled state and follows creation and settlement", async () => {
    const { t, ask, asA, answer, otherUserId, otherSessionId } = await setup();
    const answered = await ask(approve);
    const cancelled = await ask(approve);
    const expired = await ask({ ...approve, deadline: new Date(START + MINUTE).toISOString() });
    const kept = await ask(approve);
    await ask(approve, otherUserId, otherSessionId);
    const ids = async () => (await asA.query(decisions.app.listPending, {})).map((d) => d.id);
    expect(await ids()).toEqual([expired.id, answered.id, cancelled.id, kept.id]);

    await answer(answered.id, { kind: "approve" });
    await t.run(async (ctx) => {
      const doc = await ctx.db.get("decisions", cancelled.id as Id<"decisions">);
      if (doc === null) throw new Error("missing");
      await cancelDecision(ctx, doc, Date.now());
    });
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();
    expect(await ids()).toEqual([kept.id]);

    const created = await ask(approve);
    expect(await ids()).toEqual([kept.id, created.id]);
  });

  test("is unauthenticated without an active account", async () => {
    const { t } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_gone", email: "g@example.com", deletingAt: 0 }),
    );

    await expect(t.query(decisions.app.listPending, {})).rejects.toMatchObject(unauthenticated);
    await expect(
      t.withIdentity({ subject: "user_missing" }).query(decisions.app.listPending, {}),
    ).rejects.toMatchObject(unauthenticated);
    await expect(
      t.withIdentity({ subject: "user_gone" }).query(decisions.app.listPending, {}),
    ).rejects.toMatchObject(unauthenticated);
  });
});

describe("get", () => {
  // req-mobile-app AC-3.1; req-decision-requests AC-3.2, AC-6.2, REQ-7
  test("returns an owned decision with its recommendation, parent, and follow-ups", async () => {
    const { t, ask, asA, sessionId } = await setup();
    const parent = await ask({ ...single, recommendation: { kind: "option", option_id: "pg" } });
    const followUp = await ask({ ...approve, parent_id: parent.id });

    const read = await asA.query(decisions.app.get, { decisionId: parent.id });
    expect(decisionSchema.parse(read)).toEqual({
      ...parent,
      follow_up_ids: [followUp.id],
    });
    expect(read.recommendation).toEqual({ kind: "option", option_id: "pg" });
    expect(await asA.query(decisions.app.get, { decisionId: followUp.id })).toMatchObject({
      parent_id: parent.id,
    });

    // The asking session's purge leaves the decision readable and answerable.
    await t.run((ctx) => ctx.db.delete("agentSessions", sessionId));
    expect(await asA.query(decisions.app.get, { decisionId: parent.id })).toEqual(read);
    await expect(
      asA.mutation(decisions.app.answer, {
        decisionId: parent.id,
        answer: { kind: "option", option_id: "sq" },
      }),
    ).resolves.toMatchObject({ state: "answered", answered_via: "app" });
  });

  // req-accounts-and-connections AC-1.1
  test("answers not_found for a missing or foreign id and invalid for a malformed one", async () => {
    const { t, ask, asA, asB } = await setup();
    const decision = await ask(approve);
    const gone = await ask(approve);
    await t.run((ctx) => ctx.db.delete("decisions", gone.id as Id<"decisions">));

    await expect(asB.query(decisions.app.get, { decisionId: decision.id })).rejects.toMatchObject(
      notFound,
    );
    await expect(asA.query(decisions.app.get, { decisionId: gone.id })).rejects.toMatchObject(
      notFound,
    );
    await expect(asA.query(decisions.app.get, { decisionId: "nope" })).rejects.toMatchObject({
      data: { code: "invalid", field: "decisionId" },
    });
    await expect(t.query(decisions.app.get, { decisionId: decision.id })).rejects.toMatchObject(
      unauthenticated,
    );
  });
});

describe("answer", () => {
  // req-decision-requests AC-2.3, AC-2.4, AC-2.5, AC-4.3
  test.each([
    ["approve", approve, { kind: "approve" }],
    ["reject", approve, { kind: "reject" }],
    ["single choice", single, { kind: "option", option_id: "sq" }],
    ["multiple choice", multiple, { kind: "options", option_ids: ["pg", "sq"] }],
    ["free text", freeText, { kind: "text", text: "agentdesk" }],
    ["single choice or text, option", choiceOrText, { kind: "option", option_id: "pg" }],
    ["single choice or text, text", choiceOrText, { kind: "text", text: "DuckDB" }],
  ])("records a %s answer through the app surface", async (_, input, payload) => {
    const { ask, answer, load } = await setup();
    const decision = await ask(input);
    vi.advanceTimersByTime(MINUTE);

    const answered = await answer(decision.id, payload, "Looks right");

    expect(decisionSchema.parse(answered)).toEqual({
      ...decision,
      state: "answered",
      answer: payload,
      note: "Looks right",
      answered_at: new Date(START + MINUTE).toISOString(),
      answered_via: "app",
    });
    expect(await load(decision.id)).toMatchObject({
      answeredVia: "app",
      settledAt: START + MINUTE,
    });
  });

  test("takes no answer surface from the client", async () => {
    const { ask, asA, load } = await setup();
    const decision = await ask(approve);

    await expect(
      asA.mutation(decisions.app.answer, {
        decisionId: decision.id,
        answer: { kind: "approve" },
        answeredVia: "api",
      } as never),
    ).rejects.toThrow();
    expect((await load(decision.id))?.state).toBe("pending");
  });

  // req-decision-requests AC-2.2, AC-2.5
  test.each([
    ["a wrong answer kind", single, { kind: "approve" }, undefined, "answer.kind"],
    [
      "an unknown option",
      single,
      { kind: "option", option_id: "zz" },
      undefined,
      "answer.option_id",
    ],
    ["no answer object", approve, "approve", undefined, "answer"],
    [
      "empty options",
      multiple,
      { kind: "options", option_ids: [] },
      undefined,
      "answer.option_ids",
    ],
    ["empty text", choiceOrText, { kind: "text", text: "" }, undefined, "answer.text"],
    ["an over-length note", approve, { kind: "approve" }, "x".repeat(2001), "note"],
    ["a non-string note", approve, { kind: "approve" }, 42, "note"],
  ])(
    "rejects %s as invalid and leaves the decision pending",
    async (_, input, payload, note, field) => {
      const { ask, answer, load } = await setup();
      const decision = await ask(input);

      const error = await answer(decision.id, payload, note).catch((e: unknown) => e);

      expect(error).toMatchObject({ data: { code: "invalid" } });
      expect((error as { data: { field: string } }).data.field.startsWith(field)).toBe(true);
      expect(await load(decision.id)).toMatchObject({ state: "pending" });
      expect((await load(decision.id))?.answer).toBeUndefined();
    },
  );

  test("accepts a note of exactly 2,000 characters", async () => {
    const { ask, answer } = await setup();
    const decision = await ask(approve);

    await expect(answer(decision.id, { kind: "approve" }, "x".repeat(2000))).resolves.toMatchObject(
      { note: "x".repeat(2000) },
    );
  });

  // req-decision-requests AC-4.1; req-mobile-app AC-3.2
  test("answers conflict carrying the stored decision for every settled state", async () => {
    const { t, ask, answer, asA } = await setup();
    const answered = await ask(single);
    const stored = await answer(answered.id, { kind: "option", option_id: "pg" }, "First");
    const cancelled = await ask(approve);
    await t.run(async (ctx) => {
      const doc = await ctx.db.get("decisions", cancelled.id as Id<"decisions">);
      if (doc === null) throw new Error("missing");
      await cancelDecision(ctx, doc, Date.now());
    });
    const expired = await ask({
      ...approve,
      deadline: new Date(START + MINUTE).toISOString(),
      default: { kind: "reject" },
    });
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();

    for (const id of [answered.id, cancelled.id, expired.id]) {
      const before = await asA.query(decisions.app.get, { decisionId: id });
      const error = await answer(id, { kind: "approve" }, "Late").catch((e: unknown) => e);

      // The data a client receives: convex-test serializes ConvexError data
      // as Convex JSON across the function boundary, as the deployment does.
      const data = (error as { data: { code: string; decision: Decision } }).data;
      expect(data.code).toBe("conflict");
      expect(data.decision).toEqual(before);
      expect(jsonToConvex(JSON.parse(JSON.stringify(convexToJson(data as Value))))).toEqual(data);
      expect(await asA.query(decisions.app.get, { decisionId: id })).toEqual(before);
    }
    expect(
      (
        (await answer(answered.id, { kind: "option", option_id: "sq" }).catch(
          (e: unknown) => e,
        )) as {
          data: { decision: Decision };
        }
      ).data.decision,
    ).toEqual(stored);
    expect(stored).toMatchObject({ answer: { kind: "option", option_id: "pg" }, note: "First" });
    expect(
      (await asA.query(decisions.app.get, { decisionId: expired.id })).applied_by_default,
    ).toBe(true);
  });

  // req-decision-requests AC-4.2
  test("of two concurrent answers exactly one wins and the other carries it", async () => {
    const { ask, answer, load } = await setup();
    const decision = await ask(single);

    const results = await Promise.allSettled([
      answer(decision.id, { kind: "option", option_id: "pg" }),
      answer(decision.id, { kind: "option", option_id: "sq" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0]?.value;
    expect(rejected[0]?.reason).toMatchObject({ data: { code: "conflict", decision: winner } });
    expect((await load(decision.id))?.answer).toEqual(winner?.answer);
  });

  // req-accounts-and-connections AC-1.1
  test("answers not_found for a foreign or missing decision and leaves it unchanged", async () => {
    const { t, ask, asB, answer, load } = await setup();
    const decision = await ask(approve);
    const gone = await ask(approve);
    await t.run((ctx) => ctx.db.delete("decisions", gone.id as Id<"decisions">));

    await expect(
      asB.mutation(decisions.app.answer, { decisionId: decision.id, answer: { kind: "approve" } }),
    ).rejects.toMatchObject(notFound);
    await expect(answer(gone.id, { kind: "approve" })).rejects.toMatchObject(notFound);
    await expect(answer("nope", { kind: "approve" })).rejects.toMatchObject({
      data: { code: "invalid", field: "decisionId" },
    });
    expect(await load(decision.id)).toMatchObject({ state: "pending" });
    expect((await load(decision.id))?.answer).toBeUndefined();
  });

  test("is unauthenticated without a signed-in person", async () => {
    const { t, ask, load } = await setup();
    const decision = await ask(approve);

    await expect(
      t.mutation(decisions.app.answer, { decisionId: decision.id, answer: { kind: "approve" } }),
    ).rejects.toMatchObject(unauthenticated);
    expect((await load(decision.id))?.state).toBe("pending");
  });
});
