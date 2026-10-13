import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { decisions } from "../decisions/refs";
import { pushNotifications } from "../notifications/push";
import { notifications } from "../notifications/refs";
import { ensureSettings } from "../notifications/settings";
import {
  openSession,
  queued,
  register,
  type Setup,
  setup,
  tokenStatus,
} from "../notifications/test.setup";
import { CLERK_FIRST_DELAY_MS, DELETION_WINDOW_MS, PURGE_BATCH, STALL_MS } from "./accountDeletion";
import { identity } from "./refs";
import { hashToken } from "./tokens";

// component-identity §Account deletion (req-accounts-and-connections REQ-5,
// AC-5.1): immediate revocation, the bounded and resumable purge, recovery,
// and the deleting-account guards on background work. The real push
// component is mounted; fake timers keep its sender and every scheduled
// purge batch from running unless a test runs them, and `fetch` throws, so
// no test contacts Expo or Clerk.

const START = Date.UTC(2026, 9, 13, 12, 0, 0);
const MINUTE = 60_000;
const unauthenticated = { data: { code: "unauthenticated" } };

// Every table a purge must empty, with how a row is tied to its account.
const OWNED_TABLES = [
  "decisions",
  "agentSessions",
  "events",
  "rules",
  "settings",
  "devices",
  "digests",
  "credentials",
  "codeAttempts",
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("No test contacts the network");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Seeded = {
  tokens: string[];
  deviceId: string;
  agentSessionId: Id<"agentSessions">;
  pendingDecisionId: Id<"decisions">;
  eventId: Id<"events">;
  notificationIds: string[];
};

// Gives an account two connection tokens and an API token, a registered
// install with one queued push, an agent session with status history, a
// pending decision with an expiry job and its routed event, a settled
// decision, a rule, a settings row, a digest, an approved sign-in request,
// and a wrong-code attempt.
async function seed(
  t: Setup["t"],
  userId: Id<"users">,
  as: Setup["asA"],
  name: string,
): Promise<Seeded> {
  const tokens = [`adc_${name}_1`, `adc_${name}_2`, `adp_${name}_1`];
  const hashes = await Promise.all(tokens.map((token) => hashToken(token)));
  await t.run(async (ctx) => {
    for (const [index, tokenHash] of hashes.entries()) {
      await ctx.db.insert("credentials", {
        userId,
        kind: index === 2 ? "api_token" : "connection_token",
        tokenHash,
      });
    }
  });
  const deviceId = `install-${name}`;
  await register(as, deviceId, `ExponentPushToken[${name}]`);
  const agentSessionId = await openSession(t, userId, `Agent ${name}`);
  const decision = await t.mutation(decisions.operations.create, {
    userId,
    agentSessionId,
    input: {
      title: `Ship ${name}?`,
      input_type: "approve_reject",
      topic: "repo/x",
      deadline: new Date(START + 30 * MINUTE).toISOString(),
    },
  });
  const pendingDecisionId = decision.id as Id<"decisions">;
  const eventId = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_user_action_digest", (q) => q.eq("userId", userId))
      .first();
    if (event === null) {
      throw new Error("No decision event");
    }
    return event._id;
  });
  // Routing the event queues one push for the install.
  await t.mutation(notifications.route.run, { eventId });
  const notificationIds = (await queued(t, deviceId)).map((row) => row.id as string);
  await t.run(async (ctx) => {
    await ctx.db.insert("decisions", {
      userId,
      agentSessionId,
      topic: "repo/x",
      title: "Done before",
      inputType: "approve_reject",
      priority: "normal",
      state: "answered",
      answer: { kind: "approve" },
      answeredAt: START,
      settledAt: START,
      searchText: "Done before",
    });
    for (const [index, state] of (["working", "waiting", "done"] as const).entries()) {
      await ctx.db.insert("statusHistory", { agentSessionId, state, line: "step", at: index });
    }
    await ctx.db.insert("rules", { userId, topic: "repo", action: "push", updatedAt: START });
    await ensureSettings(ctx, userId, START);
    await ctx.db.insert("digests", {
      userId,
      eventIds: [eventId],
      pendingDecisionIds: [pendingDecisionId],
      sentAt: START,
    });
    await ctx.db.insert("deviceRequests", {
      userCode: `CODE${name.toUpperCase()}`.padEnd(8, "X").slice(0, 8),
      deviceSecretHash: `secret-${name}`,
      machineName: "Laptop",
      harnesses: ["codex"],
      status: "approved",
      userId,
      expiresAt: START + 10 * MINUTE,
    });
    await ctx.db.insert("codeAttempts", { userId, at: START });
  });
  return { tokens, deviceId, agentSessionId, pendingDecisionId, eventId, notificationIds };
}

