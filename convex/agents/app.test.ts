import { agentSessionSchema, decisionSchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { decisions } from "../decisions/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { agents } from "./refs";

const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;
const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found", message: "Agent session not found" } };

async function setup() {
  const t = convexTest(schema, modules);
  const { userId, otherUserId, credentialId, otherCredentialId } = await t.run(async (ctx) => {
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
    const otherCredentialId = await ctx.db.insert("credentials", {
      userId: otherUserId,
      kind: "connection_token",
      tokenHash: "1".repeat(64),
    });
    return { userId, otherUserId, credentialId, otherCredentialId };
  });
  const open = async (owner = userId, clientName = "Claude Code") => {
    const { agentSessionId } = await t.mutation(agents.sessions.open, {
      userId: owner,
      credentialId: owner === userId ? credentialId : otherCredentialId,
      clientName,
      clientVersion: "2.1.0",
    });
    return agentSessionId;
  };
  const status = (
    agentSessionId: Id<"agentSessions">,
    fields: { state?: string; line?: string; link?: string; display_name?: string } = {},
    owner = userId,
  ) =>
    t.mutation(agents.sessions.status, {
      userId: owner,
      agentSessionId,
      topic: "repo/x",
      state: "working",
      line: "Working",
      ...fields,
    });
  const ask = (agentSessionId: Id<"agentSessions">, owner = userId) =>
    t.mutation(decisions.operations.create, {
      userId: owner,
      agentSessionId,
      input: { title: "Ship it?", input_type: "approve_reject", topic: "repo/x" },
    });
  const asA = t.withIdentity({ subject: "user_a" });
  const asB = t.withIdentity({ subject: "user_b" });
  return { t, userId, otherUserId, open, status, ask, asA, asB };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("liveAgents", () => {
  // req-mobile-app AC-2.2; req-agent-status REQ-2, REQ-4
  test("returns activated sessions with no end, most recent activity first", async () => {
    const { t, open, status, asA, otherUserId } = await setup();
    const older = await open(undefined, "Codex");
    await status(older);
    vi.advanceTimersByTime(MINUTE);
    const newer = await open();
    await status(newer, { display_name: "Release bot" });
    await open(); // initialized only: no card
    const done = await open();
    await status(done, { state: "done", line: "Finished" });
    const idle = await open();
    await status(idle);
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", idle, { endedAt: Date.now(), endReason: "idle" }),
    );
    await status(await open(otherUserId), {}, otherUserId);

    const live = await asA.query(agents.app.liveAgents, {});

    expect(live.map((s) => s.id)).toEqual([newer, older]);
    for (const session of live) {
      expect(agentSessionSchema.parse(session)).toEqual(session);
    }
    expect(live[0]).toMatchObject({ display_name: "Release bot", ended_at: null });
    expect(live[1]).toMatchObject({
      display_name: "Codex · repo/x",
      state: "working",
      line: "Working",
      link: null,
      stale: false,
    });
  });

  test("breaks an activity tie by newest creation", async () => {
    const { t, open, status, asA } = await setup();
    const first = await open();
    const second = await open();
    await status(first);
    await status(second);
    await t.run(async (ctx) => {
      await ctx.db.patch("agentSessions", first, { lastActivityAt: START });
      await ctx.db.patch("agentSessions", second, { lastActivityAt: START });
    });

    expect((await asA.query(agents.app.liveAgents, {})).map((s) => s.id)).toEqual([second, first]);
  });

  // req-agent-status AC-2.3, AC-3.2
  test("carries the real pending decision count and the stored stale flag", async () => {
    const { t, open, status, ask, asA } = await setup();
    const session = await open();
    await status(session);
    const first = await ask(session);
    await ask(session);
    await ask(session);
    await t.run((ctx) => ctx.db.patch("agentSessions", session, { staleSince: Date.now() }));

    expect(await asA.query(agents.app.liveAgents, {})).toMatchObject([
      { id: session, pending_decision_count: 3, stale: true, state: "working" },
    ]);

    await asA.mutation(decisions.app.answer, { decisionId: first.id, answer: { kind: "reject" } });
    expect((await asA.query(agents.app.liveAgents, {}))[0]?.pending_decision_count).toBe(2);
  });

  // req-agent-status AC-1.1: a session with activity but no status yet.
  test("returns null status fields before the first status", async () => {
    const { open, ask, asA } = await setup();
    const session = await open();
    await ask(session);

    expect(await asA.query(agents.app.liveAgents, {})).toEqual([
      agentSessionSchema.parse({
        id: session,
        display_name: "Claude Code · repo/x",
        topic: "repo/x",
        state: null,
        line: null,
        link: null,
        status_at: null,
        last_activity_at: new Date(START).toISOString(),
        stale: false,
        ended_at: null,
        pending_decision_count: 1,
      }),
    ]);
  });

  test("is unauthenticated without a signed-in person", async () => {
    const { t } = await setup();

    await expect(t.query(agents.app.liveAgents, {})).rejects.toMatchObject(unauthenticated);
    await expect(
      t.withIdentity({ subject: "user_missing" }).query(agents.app.liveAgents, {}),
    ).rejects.toMatchObject(unauthenticated);
  });
});

describe("get", () => {
  // req-agent-status AC-1.1, AC-1.2
  test("returns the session with at most 20 history rows, newest first", async () => {
    const { open, status, asA } = await setup();
    const session = await open();
    for (let i = 0; i < 25; i++) {
      await status(
        session,
        i % 2 === 0 ? { line: `Step ${i}`, link: `https://x.dev/${i}` } : { line: `Step ${i}` },
      );
      vi.advanceTimersByTime(MINUTE);
    }

    const detail = await asA.query(agents.app.get, { agentSessionId: session });

    const { history, pending_decisions, ...card } = detail;
    expect(agentSessionSchema.parse(card)).toEqual(card);
    expect(card).toMatchObject({ id: session, line: "Step 24" });
    expect(pending_decisions).toEqual([]);
    expect(history).toHaveLength(20);
    // The current status is Step 24; history holds Steps 23 down to 4.
    expect(history.map((h) => h.line)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Step ${23 - i}`),
    );
    expect(history[0]).toEqual({
      state: "working",
      line: "Step 23",
      link: null,
      at: new Date(START + 23 * MINUTE).toISOString(),
    });
    expect(history[1]).toMatchObject({ line: "Step 22", link: "https://x.dev/22" });
  });

  test("orders history rows with equal times newest first", async () => {
    const { t, open, status, asA } = await setup();
    const session = await open();
    await status(session);
    await t.run(async (ctx) => {
      for (const line of ["first", "second", "third"]) {
        await ctx.db.insert("statusHistory", {
          agentSessionId: session,
          state: "waiting",
          line,
          at: START,
        });
      }
    });

    const detail = await asA.query(agents.app.get, { agentSessionId: session });

    expect(detail.history.map((h) => h.line)).toEqual(["third", "second", "first"]);
  });

  // req-agent-status AC-2.3; req-accounts-and-connections AC-1.1
  test("returns only the session's own pending decisions", async () => {
    const { open, status, ask, asA } = await setup();
    const session = await open();
    await status(session);
    const other = await open();
    await status(other);
    const first = await ask(session);
    const answered = await ask(session);
    const second = await ask(session);
    await ask(other);
    await asA.mutation(decisions.app.answer, {
      decisionId: answered.id,
      answer: { kind: "approve" },
    });

    const detail = await asA.query(agents.app.get, { agentSessionId: session });

    expect(detail.pending_decisions.map((d) => d.id)).toEqual([first.id, second.id]);
    expect(detail.pending_decision_count).toBe(2);
    for (const decision of detail.pending_decisions) {
      expect(decisionSchema.parse(decision)).toEqual(decision);
    }
  });

  // req-agent-status REQ-4: an ended session still has a detail view.
  test("returns an ended session", async () => {
    const { open, status, asA } = await setup();
    const session = await open();
    await status(session, { state: "done", line: "Finished" });

    expect(await asA.query(agents.app.get, { agentSessionId: session })).toMatchObject({
      id: session,
      state: "done",
      ended_at: new Date(START).toISOString(),
    });
  });

  // req-agent-status REQ-2; req-accounts-and-connections AC-1.1
  test("answers not_found for initialized-only, foreign, and missing sessions", async () => {
    const { t, open, status, asA, asB } = await setup();
    const initialized = await open();
    const session = await open();
    await status(session);
    const gone = await open();
    await status(gone);
    await t.run((ctx) => ctx.db.delete("agentSessions", gone));

    for (const agentSessionId of [initialized, gone]) {
      await expect(asA.query(agents.app.get, { agentSessionId })).rejects.toMatchObject(notFound);
    }
    await expect(asB.query(agents.app.get, { agentSessionId: session })).rejects.toMatchObject(
      notFound,
    );
    await expect(asA.query(agents.app.get, { agentSessionId: "nope" })).rejects.toMatchObject({
      data: { code: "invalid", field: "agentSessionId" },
    });
    await expect(t.query(agents.app.get, { agentSessionId: session })).rejects.toMatchObject(
      unauthenticated,
    );
  });
});
