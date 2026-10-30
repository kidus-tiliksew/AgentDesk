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
import { cancelDecision, cancelForAgentSession } from "./model";
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
    // `stored` was read before routing ran. The route has since stored push,
    // the default action for decision.created.
    expect(
      (
        (await answer(answered.id, { kind: "option", option_id: "sq" }).catch(
          (e: unknown) => e,
        )) as {
          data: { decision: Decision };
        }
      ).data.decision,
    ).toEqual({ ...stored, notification_action: "push" });
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
// History, removal, and notification answers (component-decisions §History,
// §Removal, §App functions).
// §App functions).

type HistoryArgs = {
  query?: string;
  state?: string;
  topic?: string;
  numItems?: number;
  cursor?: string | null;
};

async function historySetup() {
  const base = await setup();
  const { t, userId, sessionId, asA } = base;
  const cancel = (decisionId: string) =>
    t.mutation(decisions.operations.cancel, { userId, decisionId });
  const remove = (decisionId: string) => asA.mutation(decisions.app.remove, { decisionId });
  const fromNotification = (decisionId: string, action: unknown) =>
    asA.mutation(decisions.app.answerFromNotification, { decisionId, action });
  const history = (args: HistoryArgs = {}, as = asA) => {
    const { numItems = 10, cursor = null, ...filters } = args;
    return as.query(decisions.app.searchHistory, {
      ...filters,
      paginationOpts: { numItems, cursor },
    });
  };
  const historyIds = async (args: HistoryArgs = {}) =>
    (await history(args)).page.map((item) => item.decision.id);
  // Every id in history order, page by page, until the native result is done.
  const allPages = async (args: HistoryArgs, numItems: number) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const result = await history({ ...args, numItems, cursor });
      ids.push(...result.page.map((item) => item.decision.id));
      if (result.isDone) {
        return { ids, pages: pages + 1 };
      }
      cursor = result.continueCursor;
    }
    throw new Error("history did not finish");
  };
  // Settled rows written directly, for page-size and scan tests that need
  // many rows or a shared settlement time.
  const insertSettled = (
    rows: {
      topic?: string;
      title?: string;
      state?: "answered" | "expired" | "cancelled";
      settledAt: number;
      owner?: Id<"users">;
    }[],
  ) =>
    t.run(async (ctx) => {
      const ids: string[] = [];
      for (const row of rows) {
        const title = row.title ?? "Bulk row";
        ids.push(
          await ctx.db.insert("decisions", {
            userId: row.owner ?? userId,
            agentSessionId: sessionId,
            topic: row.topic ?? "repo/x",
            title,
            inputType: "approve_reject",
            priority: "normal",
            state: row.state ?? "cancelled",
            searchText: title,
            settledAt: row.settledAt,
          }),
        );
      }
      return ids;
    });
  return {
    ...base,
    cancel,
    remove,
    fromNotification,
    history,
    historyIds,
    allPages,
    insertSettled,
  };
}

