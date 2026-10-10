import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { decisions } from "./refs";

const START = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;
const DEADLINE = START + 10 * MINUTE;

const choice = {
  title: "Which database?",
  input_type: "single_choice",
  topic: "repo/x",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sq", label: "SQLite" },
  ],
  deadline: new Date(DEADLINE).toISOString(),
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
  await t.run((ctx) => touch(ctx, userId, agentSessionId, "repo/x", START));
  const ask = (input: Record<string, unknown>) =>
    t.mutation(decisions.operations.create, { userId, agentSessionId, input });
  const load = (id: string) => t.run((ctx) => ctx.db.get("decisions", id as Id<"decisions">));
  const jobState = async (id: string) => {
    const doc = await load(id);
    const jobId = doc?.expiryJobId;
    if (jobId === undefined) {
      return undefined;
    }
    const job = await t.run((ctx) => ctx.db.system.get(jobId));
    return job?.state.kind;
  };
  const runDue = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, userId, agentSessionId, ask, load, jobState, runDue };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

// req-decision-requests AC-5.1
test("expiry with a default records the default as the answer", async () => {
  const { ask, load, jobState, runDue } = await setup();
  const decision = await ask({ ...choice, default: { kind: "option", option_id: "sq" } });
  expect(await jobState(decision.id)).toBe("pending");

  await runDue();

  const doc = await load(decision.id);
  expect(doc).toMatchObject({
    state: "expired",
    answer: { kind: "option", option_id: "sq" },
    answeredVia: "default",
    appliedByDefault: true,
    answeredAt: DEADLINE,
    settledAt: DEADLINE,
    searchText: "Which database?\nPostgres\nSQLite\nSQLite",
  });
  expect(await jobState(decision.id)).toBe("success");
});

// req-decision-requests AC-5.2
test("expiry without a default sets expired with no answer", async () => {
  const { ask, load, runDue } = await setup();
  const decision = await ask(choice);

  await runDue();

  const doc = await load(decision.id);
  expect(doc).toMatchObject({ state: "expired", settledAt: DEADLINE });
  expect(doc?.answer).toBeUndefined();
  expect(doc?.answeredVia).toBeUndefined();
  expect(doc?.appliedByDefault).toBeUndefined();
});

describe("a decision settled before its deadline", () => {
  // req-decision-requests AC-5.4
  test("an answer cancels the job and the default is never applied", async () => {
    const { t, ask, load, jobState, runDue } = await setup();
    const decision = await ask({ ...choice, default: { kind: "option", option_id: "sq" } });
    vi.setSystemTime(DEADLINE - MINUTE);

    await t.mutation(decisions.devAnswer.answer, {
      decisionId: decision.id,
      answer: { kind: "option", option_id: "pg" },
      answeredVia: "app",
    });
    expect(await jobState(decision.id)).toBe("canceled");
    await runDue();

    expect(await load(decision.id)).toMatchObject({
      state: "answered",
      answer: { kind: "option", option_id: "pg" },
      answeredVia: "app",
      appliedByDefault: false,
      settledAt: DEADLINE - MINUTE,
    });
  });

  test("a cancellation cancels the job", async () => {
    const { t, userId, ask, load, jobState, runDue } = await setup();
    const decision = await ask({ ...choice, default: { kind: "option", option_id: "sq" } });

    await t.mutation(decisions.operations.cancel, { userId, decisionId: decision.id });
    expect(await jobState(decision.id)).toBe("canceled");
    await runDue();

    const doc = await load(decision.id);
    expect(doc?.state).toBe("cancelled");
    expect(doc?.answer).toBeUndefined();
  });

  // req-decision-requests AC-4.1
  test.each(["answered", "cancelled", "expired"])(
    "a stale expiry run on a %s decision is refused and changes nothing",
    async (state) => {
      const { t, userId, ask, load, runDue } = await setup();
      const decision = await ask({ ...choice, default: { kind: "option", option_id: "sq" } });
      if (state === "answered") {
        await t.mutation(decisions.devAnswer.answer, {
          decisionId: decision.id,
          answer: { kind: "option", option_id: "pg" },
          answeredVia: "app",
        });
      } else if (state === "cancelled") {
        await t.mutation(decisions.operations.cancel, { userId, decisionId: decision.id });
      } else {
        await runDue();
      }
      const stored = await load(decision.id);
      vi.setSystemTime(DEADLINE + MINUTE);

      await expect(
        t.mutation(decisions.expire.run, { decisionId: decision.id as Id<"decisions"> }),
      ).rejects.toMatchObject({ data: { code: "conflict", decision: { state } } });
      expect(await load(decision.id)).toEqual(stored);
    },
  );
});

test("an expiry run for a deleted decision does nothing", async () => {
  const { t, ask } = await setup();
  const decision = await ask(choice);
  await t.run((ctx) => ctx.db.delete("decisions", decision.id as Id<"decisions">));

  await expect(
    t.mutation(decisions.expire.run, { decisionId: decision.id as Id<"decisions"> }),
  ).resolves.toBeNull();
});

// req-decision-requests REQ-5: expiry happens only at the stored deadline.
describe("an expiry run before the deadline", () => {
  test.each([
    ["with a default", { ...choice, default: { kind: "option", option_id: "sq" } }],
    ["without a default", choice],
  ])("leaves a pending decision %s unchanged", async (_name, input) => {
    const { t, ask, load } = await setup();
    const decision = await ask(input);
    const stored = await load(decision.id);
    vi.setSystemTime(DEADLINE - 1);

    const result = await t.mutation(decisions.expire.run, {
      decisionId: decision.id as Id<"decisions">,
    });

    expect(result).toBeNull();
    expect(await load(decision.id)).toEqual(stored);
  });

  test("leaves a decision without a deadline unchanged", async () => {
    const { t, ask, load } = await setup();
    const decision = await ask({ ...choice, deadline: undefined });
    const stored = await load(decision.id);
    vi.setSystemTime(DEADLINE + 60 * MINUTE);

    await t.mutation(decisions.expire.run, { decisionId: decision.id as Id<"decisions"> });

    expect(stored?.state).toBe("pending");
    expect(await load(decision.id)).toEqual(stored);
  });

  test("expires the decision at exactly the deadline", async () => {
    const { t, ask, load } = await setup();
    const decision = await ask({ ...choice, default: { kind: "option", option_id: "sq" } });
    vi.setSystemTime(DEADLINE);

    await t.mutation(decisions.expire.run, { decisionId: decision.id as Id<"decisions"> });

    expect(await load(decision.id)).toMatchObject({
      state: "expired",
      answer: { kind: "option", option_id: "sq" },
      appliedByDefault: true,
      settledAt: DEADLINE,
    });
  });
});
