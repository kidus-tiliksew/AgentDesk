import { agentSessionSchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { agents } from "./refs";
import { touch } from "./sessions";

const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const notFound = { data: { code: "not_found" } };

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
  const opened = await t.mutation(agents.sessions.open, {
    userId: ids.userId,
    credentialId: ids.credentialId,
    clientName: "Claude Code",
    clientVersion: "2.1.0",
  });
  return { t, ...ids, ...opened };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function status(
  { t, userId, agentSessionId }: Pick<Setup, "t" | "userId" | "agentSessionId">,
  fields: Partial<{
    userId: string;
    agentSessionId: string;
    topic: string;
    state: string;
    line: string;
    link?: string;
    display_name?: string;
  }>,
) {
  return t.mutation(agents.sessions.status, {
    userId,
    agentSessionId,
    topic: "repo/x",
    state: "working",
    line: "Working",
    ...fields,
  });
}

function loadSession(t: Setup["t"], agentSessionId: Id<"agentSessions">) {
  return t.run((ctx) => ctx.db.get("agentSessions", agentSessionId));
}

function loadHistory(t: Setup["t"], agentSessionId: Id<"agentSessions">) {
  return t.run((ctx) =>
    ctx.db
      .query("statusHistory")
      .withIndex("by_session_at", (q) => q.eq("agentSessionId", agentSessionId))
      .order("asc")
      .collect(),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("open", () => {
  // req-agent-status REQ-2: a health check creates no card.
  test("inserts an unactivated session with a 64-character hex mcpSessionId", async () => {
    const { t, userId, credentialId, agentSessionId, mcpSessionId } = await setup();

    expect(mcpSessionId).toMatch(/^[0-9a-f]{64}$/);
    const session = await loadSession(t, agentSessionId);
    expect(session).toMatchObject({
      userId,
      credentialId,
      mcpSessionId,
      clientName: "Claude Code",
      clientVersion: "2.1.0",
      lastActivityAt: START,
    });
    expect(session?.activatedAt).toBeUndefined();
    expect(session?.topic).toBeUndefined();
    expect(session?.state).toBeUndefined();
    expect(session?.statusAt).toBeUndefined();
  });

  test("issues a distinct mcpSessionId per open", async () => {
    const { t, userId, credentialId, mcpSessionId } = await setup();

    const second = await t.mutation(agents.sessions.open, {
      userId,
      credentialId,
      clientName: "Claude Code",
      clientVersion: "2.1.0",
    });

    expect(second.mcpSessionId).not.toBe(mcpSessionId);
  });

  test("rejects a malformed credentialId naming the field", async () => {
    const { t, userId } = await setup();

    await expect(
      t.mutation(agents.sessions.open, {
        userId,
        credentialId: "not-an-id",
        clientName: "Claude Code",
        clientVersion: "2.1.0",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "credentialId" } });
  });
});

describe("touch", () => {
  test("the first touch with a topic sets activatedAt and the normalized topic once", async () => {
    const { t, userId, agentSessionId } = await setup();

    await t.run((ctx) => touch(ctx, userId, agentSessionId, "Repo/X", START + 1_000));
    const activated = await loadSession(t, agentSessionId);
    expect(activated).toMatchObject({ activatedAt: START + 1_000, topic: "repo/x" });

    await t.run((ctx) => touch(ctx, userId, agentSessionId, "other/topic", START + 2_000));
    const later = await loadSession(t, agentSessionId);
    expect(later).toMatchObject({
      activatedAt: START + 1_000,
      topic: "repo/x",
      lastActivityAt: START + 2_000,
    });
  });

  // req-agent-status REQ-2; req-agent-tools AC-8.2
  test("the first touch without a topic is rejected naming the field and writes nothing", async () => {
    const { t, userId, agentSessionId } = await setup();

    await expect(
      t.run((ctx) => touch(ctx, userId, agentSessionId, undefined, START + 1_000)),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "topic" } });

    const session = await loadSession(t, agentSessionId);
    expect(session?.lastActivityAt).toBe(START);
    expect(session?.activatedAt).toBeUndefined();
    expect(session?.topic).toBeUndefined();
  });

  test("an activated session accepts a touch without a topic", async () => {
    const { t, userId, agentSessionId } = await setup();
    await t.run((ctx) => touch(ctx, userId, agentSessionId, "repo/x", START));

    await t.run((ctx) => touch(ctx, userId, agentSessionId, undefined, START + 1_000));

    expect(await loadSession(t, agentSessionId)).toMatchObject({
      topic: "repo/x",
      activatedAt: START,
      lastActivityAt: START + 1_000,
    });
  });

  // req-agent-tools AC-8.2
  test("rejects an invalid topic naming the field and changes nothing", async () => {
    const { t, userId, agentSessionId } = await setup();

    await expect(
      t.run((ctx) => touch(ctx, userId, agentSessionId, "bad topic!", START + 1_000)),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "topic" } });
    expect((await loadSession(t, agentSessionId))?.lastActivityAt).toBe(START);
  });

  // req-agent-tools AC-7.1
  test("another user's session is not_found", async () => {
    const { t, otherUserId, agentSessionId } = await setup();

    await expect(
      t.run((ctx) => touch(ctx, otherUserId, agentSessionId, "repo/x", START)),
    ).rejects.toMatchObject(notFound);
  });

  test("clears staleSince and an idle end, and keeps a done end", async () => {
    const { t, userId, agentSessionId } = await setup();
    await t.run((ctx) =>
      ctx.db.patch("agentSessions", agentSessionId, {
        staleSince: START,
        endedAt: START,
        endReason: "idle",
      }),
    );

    await t.run((ctx) => touch(ctx, userId, agentSessionId, "repo/x", START + 1_000));
    const reentered = await loadSession(t, agentSessionId);
    expect(reentered?.staleSince).toBeUndefined();
    expect(reentered?.endedAt).toBeUndefined();
    expect(reentered?.endReason).toBeUndefined();

    await t.run((ctx) =>
      ctx.db.patch("agentSessions", agentSessionId, { endedAt: START, endReason: "done" }),
    );
    await t.run((ctx) => touch(ctx, userId, agentSessionId, "repo/x", START + 2_000));
    expect(await loadSession(t, agentSessionId)).toMatchObject({
      endedAt: START,
      endReason: "done",
    });
  });
});