describe("searchHistory", () => {
  // req-mobile-app AC-6.1
  test("matches text in titles, bodies, answer labels, answer text, and notes", async () => {
    const { ask, answer, cancel, historyIds } = await historySetup();
    const byTitle = await ask({ ...approve, title: "Alphatitle release" });
    await answer(byTitle.id, { kind: "approve" });
    const byBody = await ask({ ...approve, body: "Run the bravobody migration" });
    await cancel(byBody.id);
    const byLabel = await ask({
      ...single,
      options: [
        { id: "a", label: "Charlielabel" },
        { id: "b", label: "Other" },
      ],
    });
    await answer(byLabel.id, { kind: "option", option_id: "a" });
    const byText = await ask(freeText);
    await answer(byText.id, { kind: "text", text: "deltatext" });
    const byNote = await ask(approve);
    await answer(byNote.id, { kind: "reject" }, "echonote please");

    expect(await historyIds({ query: "alphatitle" })).toEqual([byTitle.id]);
    expect(await historyIds({ query: "bravobody" })).toEqual([byBody.id]);
    expect(await historyIds({ query: "charlielabel" })).toEqual([byLabel.id]);
    expect(await historyIds({ query: "deltatext" })).toEqual([byText.id]);
    expect(await historyIds({ query: "  echonote  " })).toEqual([byNote.id]);
    expect(await historyIds({ query: "nomatchword" })).toEqual([]);
  });

  test("returns only the person's settled decisions on both paths", async () => {
    const { ask, answer, historyIds, otherUserId, otherSessionId, t } = await historySetup();
    const settled = await ask({ ...approve, title: "Shared word" });
    await answer(settled.id, { kind: "approve" });
    await ask({ ...approve, title: "Shared word pending" });
    const foreign = await ask(
      { ...approve, title: "Shared word foreign" },
      otherUserId,
      otherSessionId,
    );
    await t.mutation(decisions.operations.cancel, {
      userId: otherUserId,
      decisionId: foreign.id,
    });

    expect(await historyIds({ query: "shared" })).toEqual([settled.id]);
    expect(await historyIds()).toEqual([settled.id]);
  });

  // req-mobile-app AC-6.1
  test("filters by state on both paths and refuses a state that is not settled", async () => {
    const { t, ask, answer, cancel, historyIds, history } = await historySetup();
    const answered = await ask({ ...approve, title: "Filter me" });
    await answer(answered.id, { kind: "approve" });
    vi.advanceTimersByTime(MINUTE);
    const cancelled = await ask({ ...approve, title: "Filter me" });
    await cancel(cancelled.id);
    const expired = await ask({
      ...approve,
      title: "Filter me",
      deadline: new Date(Date.now() + MINUTE).toISOString(),
    });
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();

    for (const query of [undefined, "filter"]) {
      expect(await historyIds({ query, state: "answered" })).toEqual([answered.id]);
      expect(await historyIds({ query, state: "cancelled" })).toEqual([cancelled.id]);
      expect(await historyIds({ query, state: "expired" })).toEqual([expired.id]);
    }
    for (const state of ["pending", "bogus", ""]) {
      await expect(history({ state })).rejects.toMatchObject({
        data: { code: "invalid", field: "state" },
      });
    }
  });

  // req-mobile-app AC-2.4, AC-6.1: the notification-rule topic rule.
  test("filters by topic so acme matches acme/billing and not acmecorp", async () => {
    const { ask, cancel, historyIds, history } = await historySetup();
    const ids: Record<string, string> = {};
    for (const topic of [
      "acme",
      "acme/billing",
      "acme/billing/eu",
      "acmecorp",
      "acme-x",
      "acme.x",
      "other",
    ]) {
      const decision = await ask({ ...approve, title: `Topic case ${topic}`, topic });
      await cancel(decision.id);
      ids[topic] = decision.id;
      vi.advanceTimersByTime(MINUTE);
    }
    const expected = [ids["acme/billing/eu"], ids["acme/billing"], ids.acme];

    expect(await historyIds({ topic: "acme" })).toEqual(expected);
    expect(await historyIds({ topic: "ACME" })).toEqual(expected);
    expect((await historyIds({ query: "topic", topic: "acme" })).sort()).toEqual(
      [...expected].sort(),
    );
    expect(await historyIds({ topic: "acme/billing" })).toEqual(expected.slice(0, 2));
    expect(await historyIds({ topic: "acme/bill" })).toEqual([]);
    await expect(history({ topic: "not a topic" })).rejects.toMatchObject({
      data: { code: "invalid", field: "topic" },
    });
  });

  test("lists empty and whitespace text newest settled first, ties in index order", async () => {
    const { ask, answer, cancel, historyIds, insertSettled } = await historySetup();
    const first = await ask(approve);
    const second = await ask(approve);
    const third = await ask(approve);
    vi.advanceTimersByTime(MINUTE);
    await answer(third.id, { kind: "approve" });
    vi.advanceTimersByTime(MINUTE);
    await cancel(first.id);
    vi.advanceTimersByTime(MINUTE);
    await answer(second.id, { kind: "reject" });
    const order = [second.id, first.id, third.id];

    expect(await historyIds()).toEqual(order);
    expect(await historyIds({ query: "   " })).toEqual(order);

    // Two rows settled at the same instant follow Convex's descending index
    // order, which ends with creation time.
    const [older, newer] = await insertSettled([
      { settledAt: START + HOUR },
      { settledAt: START + HOUR },
    ]);
    expect(await historyIds()).toEqual([newer, older, ...order]);
  });

  test("returns each settlement instant as settled_at for every settled state", async () => {
    const { t, asA, ask, answer, cancel, history } = await historySetup();
    vi.advanceTimersByTime(MINUTE);
    const answered = await ask(approve);
    await answer(answered.id, { kind: "approve" });
    vi.advanceTimersByTime(MINUTE);
    const cancelled = await ask(approve);
    await cancel(cancelled.id);
    const withDefault = await ask({
      ...approve,
      deadline: new Date(Date.now() + MINUTE).toISOString(),
      default: { kind: "reject" },
    });
    const withoutDefault = await ask({
      ...approve,
      deadline: new Date(Date.now() + 2 * MINUTE).toISOString(),
    });
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();
    const firstExpiry = Date.now();
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();
    const secondExpiry = Date.now();

    const result = await history();
    const settledAt = Object.fromEntries(
      result.page.map((item) => [item.decision.id, item.settled_at]),
    );
    const stored = await t.run((ctx) => ctx.db.query("decisions").collect());
    for (const doc of stored) {
      expect(settledAt[doc._id]).toBe(new Date(doc.settledAt ?? 0).toISOString());
    }
    expect(settledAt[answered.id]).toBe(new Date(START + MINUTE).toISOString());
    expect(settledAt[cancelled.id]).toBe(new Date(START + 2 * MINUTE).toISOString());
    expect(Date.parse(settledAt[withDefault.id] ?? "")).toBeGreaterThanOrEqual(START + 3 * MINUTE);
    expect(Date.parse(settledAt[withDefault.id] ?? "")).toBeLessThanOrEqual(firstExpiry);
    expect(Date.parse(settledAt[withoutDefault.id] ?? "")).toBeLessThanOrEqual(secondExpiry);
    expect(result.page.map((item) => item.decision.state).sort()).toEqual([
      "answered",
      "cancelled",
      "expired",
      "expired",
    ]);
    for (const item of result.page) {
      expect(decisionSchema.parse(item.decision)).toEqual(item.decision);
      expect(item.decision).toEqual(
        await asA.query(decisions.app.get, { decisionId: item.decision.id }),
      );
    }
  });

  test("pages both paths natively without duplicates or omissions", async () => {
    const { historyIds, allPages, history, insertSettled } = await historySetup();
    const ids = await insertSettled(
      Array.from({ length: 7 }, (_, i) => ({ title: "Paged row", settledAt: START + i * MINUTE })),
    );
    const newestFirst = [...ids].reverse();

    const listed = await allPages({}, 3);
    expect(listed.ids).toEqual(newestFirst);
    expect(listed.pages).toBe(3);
    const searched = await allPages({ query: "paged" }, 3);
    expect([...searched.ids].sort()).toEqual([...ids].sort());
    expect(searched.ids).toHaveLength(7);

    // The native result's metadata reaches the client.
    const first = await history({ numItems: 3 });
    expect(first.isDone).toBe(false);
    expect(typeof first.continueCursor).toBe("string");
    expect(first.page).toHaveLength(3);
    const last = await history({ numItems: 50 });
    expect(last.isDone).toBe(true);
    expect(await historyIds({ numItems: 50 })).toEqual(newestFirst);
  });

  test("fills a filtered page past more than a raw page of excluded rows", async () => {
    const { allPages, history, insertSettled } = await historySetup();
    const matching = await insertSettled([
      { topic: "acme", title: "Scan row", settledAt: START + 1 },
      { topic: "acme/billing", title: "Scan row", settledAt: START + 2 },
      { topic: "acme/billing", title: "Scan row", state: "answered", settledAt: START + 3 },
    ]);
    await insertSettled(
      Array.from({ length: 60 }, (_, i) => ({
        topic: "acmecorp",
        title: "Scan row",
        settledAt: START + 1000 + i,
      })),
    );

    for (const query of [undefined, "scan"]) {
      const page = await history({ query, topic: "acme", numItems: 2 });
      expect(page.page).toHaveLength(2);
      expect(page.isDone).toBe(false);
      const all = await allPages({ query, topic: "acme" }, 2);
      expect([...all.ids].sort()).toEqual([...matching].sort());
      const answered = await allPages({ query, topic: "acme", state: "answered" }, 1);
      expect(answered.ids).toEqual([matching[2]]);
    }
    expect((await allPages({ topic: "acme" }, 2)).ids).toEqual([...matching].reverse());
  });

  test("clamps the page size to 1..50 on the server", async () => {
    const { history, insertSettled } = await historySetup();
    await insertSettled(
      Array.from({ length: 55 }, (_, i) => ({ title: "Clamp row", settledAt: START + i })),
    );

    for (const query of [undefined, "clamp"]) {
      expect((await history({ query, numItems: 0 })).page).toHaveLength(1);
      expect((await history({ query, numItems: -5 })).page).toHaveLength(1);
      expect((await history({ query, numItems: 1 })).page).toHaveLength(1);
      expect((await history({ query, numItems: 50 })).page).toHaveLength(50);
      expect((await history({ query, numItems: 500 })).page).toHaveLength(50);
    }
  });

  test("continues after the row at a page boundary is removed", async () => {
    const { history, remove, insertSettled } = await historySetup();
    const ids = await insertSettled(
      Array.from({ length: 5 }, (_, i) => ({ title: "Edge row", settledAt: START + i })),
    );
    const newestFirst = [...ids].reverse();

    const first = await history({ numItems: 2 });
    expect(first.page.map((item) => item.decision.id)).toEqual(newestFirst.slice(0, 2));
    await remove(newestFirst[1] ?? "");
    const rest = await history({ numItems: 10, cursor: first.continueCursor });
    expect(rest.page.map((item) => item.decision.id)).toEqual(newestFirst.slice(2));
    expect(rest.isDone).toBe(true);
  });

  test("is unauthenticated without an active account, on every page", async () => {
    const { t, history, insertSettled } = await historySetup();
    await insertSettled([{ settledAt: START }, { settledAt: START + 1 }]);
    const first = await history({ numItems: 1 });

    await expect(history({}, t as never)).rejects.toMatchObject(unauthenticated);
    await expect(
      history({ numItems: 1, cursor: first.continueCursor }, t as never),
    ).rejects.toMatchObject(unauthenticated);
    await expect(
      history({}, t.withIdentity({ subject: "user_missing" }) as never),
    ).rejects.toMatchObject(unauthenticated);
  });

  test("takes no user from the client", async () => {
    const { asA, userId } = await historySetup();

    await expect(
      asA.query(decisions.app.searchHistory, {
        paginationOpts: { numItems: 1, cursor: null },
        userId,
      } as never),
    ).rejects.toThrow();
  });
});

