import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";

const NOW = Date.UTC(2026, 9, 10, 3, 0, 0);
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// req-agent-status AC-4.1
test("deletes sessions ended more than 7 days ago with their history and keeps newer ones", async () => {
  const t = convexTest(schema, modules);
  const { old, recent, live } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const credentialId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: "0".repeat(64),
    });
    const insert = async (endedAt: number | undefined) => {
      const id = await ctx.db.insert("agentSessions", {
        userId,
        credentialId,
        mcpSessionId: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        clientName: "Claude Code",
        clientVersion: "2.1.0",
        topic: "repo/x",
        activatedAt: NOW - 10 * DAY,
        lastActivityAt: endedAt ?? NOW,
        state: "done",
        line: "Finished",
        statusAt: endedAt ?? NOW,
        endedAt,
        endReason: endedAt === undefined ? undefined : "done",
      });
      await ctx.db.insert("statusHistory", {
        agentSessionId: id,
        state: "working",
        line: "Earlier",
        at: NOW - 10 * DAY,
      });
      return id;
    };
    return {
      old: await insert(NOW - 8 * DAY),
      recent: await insert(NOW - 6 * DAY),
      live: await insert(undefined),
    };
  });

  await t.mutation(internal.agents.purge.run, {});

  const historyFor = (id: Id<"agentSessions">) =>
    t.run((ctx) =>
      ctx.db
        .query("statusHistory")
        .withIndex("by_session_at", (q) => q.eq("agentSessionId", id))
        .collect(),
    );
  expect(await t.run((ctx) => ctx.db.get("agentSessions", old))).toBeNull();
  expect(await historyFor(old)).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get("agentSessions", recent))).not.toBeNull();
  expect(await historyFor(recent)).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.get("agentSessions", live))).not.toBeNull();
  expect(await historyFor(live)).toHaveLength(1);
});

test("a session ended exactly 7 days ago is kept until it is older", async () => {
  const t = convexTest(schema, modules);
  const id = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const credentialId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: "0".repeat(64),
    });
    return await ctx.db.insert("agentSessions", {
      userId,
      credentialId,
      mcpSessionId: "a".repeat(64),
      clientName: "Claude Code",
      clientVersion: "2.1.0",
      lastActivityAt: NOW - 8 * DAY,
      endedAt: NOW - 7 * DAY,
      endReason: "idle",
    });
  });

  await t.mutation(internal.agents.purge.run, {});
  expect(await t.run((ctx) => ctx.db.get("agentSessions", id))).not.toBeNull();

  vi.setSystemTime(NOW + 1);
  await t.mutation(internal.agents.purge.run, {});
  expect(await t.run((ctx) => ctx.db.get("agentSessions", id))).toBeNull();
});