describe("status", () => {
  // req-agent-status AC-1.1
  test("replaces the current status and archives the previous one", async () => {
    const s = await setup();

    const first = await status(s, { line: "First", link: "https://example.com/1" });
    expect(agentSessionSchema.parse(first)).toMatchObject({
      id: s.agentSessionId,
      display_name: "Claude Code · repo/x",
      topic: "repo/x",
      state: "working",
      line: "First",
      link: "https://example.com/1",
      status_at: new Date(START).toISOString(),
      last_activity_at: new Date(START).toISOString(),
      stale: false,
      ended_at: null,
      pending_decision_count: 0,
    });
    expect(await loadHistory(s.t, s.agentSessionId)).toHaveLength(0);

    vi.setSystemTime(START + 60_000);
    const second = await status(s, { state: "waiting", line: "Second" });
    expect(second).toMatchObject({ state: "waiting", line: "Second", link: null });
    expect(await loadSession(s.t, s.agentSessionId)).toMatchObject({
      state: "waiting",
      line: "Second",
      statusAt: START + 60_000,
    });
    expect((await loadSession(s.t, s.agentSessionId))?.link).toBeUndefined();
    expect(await loadHistory(s.t, s.agentSessionId)).toMatchObject([
      { state: "working", line: "First", link: "https://example.com/1", at: START },
    ]);
  });

  // req-agent-status AC-1.2
  test("keeps the newest 20 history rows and drops the oldest", async () => {
    const s = await setup();

    for (let i = 0; i < 25; i++) {
      vi.setSystemTime(START + i * 1_000);
      await status(s, { line: `Status ${i}` });
    }

    const history = await loadHistory(s.t, s.agentSessionId);
    expect(history).toHaveLength(20);
    expect(history.map((row) => row.line)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Status ${i + 4}`),
    );
    expect((await loadSession(s.t, s.agentSessionId))?.line).toBe("Status 24");
  });

  // req-agent-status AC-1.3; req-agent-tools AC-1.3
  test.each([
    ["an unknown state", { state: "sleeping" }, "state"],
    ["a non-http link", { link: "ftp://example.com" }, "link"],
    ["an empty line", { line: "" }, "line"],
    ["a long display name", { display_name: "x".repeat(61) }, "display_name"],
    ["an invalid topic", { topic: "Bad Topic" }, "topic"],
  ])("rejects %s naming the field and changes nothing", async (_label, fields, field) => {
    const s = await setup();
    await status(s, { line: "Before" });
    vi.setSystemTime(START + 60_000);

    await expect(status(s, fields)).rejects.toMatchObject({ data: { code: "invalid", field } });

    expect(await loadSession(s.t, s.agentSessionId)).toMatchObject({
      line: "Before",
      statusAt: START,
      lastActivityAt: START,
    });
    expect(await loadHistory(s.t, s.agentSessionId)).toHaveLength(0);
  });

  // req-agent-status REQ-4; component-agent-presence §Lifecycle
  test("done ends the session and a later working status clears the end", async () => {
    const s = await setup();

    const done = await status(s, { state: "done", line: "Finished" });
    expect(done.ended_at).toBe(new Date(START).toISOString());
    expect(await loadSession(s.t, s.agentSessionId)).toMatchObject({
      endedAt: START,
      endReason: "done",
    });

    vi.setSystemTime(START + 60_000);
    const working = await status(s, { state: "working", line: "More" });
    expect(working.ended_at).toBeNull();
    const session = await loadSession(s.t, s.agentSessionId);
    expect(session?.endedAt).toBeUndefined();
    expect(session?.endReason).toBeUndefined();
  });

  // req-agent-status AC-2.1, AC-2.2
  test("display_name persists until set again", async () => {
    const s = await setup();

    await status(s, { display_name: "Refactor bot" });
    const named = await status(s, { line: "Next" });
    expect(named.display_name).toBe("Refactor bot");

    const renamed = await status(s, { display_name: "Other bot" });
    expect(renamed.display_name).toBe("Other bot");
  });

  // req-agent-tools AC-7.1
  test("another user's session and a malformed id are refused", async () => {
    const s = await setup();

    await expect(status(s, { userId: s.otherUserId })).rejects.toMatchObject(notFound);
    await expect(status(s, { agentSessionId: "nope" })).rejects.toMatchObject({
      data: { code: "invalid", field: "agentSessionId" },
    });
  });
});

describe("session", () => {
  test("resolves the caller's mcpSessionId", async () => {
    const { t, userId, agentSessionId, mcpSessionId } = await setup();

    expect(await t.query(agents.sessions.session, { userId, mcpSessionId })).toEqual({
      agentSessionId,
    });
  });

  // req-agent-tools AC-7.1
  test("another user's mcpSessionId and an unknown one are both not_found", async () => {
    const { t, userId, otherUserId, mcpSessionId } = await setup();

    await expect(
      t.query(agents.sessions.session, { userId: otherUserId, mcpSessionId }),
    ).rejects.toMatchObject(notFound);
    await expect(
      t.query(agents.sessions.session, { userId, mcpSessionId: "f".repeat(64) }),
    ).rejects.toMatchObject(notFound);
  });
});
