import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { decisions } from "./refs";

const choice = {
  title: "Which database?",
  input_type: "single_choice",
  topic: "repo/x",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sq", label: "SQLite" },
  ],
};

async function setup() {
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
  const { agentSessionId } = await t.mutation(agents.sessions.open, {
    userId,
    credentialId,
    clientName: "Claude Code",
    clientVersion: "2.1.0",
  });
  await t.run((ctx) => touch(ctx, userId, agentSessionId, "repo/x", Date.now()));
  const decision = await t.mutation(decisions.operations.create, {
    userId,
    agentSessionId,
    input: choice,
  });
  const answer = (args: {
    decisionId?: string;
    answer: unknown;
    note?: string;
    answeredVia?: string;
  }) =>
    t.mutation(decisions.devAnswer.answer, {
      decisionId: decision.id,
      answeredVia: "app",
      ...args,
    });
  const load = () => t.run((ctx) => ctx.db.get("decisions", decision.id as Id<"decisions">));
  return { t, decision, answer, load };
}

describe("devAnswer.answer", () => {
  // req-decision-requests AC-2.5, AC-4.3
  test("answers a decision by id with the given note and surface", async () => {
    const { answer } = await setup();

    const answered = await answer({
      answer: { kind: "option", option_id: "pg" },
      note: "Go",
      answeredVia: "notification",
    });

    expect(answered).toMatchObject({
      state: "answered",
      answer: { kind: "option", option_id: "pg" },
      note: "Go",
      answered_via: "notification",
      applied_by_default: false,
    });
  });

  // req-decision-requests AC-2.2
  test("rejects an invalid answer, note, or surface and leaves the decision pending", async () => {
    const { answer, load } = await setup();

    await expect(answer({ answer: { kind: "approve" } })).rejects.toMatchObject({
      data: { code: "invalid", field: "answer.kind" },
    });
    await expect(
      answer({ answer: { kind: "option", option_id: "pg" }, note: "x".repeat(2001) }),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "note" } });
    await expect(
      answer({ answer: { kind: "option", option_id: "pg" }, answeredVia: "mcp" }),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "answeredVia" } });
    expect((await load())?.state).toBe("pending");
  });

  // req-decision-requests AC-4.1
  test("refuses a settled decision with conflict", async () => {
    const { answer, load } = await setup();
    const first = await answer({ answer: { kind: "option", option_id: "pg" } });

    await expect(answer({ answer: { kind: "option", option_id: "sq" } })).rejects.toMatchObject({
      data: { code: "conflict", decision: first },
    });
    expect((await load())?.answer).toEqual({ kind: "option", option_id: "pg" });
  });

  // req-decision-requests AC-4.2
  test("of two concurrent answers exactly one is recorded and the other is a conflict", async () => {
    const { answer, load } = await setup();

    const results = await Promise.allSettled([
      answer({ answer: { kind: "option", option_id: "pg" } }),
      answer({ answer: { kind: "option", option_id: "sq" } }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0]?.value;
    expect(winner).toBeDefined();
    expect(rejected[0]?.reason).toMatchObject({ data: { code: "conflict" } });
    expect(rejected[0]?.reason.data.decision).toEqual(winner);
    expect((await load())?.answer).toEqual(winner?.answer);
  });

  test("answers not_found for an unknown id and invalid for a malformed one", async () => {
    const { t, decision, answer } = await setup();
    await t.run((ctx) => ctx.db.delete("decisions", decision.id as Id<"decisions">));

    await expect(answer({ answer: { kind: "approve" } })).rejects.toMatchObject({
      data: { code: "not_found" },
    });
    await expect(answer({ decisionId: "nope", answer: { kind: "approve" } })).rejects.toMatchObject(
      { data: { code: "invalid", field: "decisionId" } },
    );
  });
});