describe("remove", () => {
  // req-mobile-app AC-6.2
  test("deletes each settled state from every decision surface", async () => {
    const { t, ask, answer, cancel, remove, history, asA, userId, sessionId, load } =
      await historySetup();
    const answered = await ask({ ...approve, title: "Gone row" });
    await answer(answered.id, { kind: "approve" });
    const cancelled = await ask({ ...approve, title: "Gone row" });
    await cancel(cancelled.id);
    const expired = await ask({
      ...approve,
      title: "Gone row",
      deadline: new Date(START + MINUTE).toISOString(),
    });
    const kept = await ask({ ...approve, title: "Gone row" });
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();
    const check = (ids: string[]) =>
      t.mutation(decisions.operations.check, {
        userId,
        agentSessionId: sessionId,
        decisionIds: ids,
      });

    for (const decision of [answered, cancelled, expired]) {
      await expect(remove(decision.id)).resolves.toBeNull();
      expect(await load(decision.id)).toBeNull();
      await expect(asA.query(decisions.app.get, { decisionId: decision.id })).rejects.toMatchObject(
        notFound,
      );
      await expect(check([kept.id, decision.id])).rejects.toMatchObject(notFound);
      await expect(
        t.mutation(decisions.operations.poll, {
          userId,
          agentSessionId: sessionId,
          decisionId: decision.id,
        }),
      ).rejects.toMatchObject(notFound);
    }
    expect((await history()).page).toEqual([]);
    expect((await history({ query: "gone" })).page).toEqual([]);
    expect((await asA.query(decisions.app.listPending, {})).map((d) => d.id)).toEqual([kept.id]);
    expect(await check([kept.id])).toHaveLength(1);
  });

  test("refuses a pending decision as conflict and leaves it unchanged", async () => {
    const { ask, remove, load } = await historySetup();
    const decision = await ask({ ...approve, deadline: new Date(START + HOUR).toISOString() });
    const before = await load(decision.id);

    await expect(remove(decision.id)).rejects.toMatchObject({ data: { code: "conflict" } });
    expect(await load(decision.id)).toEqual(before);
  });

  // req-accounts-and-connections AC-1.1
  test("answers not_found alike for missing, foreign, and removed ids", async () => {
    const { ask, cancel, remove, asB, load } = await historySetup();
    const decision = await ask(approve);
    await cancel(decision.id);
    const removed = await ask(approve);
    await cancel(removed.id);
    await remove(removed.id);

    const foreign = await asB
      .mutation(decisions.app.remove, { decisionId: decision.id })
      .catch((e: unknown) => e);
    const repeated = await remove(removed.id).catch((e: unknown) => e);
    expect((foreign as { data: unknown }).data).toEqual({
      code: "not_found",
      message: "Decision not found",
    });
    expect((repeated as { data: unknown }).data).toEqual((foreign as { data: unknown }).data);
    await expect(remove("nope")).rejects.toMatchObject({
      data: { code: "invalid", field: "decisionId" },
    });
    expect(await load(decision.id)).not.toBeNull();
  });

  test("leaves no expiry job behind after expiry, an answer, or a cancellation", async () => {
    const { t, ask, answer, cancel, remove, load } = await historySetup();
    const deadline = new Date(START + MINUTE).toISOString();
    const expired = await ask({ ...approve, deadline, default: { kind: "approve" } });
    const answered = await ask({ ...approve, deadline: new Date(START + HOUR).toISOString() });
    const cancelled = await ask({ ...approve, deadline: new Date(START + HOUR).toISOString() });
    await answer(answered.id, { kind: "reject" });
    await cancel(cancelled.id);
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();
    const jobs = async () => {
      const states: Record<string, string | undefined> = {};
      for (const id of [expired.id, answered.id, cancelled.id]) {
        const jobId = (await load(id))?.expiryJobId;
        if (jobId !== undefined) {
          states[id] = (await t.run((ctx) => ctx.db.system.get(jobId)))?.state.kind;
        }
      }
      return states;
    };
    expect(await jobs()).toEqual({
      [expired.id]: "success",
      [answered.id]: "canceled",
      [cancelled.id]: "canceled",
    });

    for (const id of [expired.id, answered.id, cancelled.id]) {
      await expect(remove(id)).resolves.toBeNull();
    }
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(
      scheduled.filter((job) => job.name.includes("expire") && job.state.kind === "pending"),
    ).toEqual([]);
    expect(scheduled.filter((job) => job.name.includes("expire"))).toHaveLength(3);
  });

  test("cancels an expiry job that could still run", async () => {
    const { t, ask, remove, load } = await historySetup();
    const decision = await ask(approve);
    // A settled row whose job is still scheduled, which no settlement path
    // leaves behind, exercises the guarded cancellation.
    const jobId = await t.run(async (ctx) => {
      const id = decision.id as Id<"decisions">;
      const scheduled = await ctx.scheduler.runAt(START + HOUR, decisions.expire.run, {
        decisionId: id,
      });
      await ctx.db.patch("decisions", id, {
        state: "cancelled",
        settledAt: START,
        expiryJobId: scheduled,
      });
      return scheduled;
    });

    await expect(remove(decision.id)).resolves.toBeNull();
    expect(await load(decision.id)).toBeNull();
    expect((await t.run((ctx) => ctx.db.system.get(jobId)))?.state.kind).toBe("canceled");
  });

  // req-decision-requests REQ-6: removal does not cascade.
  test("keeps follow-ups and event references without the removed content", async () => {
    const { t, ask, answer, cancel, remove, asA } = await historySetup();
    const parent = await ask({ ...approve, title: "Parent title" });
    await cancel(parent.id);
    const followUp = await ask({ ...approve, title: "Follow-up", parent_id: parent.id });
    const settledFollowUp = await ask({ ...approve, parent_id: followUp.id });
    await cancel(settledFollowUp.id);

    await remove(parent.id);
    const surviving = await asA.query(decisions.app.get, { decisionId: followUp.id });
    expect(surviving).toMatchObject({ parent_id: parent.id, follow_up_ids: [settledFollowUp.id] });
    expect(JSON.stringify(surviving)).not.toContain("Parent title");
    await expect(asA.query(decisions.app.get, { decisionId: parent.id })).rejects.toMatchObject(
      notFound,
    );

    await remove(settledFollowUp.id);
    expect((await asA.query(decisions.app.get, { decisionId: followUp.id })).follow_up_ids).toEqual(
      [],
    );
    await expect(answer(followUp.id, { kind: "approve" })).resolves.toMatchObject({
      state: "answered",
    });

    const events = await t.run((ctx) => ctx.db.query("events").collect());
    const kinds = events
      .filter((event) => event.decisionId === parent.id)
      .map((event) => event.kind);
    expect(kinds).toEqual(["decision.created", "decision.cancelled"]);
    expect(JSON.stringify(events)).not.toContain("Parent title");
  });

  test("is unauthenticated without a signed-in person", async () => {
    const { t, ask, cancel, load } = await historySetup();
    const decision = await ask(approve);
    await cancel(decision.id);

    await expect(
      t.mutation(decisions.app.remove, { decisionId: decision.id }),
    ).rejects.toMatchObject(unauthenticated);
    expect(await load(decision.id)).not.toBeNull();
  });
});

