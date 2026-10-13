import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { purgeAgentSessions } from "./accountPurge";

// component-agent-presence §Account deletion: the agents domain's part of
// the account purge.

async function setup() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const sessions: Record<string, Id<"agentSessions">[]> = {};
    const users: Id<"users">[] = [];
    for (const name of ["a", "b"]) {
      const userId = await ctx.db.insert("users", { clerkUserId: `user_${name}`, email: name });
      users.push(userId);
      const credentialId = await ctx.db.insert("credentials", {
        userId,
        kind: "connection_token",
        tokenHash: name.repeat(64),
      });
      sessions[name] = [];
      // An unactivated, a live, and an ended session, each with history.
      for (const [index, extra] of [
        {},
        { activatedAt: 1 },
        { activatedAt: 1, endedAt: 2, endReason: "done" as const },
      ].entries()) {
        const id = await ctx.db.insert("agentSessions", {
          userId,
          credentialId,
          mcpSessionId: `${name}${index}`.padEnd(64, "0"),
          clientName: "Claude Code",
          clientVersion: "2.1.0",
          lastActivityAt: 0,
          ...extra,
        });
        sessions[name]?.push(id);
        for (let i = 0; i < 4; i++) {
          await ctx.db.insert("statusHistory", {
            agentSessionId: id,
            state: "working",
            line: "x",
            at: i,
          });
        }
      }
    }
    const [userA, userB] = users;
    if (userA === undefined || userB === undefined) {
      throw new Error("No users");
    }
    return { userA, userB, sessions };
  });
  return { t, ...seeded };
}

describe("purgeAgentSessions", () => {
  test("deletes history before its session within the budget, for one account only", async () => {
    const { t, userA, sessions } = await setup();

    const steps = [];
    for (let i = 0; i < 10; i++) {
      const step = await t.run((ctx) => purgeAgentSessions(ctx, userA, 3));
      steps.push(step);
      // No history row ever outlives its session.
      const orphans = await t.run(async (ctx) => {
        let count = 0;
        for (const row of await ctx.db.query("statusHistory").collect()) {
          if ((await ctx.db.get("agentSessions", row.agentSessionId)) === null) {
            count++;
          }
        }
        return count;
      });
      expect(orphans).toBe(0);
      if (step.done) {
        break;
      }
    }

    expect(steps.every((step) => step.deleted <= 3)).toBe(true);
    expect(steps.reduce((sum, step) => sum + step.deleted, 0)).toBe(15);
    const left = await t.run(async (ctx) => ({
      sessions: (await ctx.db.query("agentSessions").collect()).map((row) => row._id),
      history: await ctx.db.query("statusHistory").collect(),
    }));
    expect(left.sessions).toEqual(sessions.b);
    expect(left.history).toHaveLength(12);
  });
});