// The rows that belong to an account in every table, children included
// through their parents' ids.
async function owned(t: Setup["t"], userId: Id<"users">, seeded: Seeded) {
  return await t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of OWNED_TABLES) {
      const rows = (await ctx.db.query(table).collect()) as { userId: Id<"users"> }[];
      counts[table] = rows.filter((row) => row.userId === userId).length;
    }
    counts.statusHistory = (await ctx.db.query("statusHistory").collect()).filter(
      (row) => row.agentSessionId === seeded.agentSessionId,
    ).length;
    // A delivery row of the account's events, or one whose event is gone.
    const deliveries = await ctx.db.query("pushDeliveries").collect();
    let orphanOrOwned = 0;
    for (const row of deliveries) {
      const event = await ctx.db.get("events", row.eventId);
      if (event === null || event.userId === userId || row.eventId === seeded.eventId) {
        orphanOrOwned++;
      }
    }
    counts.pushDeliveries = orphanOrOwned;
    counts.deviceRequests = (await ctx.db.query("deviceRequests").collect()).filter(
      (row) => row.userId === userId,
    ).length;
    counts.users = (await ctx.db.get("users", userId)) === null ? 0 : 1;
    return counts;
  });
}

// Adds `count` routed events, each with one delivery row to an install the
// account unregistered earlier, so the purge needs several batches.
function addEvents(t: Setup["t"], userId: Id<"users">, seeded: Seeded, count: number) {
  return t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      const eventId = await ctx.db.insert("events", {
        userId,
        kind: "agent.done",
        agentSessionId: seeded.agentSessionId,
        occurredAt: START,
        action: "digest",
      });
      await ctx.db.insert("pushDeliveries", { eventId, deviceId: "old-install" });
    }
  });
}

async function seedBoth() {
  const base = await setup();
  const a = await seed(base.t, base.userA, base.asA, "a");
  const b = await seed(base.t, base.userB, base.asB, "b");
  return { ...base, a, b };
}

function deletionOf(t: Setup["t"], clerkUserId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("accountDeletions")
      .withIndex("by_clerk", (q) => q.eq("clerkUserId", clerkUserId))
      .unique(),
  );
}

function resolve(t: Setup["t"], token: string) {
  return hashToken(token).then((tokenHash) =>
    t.mutation(internal.identity.credentials.resolveToken, { tokenHash }),
  );
}

function component(t: Setup["t"], id: string) {
  return t.run((ctx) => pushNotifications.getNotification(ctx, { id }));
}

function scheduled(t: Setup["t"], prefix: string) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.name.startsWith(prefix) && job.state.kind === "pending",
    ),
  );
}

// Runs the purge chain's batches one at a time, as the scheduler would, and
// returns how many rows each batch deleted.
async function runPurge(t: Setup["t"], clerkUserId: string, limit = 50) {
  const deletedPerBatch: number[] = [];
  for (let i = 0; i < limit; i++) {
    const record = await deletionOf(t, clerkUserId);
    if (record === null || record.purgedAt !== undefined) {
      return deletedPerBatch;
    }
    const before = await totalRows(t);
    await t.mutation(identity.accountDeletion.purgeBatch, {
      deletionId: record._id,
      generation: record.generation,
    });
    deletedPerBatch.push(before - (await totalRows(t)));
  }
  throw new Error("The purge did not finish");
}