describe("answerFromNotification", () => {
  const three = {
    ...single,
    options: [
      { id: "pg", label: "Postgres" },
      { id: "sq", label: "SQLite" },
      { id: "dk", label: "DuckDB" },
    ],
  };

  // req-mobile-app AC-4.1; req-decision-requests AC-4.3
  test.each([
    ["decision-approve-reject", approve, "approve", { kind: "approve" }],
    ["decision-approve-reject", approve, "reject", { kind: "reject" }],
    ["decision-choice-2", single, "option-1", { kind: "option", option_id: "pg" }],
    ["decision-choice-2", single, "option-2", { kind: "option", option_id: "sq" }],
    ["decision-choice-3", three, "option-1", { kind: "option", option_id: "pg" }],
    ["decision-choice-3", three, "option-2", { kind: "option", option_id: "sq" }],
    ["decision-choice-3", three, "option-3", { kind: "option", option_id: "dk" }],
  ])("%s answers %s through the notification surface", async (_, input, action, expected) => {
    const { ask, fromNotification, load } = await historySetup();
    const decision = await ask(input);
    vi.advanceTimersByTime(MINUTE);

    const answered = await fromNotification(decision.id, action);

    expect(decisionSchema.parse(answered)).toEqual({
      ...decision,
      state: "answered",
      answer: expected,
      answered_at: new Date(START + MINUTE).toISOString(),
      answered_via: "notification",
    });
    expect(await load(decision.id)).toMatchObject({
      answeredVia: "notification",
      settledAt: START + MINUTE,
    });
  });

  const four = { ...three, options: [...three.options, { id: "sl", label: "Sled" }] };
  test.each([
    ["option-1 on approve-or-reject", approve, "option-1"],
    ["approve on single choice", single, "approve"],
    ["option-3 on two options", single, "option-3"],
    ["option-0", three, "option-0"],
    ["option-4", three, "option-4"],
    ["a capitalized action", three, "Option-1"],
    ["a padded action", approve, " approve"],
    ["a number", three, 1],
    ["null", approve, null],
    ["an object", approve, { kind: "approve" }],
    ["four options", four, "option-1"],
    ["multiple choice", multiple, "option-1"],
    ["free text", freeText, "approve"],
    ["single choice or text", choiceOrText, "option-1"],
  ])("refuses %s as invalid naming action and leaves it pending", async (_, input, action) => {
    const { ask, fromNotification, load } = await historySetup();
    const decision = await ask(input);

    await expect(fromNotification(decision.id, action)).rejects.toMatchObject({
      data: { code: "invalid", field: "action" },
    });
    expect(await load(decision.id)).toMatchObject({ state: "pending" });
    expect((await load(decision.id))?.answer).toBeUndefined();
  });

  // req-decision-requests AC-4.1; req-mobile-app AC-3.2
  test("answers conflict carrying the stored decision for every settled state", async () => {
    const { t, ask, answer, cancel, fromNotification, asA } = await historySetup();
    const answered = await ask(approve);
    await answer(answered.id, { kind: "reject" }, "First");
    const cancelled = await ask(approve);
    await cancel(cancelled.id);
    const expired = await ask({ ...approve, deadline: new Date(START + MINUTE).toISOString() });
    vi.advanceTimersByTime(MINUTE);
    await t.finishInProgressScheduledFunctions();

    for (const id of [answered.id, cancelled.id, expired.id]) {
      const before = await asA.query(decisions.app.get, { decisionId: id });
      for (const action of ["approve", "option-9", 42]) {
        const error = await fromNotification(id, action).catch((e: unknown) => e);
        expect((error as { data: unknown }).data).toMatchObject({
          code: "conflict",
          decision: before,
        });
      }
      expect(await asA.query(decisions.app.get, { decisionId: id })).toEqual(before);
    }
  });

  // req-decision-requests AC-4.2
  test("of concurrent app and notification answers exactly one wins", async () => {
    const { ask, answer, fromNotification, load } = await historySetup();
    const decision = await ask(single);

    const results = await Promise.allSettled([
      answer(decision.id, { kind: "option", option_id: "sq" }),
      fromNotification(decision.id, "option-1"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0]?.value;
    expect(rejected[0]?.reason).toMatchObject({ data: { code: "conflict", decision: winner } });
    expect(await load(decision.id)).toMatchObject({
      answer: winner?.answer,
      answeredVia: winner?.answered_via,
    });
  });

  // req-accounts-and-connections AC-1.1
  test("refuses foreign, missing, and malformed ids and an unauthenticated call", async () => {
    const { t, ask, fromNotification, asB, load } = await historySetup();
    const decision = await ask(approve);
    const gone = await ask(approve);
    await t.run((ctx) => ctx.db.delete("decisions", gone.id as Id<"decisions">));

    await expect(
      asB.mutation(decisions.app.answerFromNotification, {
        decisionId: decision.id,
        action: "approve",
      }),
    ).rejects.toMatchObject(notFound);
    await expect(fromNotification(gone.id, "approve")).rejects.toMatchObject(notFound);
    await expect(fromNotification("nope", "approve")).rejects.toMatchObject({
      data: { code: "invalid", field: "decisionId" },
    });
    await expect(
      t.mutation(decisions.app.answerFromNotification, {
        decisionId: decision.id,
        action: "approve",
      }),
    ).rejects.toMatchObject(unauthenticated);
    expect(await load(decision.id)).toMatchObject({ state: "pending" });
  });

  test("takes no owner, answer, or surface from the client", async () => {
    const { ask, asA, load, userId } = await historySetup();
    const decision = await ask(approve);

    for (const extra of [{ userId }, { answeredVia: "api" }, { answer: { kind: "reject" } }]) {
      await expect(
        asA.mutation(decisions.app.answerFromNotification, {
          decisionId: decision.id,
          action: "approve",
          ...extra,
        } as never),
      ).rejects.toThrow();
    }
    expect((await load(decision.id))?.state).toBe("pending");
  });
});

// component-decisions §Reads: the app's read shape adds `cancelReason` to a
// decision cancelled because its agent's ephemeral connection ended
// (req-install-keys AC-4.2). The contract's Decision, which MCP and the public
// API return, does not carry it.
describe("cancelReason", () => {
  async function connectionEnded() {
    const s = await setup();
    const ended = await s.ask({ ...approve, title: "Cancelled when the machine left" });
    const sibling = await s.ask({ ...approve, title: "Also pending on the session" });
    await s.t.run(async (ctx) => {
      await cancelForAgentSession(ctx, s.userId, s.sessionId, "connection_ended", START);
    });
    // A decision cancelled by hand afterwards carries no reason.
    const later = await s.ask({ ...approve, title: "Cancelled by hand" });
    await s.t.run(async (ctx) => {
      const doc = await ctx.db.get("decisions", later.id as Id<"decisions">);
      if (doc === null) throw new Error("missing");
      await cancelDecision(ctx, doc, START);
    });
    return { ...s, ended: ended.id, sibling: sibling.id, later: later.id };
  }

  test("get returns cancelReason only on a decision cancelled because its connection ended", async () => {
    const { asA, ended, sibling, later } = await connectionEnded();

    const read = await asA.query(decisions.app.get, { decisionId: ended });
    const manual = await asA.query(decisions.app.get, { decisionId: later });

    expect(read).toMatchObject({ id: ended, state: "cancelled", cancelReason: "connection_ended" });
    expect(decisionSchema.parse(read)).not.toHaveProperty("cancelReason");
    expect(manual).toMatchObject({ state: "cancelled" });
    expect(manual).not.toHaveProperty("cancelReason");
    // The cascade cancels every pending decision of the session.
    expect(await asA.query(decisions.app.get, { decisionId: sibling })).toMatchObject({
      cancelReason: "connection_ended",
    });
  });

  test("history rows carry cancelReason on both paths", async () => {
    const { asA, ended, later } = await connectionEnded();
    const opts = { numItems: 10, cursor: null };

    const listed = await asA.query(decisions.app.searchHistory, { paginationOpts: opts });
    const searched = await asA.query(decisions.app.searchHistory, {
      query: "machine",
      paginationOpts: opts,
    });

    const byId = new Map(listed.page.map((item) => [item.decision.id, item.decision]));
    expect(byId.get(ended)).toMatchObject({ cancelReason: "connection_ended" });
    expect(byId.get(later)).not.toHaveProperty("cancelReason");
    expect(searched.page.map((item) => item.decision)).toEqual([
      expect.objectContaining({ id: ended, cancelReason: "connection_ended" }),
    ]);
  });

  test("an answer to such a decision is conflict carrying it with cancelReason", async () => {
    const { asA, ended } = await connectionEnded();

    for (const attempt of [
      () => asA.mutation(decisions.app.answer, { decisionId: ended, answer: { kind: "approve" } }),
      () =>
        asA.mutation(decisions.app.answerFromNotification, {
          decisionId: ended,
          action: "approve",
        }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        data: {
          code: "conflict",
          message: "Decision is already cancelled",
          decision: { id: ended, state: "cancelled", cancelReason: "connection_ended" },
        },
      });
    }
  });

  test("MCP and public API reads keep the contract's Decision without cancelReason", async () => {
    const { t, userId, sessionId, ended } = await connectionEnded();
    const ids = { userId, decisionId: ended };

    const reads: unknown[] = [
      await t.query(decisions.operations.get, ids),
      await t.mutation(decisions.operations.watch, ids),
      await t.mutation(decisions.operations.poll, { ...ids, agentSessionId: sessionId }),
      ...(await t.mutation(decisions.operations.check, {
        userId,
        agentSessionId: sessionId,
        decisionIds: [ended],
      })),
      ...(await t.query(decisions.operations.list, { userId, state: "cancelled", limit: 50 }))
        .items,
    ];

    for (const read of reads) {
      expect(read).toMatchObject({ id: expect.any(String), state: "cancelled" });
      expect(read).not.toHaveProperty("cancelReason");
      expect(Object.keys(read as object).sort()).toEqual(Object.keys(decisionSchema.shape).sort());
    }
    await expect(
      t.mutation(decisions.operations.cancel, { ...ids, agentSessionId: sessionId }),
    ).rejects.toMatchObject({ data: { code: "conflict" } });
  });
});
