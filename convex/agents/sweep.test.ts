import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { touch } from "./sessions";

const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Opens a session and, unless told otherwise, activates it at START.
async function setup(activate = true) {
  const t = convexTest(schema, modules);
  const { userId, credentialId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const credentialId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: "0".repeat(64),
    });
    return { userId, credentialId };
  });
  const { agentSessionId } = await t.mutation(internal.agents.sessions.open, {
    userId,
    credentialId,
    clientName: "Claude Code",
    clientVersion: "2.1.0",
  });
  if (activate) {
    await t.run((ctx) => touch(ctx, userId, agentSessionId, "repo/x", START));
  }
  const load = () => t.run((ctx) => ctx.db.get("agentSessions", agentSessionId));
  const sweep = async (at: number) => {
    vi.setSystemTime(at);
    await t.mutation(internal.agents.sweep.run, {});
  };
  return { t, userId, agentSessionId, load, sweep };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

// req-agent-status REQ-3, AC-3.1, AC-3.2
test("marks an activated session stale at the 30-minute default once", async () => {
  const { load, sweep } = await setup();

  await sweep(START + 29 * MINUTE);
  expect((await load())?.staleSince).toBeUndefined();

  await sweep(START + 30 * MINUTE);
  expect((await load())?.staleSince).toBe(START + 30 * MINUTE);

  await sweep(START + 31 * MINUTE);
  expect((await load())?.staleSince).toBe(START + 30 * MINUTE);
});

// req-agent-status AC-3.3
test("a later touch clears the stale mark and a new silence marks it again", async () => {
  const { t, userId, agentSessionId, load, sweep } = await setup();
  await sweep(START + 30 * MINUTE);

  const touchedAt = START + 31 * MINUTE;
  await t.run((ctx) => touch(ctx, userId, agentSessionId, undefined, touchedAt));
  expect((await load())?.staleSince).toBeUndefined();

  await sweep(touchedAt + 29 * MINUTE);
  expect((await load())?.staleSince).toBeUndefined();
  await sweep(touchedAt + 30 * MINUTE);
  expect((await load())?.staleSince).toBe(touchedAt + 30 * MINUTE);
});

// req-agent-status REQ-2, REQ-3: no card, no stale mark; done is never stale.
test("skips unactivated and done sessions", async () => {
  const unactivated = await setup(false);
  await unactivated.sweep(START + HOUR);
  expect((await unactivated.load())?.staleSince).toBeUndefined();

  vi.setSystemTime(START);
  const done = await setup();
  await done.t.mutation(internal.agents.sessions.status, {
    userId: done.userId,
    agentSessionId: done.agentSessionId,
    topic: "repo/x",
    state: "done",
    line: "Finished",
  });
  await done.sweep(START + HOUR);
  expect(await done.load()).toMatchObject({ endReason: "done", endedAt: START });
  expect((await done.load())?.staleSince).toBeUndefined();
});

// req-agent-status REQ-4
test("ends a session idle for 24 hours and a touch re-enters it", async () => {
  const { t, userId, agentSessionId, load, sweep } = await setup();

  await sweep(START + 24 * HOUR - MINUTE);
  expect((await load())?.endedAt).toBeUndefined();

  await sweep(START + 24 * HOUR);
  expect(await load()).toMatchObject({ endedAt: START + 24 * HOUR, endReason: "idle" });

  // An ended session is left alone by later sweeps.
  await sweep(START + 25 * HOUR);
  expect(await load()).toMatchObject({ endedAt: START + 24 * HOUR, endReason: "idle" });

  await t.run((ctx) => touch(ctx, userId, agentSessionId, undefined, START + 26 * HOUR));
  const reentered = await load();
  expect(reentered?.endedAt).toBeUndefined();
  expect(reentered?.endReason).toBeUndefined();
  expect(reentered?.lastActivityAt).toBe(START + 26 * HOUR);
});