const ALL_TABLES = [
  ...OWNED_TABLES,
  "statusHistory",
  "pushDeliveries",
  "deviceRequests",
  "users",
] as const;

function totalRows(t: Setup["t"]) {
  return t.run(async (ctx) => {
    let total = 0;
    for (const table of ALL_TABLES) {
      total += (await ctx.db.query(table).collect()).length;
    }
    return total;
  });
}

describe("deleteAccount", () => {
  test("revokes every credential and device of the account at once and cancels its queued pushes", async () => {
    const { t, userA, userB, asA, a, b } = await seedBoth();
    expect(a.notificationIds).toHaveLength(1);
    const before = await owned(t, userB, b);

    const result = await asA.mutation(identity.accountDeletion.deleteAccount, {});

    expect(result).toEqual({ deletingAt: START, completeBy: START + DELETION_WINDOW_MS });
    const user = await t.run((ctx) => ctx.db.get("users", userA));
    expect(user?.deletingAt).toBe(START);
    const credentials = await t.run((ctx) =>
      ctx.db
        .query("credentials")
        .withIndex("by_user_kind", (q) => q.eq("userId", userA))
        .collect(),
    );
    // Three seeded tokens and the session's credential.
    expect(credentials).toHaveLength(4);
    for (const credential of credentials) {
      expect(credential.revokedAt).toBe(START);
    }
    for (const token of a.tokens) {
      await expect(resolve(t, token)).rejects.toMatchObject(unauthenticated);
    }
    // The install, its token, and its queued push are gone.
    expect(await owned(t, userA, a)).toMatchObject({ devices: 0 });
    expect(await tokenStatus(t, a.deviceId)).toMatchObject({ hasToken: false });
    for (const id of a.notificationIds) {
      expect(await component(t, id)).toBeNull();
    }
    // App calls and device registration are refused.
    await expect(register(asA, a.deviceId, "ExponentPushToken[again]")).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(asA.query(notifications.rules.list, {})).rejects.toMatchObject(unauthenticated);

    // The other account keeps its tokens, install, and queued push.
    expect(await resolve(t, b.tokens[0] ?? "")).toMatchObject({ userId: userB });
    expect(await tokenStatus(t, b.deviceId)).toMatchObject({ hasToken: true });
    for (const id of b.notificationIds) {
      expect(await component(t, id)).toMatchObject({ state: "awaiting_delivery" });
    }
    expect(await owned(t, userB, b)).toEqual(before);

    // The purge starts now and the Clerk deletion a minute later.
    expect(await scheduled(t, "identity/accountDeletion:purgeBatch")).toHaveLength(1);
    const clerk = await scheduled(t, "identity/clerkDeletion:deleteClerkUser");
    expect(clerk).toHaveLength(1);
    expect(clerk[0]?.scheduledTime).toBe(START + CLERK_FIRST_DELAY_MS);
  });

  test("a repeated call returns the first times and does nothing more", async () => {
    const { t, asA } = await seedBoth();
    const first = await asA.mutation(identity.accountDeletion.deleteAccount, {});
    vi.setSystemTime(START + 5 * MINUTE);

    const second = await asA.mutation(identity.accountDeletion.deleteAccount, {});
    const concurrent = await Promise.all([
      asA.mutation(identity.accountDeletion.deleteAccount, {}),
      asA.mutation(identity.accountDeletion.deleteAccount, {}),
    ]);

    expect(second).toEqual(first);
    expect(concurrent).toEqual([first, first]);
    expect(await t.run((ctx) => ctx.db.query("accountDeletions").collect())).toHaveLength(1);
    expect(await scheduled(t, "identity/accountDeletion:purgeBatch")).toHaveLength(1);
    expect(await scheduled(t, "identity/clerkDeletion:deleteClerkUser")).toHaveLength(1);
  });

  test("keeps a credential's earlier revocation time", async () => {
    const { t, userA, asA } = await setup();
    const credentialId = await t.run((ctx) =>
      ctx.db.insert("credentials", {
        userId: userA,
        kind: "connection_token",
        tokenHash: "1".repeat(64),
        revokedAt: START - MINUTE,
      }),
    );

    await asA.mutation(identity.accountDeletion.deleteAccount, {});

    const credential = await t.run((ctx) => ctx.db.get("credentials", credentialId));
    expect(credential?.revokedAt).toBe(START - MINUTE);
  });

  test("refuses a caller without an identity or without an account and writes nothing", async () => {
    const { t } = await setup();

    await expect(t.mutation(identity.accountDeletion.deleteAccount, {})).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(
      t.withIdentity({ subject: "user_c" }).mutation(identity.accountDeletion.deleteAccount, {}),
    ).rejects.toMatchObject(unauthenticated);

    expect(await t.run((ctx) => ctx.db.query("accountDeletions").collect())).toHaveLength(0);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.every((user) => user.deletingAt === undefined)).toBe(true);
  });

  test("a failure inside the transaction leaves the account active with nothing revoked", async () => {
    const { t, userA, asA, a } = await seedBoth();
    vi.spyOn(pushNotifications, "getNotificationsForUser").mockRejectedValueOnce(
      new Error("component unavailable"),
    );

    await expect(asA.mutation(identity.accountDeletion.deleteAccount, {})).rejects.toThrow(
      "component unavailable",
    );

    const user = await t.run((ctx) => ctx.db.get("users", userA));
    expect(user?.deletingAt).toBeUndefined();
    expect(await resolve(t, a.tokens[0] ?? "")).toMatchObject({ userId: userA });
    expect(await owned(t, userA, a)).toMatchObject({ devices: 1 });
    expect(await tokenStatus(t, a.deviceId)).toMatchObject({ hasToken: true });
    expect(await t.run((ctx) => ctx.db.query("accountDeletions").collect())).toHaveLength(0);
  });
});

