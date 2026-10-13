import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { purgeDecisions } from "./accountPurge";
import { decisions } from "./refs";

// component-decisions §Account deletion: the decisions domain's part of the
// account purge.

const START = Date.UTC(2026, 9, 13, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: ReturnType<typeof convexTest>, name: string, count: number) {
  const { userId, credentialId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: `user_${name}`, email: name });
    const credentialId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: name.repeat(64),
    });
    return { userId, credentialId };
  });
  const { agentSessionId } = await t.mutation(agents.sessions.open, {
    userId,
    credentialId,
    clientName: "Claude Code",
    clientVersion: "2.1.0",
  });
  const ids: Id<"decisions">[] = [];
  for (let i = 0; i < count; i++) {
    const decision = await t.mutation(decisions.operations.create, {
      userId,
      agentSessionId,
      input: {
        title: `Ship ${i}?`,
        input_type: "approve_reject",
        topic: "repo/x",
        deadline: new Date(START + 60 * 60_000).toISOString(),
      },
    });
    ids.push(decision.id as Id<"decisions">);
  }
  return { userId, ids };
}

describe("purgeDecisions", () => {
  test("deletes the account's decisions within the budget and cancels their expiry jobs", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "a", 5);
    const b = await seed(t, "b", 2);
    const jobs = await t.run(async (ctx) =>
      (await Promise.all(a.ids.map((id) => ctx.db.get("decisions", id)))).map(
        (doc) => doc?.expiryJobId,
      ),
    );
    // One expiry job already ran its course, so its state is not pending.
    const finished = jobs[0];
    if (finished === undefined) {
      throw new Error("No expiry job");
    }
    await t.run((ctx) => ctx.scheduler.cancel(finished));

    const first = await t.run((ctx) => purgeDecisions(ctx, a.userId, 3));
    const second = await t.run((ctx) => purgeDecisions(ctx, a.userId, 3));

    expect(first).toEqual({ deleted: 3, done: false });
    expect(second).toEqual({ deleted: 2, done: true });
    const left = await t.run((ctx) => ctx.db.query("decisions").collect());
    expect(left.map((doc) => doc._id).sort()).toEqual([...b.ids].sort());
    for (const jobId of jobs) {
      if (jobId === undefined) {
        throw new Error("No expiry job");
      }
      const job = await t.run((ctx) => ctx.db.system.get(jobId));
      expect(job?.state.kind).toBe("canceled");
    }
  });
});