describe("purge", () => {
  test("deletes every row of the account in batches and the users row last", async () => {
    const { t, userA, userB, asA, a, b } = await seedBoth();
    // Enough events with deliveries and history rows to need several batches.
    await t.run(async (ctx) => {
      for (let i = 0; i < 260; i++) {
        const eventId = await ctx.db.insert("events", {
          userId: userA,
          kind: "agent.done",
          agentSessionId: a.agentSessionId,
          occurredAt: START,
          action: "digest",
        });
        await ctx.db.insert("pushDeliveries", { eventId, deviceId: "old-install" });
      }
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("statusHistory", {
          agentSessionId: a.agentSessionId,
          state: "working",
          line: `line ${i}`,
          at: 100 + i,
        });
      }
    });
    const expiryJob = (await t.run((ctx) => ctx.db.get("decisions", a.pendingDecisionId)))
      ?.expiryJobId;
    const beforeB = await owned(t, userB, b);
    await asA.mutation(identity.accountDeletion.deleteAccount, {});

    const batches = await runPurge(t, "user_a");

    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const deleted of batches) {
      // The users row is the one row past the batch budget.
      expect(deleted).toBeLessThanOrEqual(PURGE_BATCH + 1);
    }
    const counts = await owned(t, userA, a);
    for (const [table, count] of Object.entries(counts)) {
      expect({ table, count }).toEqual({ table, count: 0 });
    }
    // The pending decision's expiry job was cancelled before its row went.
    if (expiryJob === undefined) {
      throw new Error("No expiry job");
    }
    const job = await t.run((ctx) => ctx.db.system.get(expiryJob));
    expect(job?.state.kind).toBe("canceled");
    // A sign-in request the account never approved stays.
    await t.run((ctx) =>
      ctx.db.insert("deviceRequests", {
        userCode: "PENDING1",
        deviceSecretHash: "secret-pending",
        machineName: "Laptop",
        harnesses: ["codex"],
        status: "pending",
        expiresAt: START + 10 * MINUTE,
      }),
    );
    // The other account is unchanged.
    expect(await owned(t, userB, b)).toEqual(beforeB);
    // The record stays, without the email, while the Clerk deletion is pending.
    const record = await deletionOf(t, "user_a");
    expect(record).toMatchObject({ purgedAt: START, clerk: { state: "pending" } });
    expect(JSON.stringify(record)).not.toContain("a@example.com");
  });

  test("a stale or duplicate batch does nothing, and duplicates converge", async () => {
    const { t, userA, asA, a } = await seedBoth();
    await addEvents(t, userA, a, 300);
    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    const record = await deletionOf(t, "user_a");
    if (record === null) {
      throw new Error("No deletion record");
    }

    // Two copies of the same batch: the second sees the advanced generation.
    await Promise.all([
      t.mutation(identity.accountDeletion.purgeBatch, { deletionId: record._id, generation: 1 }),
      t.mutation(identity.accountDeletion.purgeBatch, { deletionId: record._id, generation: 1 }),
    ]);
    const after = await deletionOf(t, "user_a");
    expect(after?.generation).toBe(2);
    expect(await scheduled(t, "identity/accountDeletion:purgeBatch")).toHaveLength(2);
    const before = await totalRows(t);
    await t.mutation(identity.accountDeletion.purgeBatch, {
      deletionId: record._id,
      generation: 1,
    });
    expect(await totalRows(t)).toBe(before);

    await runPurge(t, "user_a");
    expect(Object.values(await owned(t, userA, a)).every((count) => count === 0)).toBe(true);
  });

  test("a batch that fails changes nothing, and recovery resumes the purge", async () => {
    const { t, userA, asA, a } = await seedBoth();
    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    // A device row added behind the guard makes the notifications phase call
    // the push component, which fails once.
    await t.run((ctx) =>
      ctx.db.insert("devices", {
        userId: userA,
        deviceId: "late-install",
        name: "Late",
        platform: "ios",
      }),
    );
    const progressed = await deletionOf(t, "user_a");
    if (progressed === null) {
      throw new Error("No deletion record");
    }
    // The first batch deletes the decisions and agent sessions, then fails
    // in the notifications phase: every deletion of the batch rolls back.
    const failing = vi
      .spyOn(pushNotifications, "removeToken")
      .mockRejectedValue(new Error("component unavailable"));
    const before = await totalRows(t);
    await expect(
      t.mutation(identity.accountDeletion.purgeBatch, {
        deletionId: progressed._id,
        generation: progressed.generation,
      }),
    ).rejects.toThrow("component unavailable");
    expect(await owned(t, userA, a)).toMatchObject({ decisions: 2, agentSessions: 1 });
    expect(await totalRows(t)).toBe(before);
    expect(await deletionOf(t, "user_a")).toEqual(progressed);
    failing.mockRestore();

    // The failed batch left no successor. Recovery restarts it once its
    // progress is stale, under a new generation.
    expect(await t.mutation(identity.accountDeletion.resumePurges, {})).toBe(0);
    vi.setSystemTime(START + STALL_MS + MINUTE);
    expect(await t.mutation(identity.accountDeletion.resumePurges, {})).toBe(1);
    const restarted = await deletionOf(t, "user_a");
    expect(restarted).toMatchObject({
      generation: (progressed?.generation ?? 0) + 1,
      restarts: 1,
      updatedAt: START + STALL_MS + MINUTE,
    });

    await runPurge(t, "user_a");
    expect(Object.values(await owned(t, userA, a)).every((count) => count === 0)).toBe(true);
  });

  test("recovery leaves progressing deletions alone and logs one past its deadline", async () => {
    const { t, asA, asB } = await seedBoth();
    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    vi.setSystemTime(START + DELETION_WINDOW_MS + MINUTE);
    await asB.mutation(identity.accountDeletion.deleteAccount, {});
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await t.mutation(identity.accountDeletion.resumePurges, {})).toBe(1);

    expect(await deletionOf(t, "user_a")).toMatchObject({
      restarts: 1,
      overdueAt: START + DELETION_WINDOW_MS + MINUTE,
    });
    expect(await deletionOf(t, "user_b")).toMatchObject({ restarts: 0, generation: 1 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).not.toContain("user_a");
  });

  test("the scheduled chains finish the purge and the Clerk deletion on their own", async () => {
    const { t, userA, asA, a } = await seedBoth();
    // The push component's sender and the Clerk attempt would call fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).startsWith("https://exp.host")
          ? new Response(JSON.stringify({ data: [{ status: "ok", id: "x" }] }))
          : new Response(null, { status: 200 }),
      ),
    );
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test");
    await asA.mutation(identity.accountDeletion.deleteAccount, {});

    // Two minutes of scheduler time, a second at a time: the purge's batches,
    // the other account's queued push, and the Clerk attempt at one minute.
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(1_000);
      await t.finishInProgressScheduledFunctions();
    }

    expect(Object.values(await owned(t, userA, a)).every((count) => count === 0)).toBe(true);
    expect(await deletionOf(t, "user_a")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("refusals while an account is being deleted", () => {
  test("the Clerk subject cannot create an account while the record remains, and others can", async () => {
    const { t, asA } = await seedBoth();
    const first = await asA.mutation(identity.accountDeletion.deleteAccount, {});
    await runPurge(t, "user_a");
    const withEmail = t.withIdentity({ subject: "user_a", email: "a@example.com" });

    await expect(withEmail.mutation(identity.accounts.ensureAccount, {})).rejects.toMatchObject(
      unauthenticated,
    );
    expect(await withEmail.mutation(identity.accountDeletion.deleteAccount, {})).toEqual(first);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.map((user) => user.clerkUserId)).toEqual(["user_b"]);

    const newcomer = t.withIdentity({ subject: "user_c", email: "c@example.com" });
    expect(await newcomer.mutation(identity.accounts.ensureAccount, {})).toMatchObject({
      clerkUserId: "user_c",
    });
  });

  test("routing, expiry, and the sweep create nothing for a deleting account", async () => {
    const { t, userA, asA, a } = await seedBoth();
    const eventId = await t.run((ctx) =>
      ctx.db.insert("events", {
        userId: userA,
        kind: "agent.stale",
        agentSessionId: a.agentSessionId,
        occurredAt: START,
      }),
    );
    await t.run(async (ctx) => {
      const settings = await ctx.db
        .query("settings")
        .withIndex("by_user", (q) => q.eq("userId", userA))
        .unique();
      if (settings !== null) {
        await ctx.db.delete("settings", settings._id);
      }
    });
    await asA.mutation(identity.accountDeletion.deleteAccount, {});
    const eventsBefore = (await owned(t, userA, a)).events;

    await t.mutation(notifications.route.run, { eventId });
    vi.setSystemTime(START + 31 * MINUTE);
    await t.mutation(decisions.expire.run, { decisionId: a.pendingDecisionId });
    await t.mutation(agents.sweep.run, {});

    const event = await t.run((ctx) => ctx.db.get("events", eventId));
    expect(event?.action).toBeUndefined();
    const counts = await owned(t, userA, a);
    expect(counts.settings).toBe(0);
    expect(counts.events).toBe(eventsBefore);
    const decision = await t.run((ctx) => ctx.db.get("decisions", a.pendingDecisionId));
    expect(decision?.state).toBe("pending");
    const session = await t.run((ctx) => ctx.db.get("agentSessions", a.agentSessionId));
    expect(session?.staleSince).toBeUndefined();
  });
});
