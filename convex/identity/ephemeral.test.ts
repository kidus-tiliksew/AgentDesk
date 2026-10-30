import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { agents } from "../agents/refs";
import { touch } from "../agents/sessions";
import crons from "../crons";
import { decisions } from "../decisions/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertApiToken, insertConnectionToken } from "./credentials";
import { SWEEP_BATCH } from "./ephemeral";
import { type InstallKeyInput, insertInstallKey, machinesConnected } from "./installKeys";
import { identity } from "./refs";
import { hashToken } from "./tokens";

// component-identity §Ending a connection, with the effects of
// component-agent-presence §Lifecycle and component-decisions §State machine
// (req-install-keys REQ-4; DEC-21 (4)).

const START = Date.UTC(2026, 9, 30, 12, 0, 0);
const MINUTE = 60_000;
const IDLE_MINUTES = 15;
const IDLE = IDLE_MINUTES * MINUTE;
const asUserA = { subject: "user_a", email: "a@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };

const EPHEMERAL: InstallKeyInput = {
  label: "Sandboxes",
  harnesses: ["claude-code", "codex"],
  expiresInDays: 30,
  machineLimit: 100,
  ephemeral: true,
  idleLimitMinutes: IDLE_MINUTES,
};
const PERSISTENT: InstallKeyInput = { ...EPHEMERAL, ephemeral: false, idleLimitMinutes: undefined };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const { userId, otherUserId } = await t.run(async (ctx) => ({
    userId: await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    otherUserId: await ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" }),
  }));
  const mintKey = (input: InstallKeyInput = EPHEMERAL, owner = userId) =>
    t.run((ctx) => insertInstallKey(ctx, owner, input, Date.now()));
  // One enrollment run; returns its connections.
  const enroll = async (secret: string, harnesses = ["claude-code"], machineName = "sandbox") => {
    const result = await t.mutation(identity.installKeys.enroll, {
      keyHash: await hashToken(secret),
      machineName,
      harnesses,
    });
    if (result.status !== "enrolled") {
      throw new Error(`expected enrolled, got ${result.status}`);
    }
    return result.connections;
  };
  const credential = (id: Id<"credentials">) => t.run((ctx) => ctx.db.get("credentials", id));
  const resolve = async (token: string) =>
    t.mutation(internal.identity.credentials.resolveToken, { tokenHash: await hashToken(token) });
  const sweep = () => t.mutation(identity.ephemeral.sweep, {});
  // An activated agent session of `owner` opened with the credential.
  const openSession = async (credentialId: Id<"credentials">, owner = userId) => {
    const { agentSessionId } = await t.mutation(agents.sessions.open, {
      userId: owner,
      credentialId,
      clientName: "Claude Code",
      clientVersion: "2.1.0",
    });
    await t.run((ctx) => touch(ctx, owner, agentSessionId, "repo/x", Date.now()));
    return agentSessionId;
  };
  const ask = async (
    agentSessionId: Id<"agentSessions">,
    input: Record<string, unknown> = {},
    owner = userId,
  ) => {
    const decision = await t.mutation(decisions.operations.create, {
      userId: owner,
      agentSessionId,
      input: { title: "Ship it?", input_type: "approve_reject", topic: "repo/x", ...input },
    });
    return decision.id as Id<"decisions">;
  };
  const decision = (id: Id<"decisions">) => t.run((ctx) => ctx.db.get("decisions", id));
  const session = (id: Id<"agentSessions">) => t.run((ctx) => ctx.db.get("agentSessions", id));
  const events = (kind: Doc<"events">["kind"]) =>
    t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter((event) => event.kind === kind),
    );
  return {
    t,
    a: t.withIdentity(asUserA),
    userId,
    otherUserId,
    mintKey,
    enroll,
    credential,
    resolve,
    sweep,
    openSession,
    ask,
    decision,
    session,
    events,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// An ephemeral connection with an activated session holding a pending
// decision with a deadline, a pending decision without one, and an answered
// decision. Another session of the same account on another connection holds
// one pending decision.
async function connectionWithWork(s: Setup) {
  const key = await s.mintKey();
  const [connection] = await s.enroll(key.secret);
  if (connection === undefined) throw new Error("no connection");
  const credentialId = connection.connection_id;
  const sessionId = await s.openSession(credentialId);
  const timed = await s.ask(sessionId, {
    deadline: new Date(START + 60 * MINUTE).toISOString(),
    default: { kind: "reject" },
  });
  const open = await s.ask(sessionId);
  const answered = await s.ask(sessionId);
  await s.t.mutation(decisions.devAnswer.answer, {
    decisionId: answered,
    answer: { kind: "approve" },
    answeredVia: "app",
  });
  const otherCredential = await s.t.run((ctx) =>
    insertConnectionToken(ctx, { userId: s.userId, harness: "codex", name: "Codex" }),
  );
  const otherSession = await s.openSession(otherCredential.credentialId);
  const otherPending = await s.ask(otherSession);
  return {
    key,
    connection,
    credentialId,
    sessionId,
    timed,
    open,
    answered,
    otherCredentialId: otherCredential.credentialId,
    otherSession,
    otherPending,
  };
}

// Checks the cascade of one ended ephemeral connection made by
// connectionWithWork, ended at `endedAt`.
async function expectEnded(
  s: Setup,
  work: Awaited<ReturnType<typeof connectionWithWork>>,
  endedAt: number,
) {
  const credential = await s.credential(work.credentialId);
  expect(credential?.revokedAt).toBe(endedAt);
  expect(credential).not.toHaveProperty("idleDeadlineAt");
  expect(await s.session(work.sessionId)).toMatchObject({
    endedAt,
    endReason: "disconnected",
  });
  for (const id of [work.timed, work.open]) {
    expect(await s.decision(id)).toMatchObject({
      state: "cancelled",
      cancelReason: "connection_ended",
      settledAt: endedAt,
    });
  }
  const timed = await s.decision(work.timed);
  const job = await s.t.run((ctx) =>
    ctx.db.system.get(timed?.expiryJobId as Id<"_scheduled_functions">),
  );
  expect(job?.state.kind).toBe("canceled");
  // The answered decision and the other connection's work are unchanged.
  expect(await s.decision(work.answered)).toMatchObject({ state: "answered" });
  expect(await s.decision(work.answered)).not.toHaveProperty("cancelReason");
  expect(await s.decision(work.otherPending)).toMatchObject({ state: "pending" });
  expect(await s.session(work.otherSession)).not.toHaveProperty("endedAt");
  expect((await s.credential(work.otherCredentialId))?.revokedAt).toBeUndefined();
  // One event per cancelled decision, and no agent.done.
  const cancelled = await s.events("decision.cancelled");
  expect(cancelled.map((event) => event.decisionId).sort()).toEqual([work.timed, work.open].sort());
  expect(cancelled.every((event) => event.occurredAt === endedAt)).toBe(true);
  expect(await s.events("agent.done")).toEqual([]);
}

describe("idle deadline", () => {
  // §Enrollment: the enrollment sets the first deadline.
  test("starts at enrollment plus the key's idle limit", async () => {
    const s = await setup();
    const key = await s.mintKey();

    const [connection] = await s.enroll(key.secret);

    expect(
      (await s.credential(connection?.connection_id as Id<"credentials">))?.idleDeadlineAt,
    ).toBe(START + IDLE);
  });

  // A resolve writes lastUsedAt at most once a minute, and moves the deadline
  // with it, a minute past the idle limit, so a request inside that minute
  // that writes nothing is still covered.
  test("moves with each lastUsedAt write and not between them", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const [connection] = await s.enroll(key.secret);
    const id = connection?.connection_id as Id<"credentials">;

    vi.setSystemTime(START + 5 * MINUTE);
    await s.resolve(connection?.token ?? "");
    expect(await s.credential(id)).toMatchObject({
      lastUsedAt: START + 5 * MINUTE,
      idleDeadlineAt: START + 5 * MINUTE + MINUTE + IDLE,
    });

    vi.setSystemTime(START + 5 * MINUTE + 30_000);
    await s.resolve(connection?.token ?? "");
    expect(await s.credential(id)).toMatchObject({
      lastUsedAt: START + 5 * MINUTE,
      idleDeadlineAt: START + 6 * MINUTE + IDLE,
    });

    vi.setSystemTime(START + 7 * MINUTE);
    await s.resolve(connection?.token ?? "");
    expect(await s.credential(id)).toMatchObject({
      lastUsedAt: START + 7 * MINUTE,
      idleDeadlineAt: START + 8 * MINUTE + IDLE,
    });
  });

  // req-install-keys AC-3.2: a revoked key's connections keep working.
  test("still moves for a connection whose key was revoked", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const [connection] = await s.enroll(key.secret);
    await s.a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: key.installKeyId,
      revokeConnections: false,
    });
    vi.setSystemTime(START + 10 * MINUTE);

    await s.resolve(connection?.token ?? "");

    expect(
      (await s.credential(connection?.connection_id as Id<"credentials">))?.idleDeadlineAt,
    ).toBe(START + 11 * MINUTE + IDLE);
  });

  test("is never written on a connection of a key that is not ephemeral or one made by short code", async () => {
    const s = await setup();
    const key = await s.mintKey(PERSISTENT);
    const [connection] = await s.enroll(key.secret);
    const short = await s.t.run((ctx) =>
      insertConnectionToken(ctx, { userId: s.userId, harness: "codex", name: "Codex" }),
    );
    vi.setSystemTime(START + 5 * MINUTE);

    await s.resolve(connection?.token ?? "");
    await s.resolve(short.plaintext);

    for (const id of [connection?.connection_id as Id<"credentials">, short.credentialId]) {
      const row = await s.credential(id);
      expect(row?.lastUsedAt).toBe(START + 5 * MINUTE);
      expect(row).not.toHaveProperty("idleDeadlineAt");
    }
  });
});

describe("sweep", () => {
  // req-install-keys AC-4.1, AC-4.2
  test("ends a connection once its deadline passes, with its sessions and pending decisions", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);
    // A quiet connection: no request after the enrollment.
    vi.setSystemTime(START + IDLE - 1);
    expect(await s.sweep()).toBe(0);
    expect((await s.credential(work.credentialId))?.revokedAt).toBeUndefined();

    vi.setSystemTime(START + IDLE);
    expect(await s.sweep()).toBe(1);

    await expectEnded(s, work, START + IDLE);
    await expect(s.resolve(work.connection.token)).rejects.toMatchObject(unauthenticated);
  });

  test("a connection that keeps making requests is never ended", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const [connection] = await s.enroll(key.secret);
    // A request every 14 minutes for two hours, each minute's sweep running.
    for (let minute = 1; minute <= 120; minute++) {
      vi.setSystemTime(START + minute * MINUTE);
      if (minute % 14 === 0) {
        await s.resolve(connection?.token ?? "");
      }
      await s.sweep();
    }

    expect(
      (await s.credential(connection?.connection_id as Id<"credentials">))?.revokedAt,
    ).toBeUndefined();
  });

  // req-install-keys AC-4.1: with the sweep every minute, a connection quiet
  // since its last request ends no sooner than its idle limit and within
  // five minutes after it, though that request wrote nothing.
  test("ends a quiet connection between its idle limit and five minutes after it", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const [connection] = await s.enroll(key.secret);
    const id = connection?.connection_id as Id<"credentials">;
    vi.setSystemTime(START + 2 * MINUTE);
    await s.resolve(connection?.token ?? "");
    // The last request, inside the minute after the write, writes nothing.
    const lastRequest = START + 2 * MINUTE + 59_000;
    vi.setSystemTime(lastRequest);
    await s.resolve(connection?.token ?? "");

    let endedAt: number | undefined;
    for (let minute = 3; minute <= 30 && endedAt === undefined; minute++) {
      vi.setSystemTime(START + minute * MINUTE);
      await s.sweep();
      endedAt = (await s.credential(id))?.revokedAt;
    }

    expect(endedAt).toBeDefined();
    expect(endedAt as number).toBeGreaterThanOrEqual(lastRequest + IDLE);
    expect(endedAt as number).toBeLessThanOrEqual(lastRequest + IDLE + 5 * MINUTE);
  });

  // req-install-keys AC-4.3
  test("an ended connection leaves the list and stops counting toward the machine limit", async () => {
    const s = await setup();
    const key = await s.mintKey({ ...EPHEMERAL, machineLimit: 1 });
    const connections = await s.enroll(key.secret, ["claude-code", "codex"]);
    const machineCount = () => s.t.run((ctx) => machinesConnected(ctx, key.installKeyId));
    expect(await machineCount()).toBe(1);
    // One harness of the machine stays active: the machine still counts.
    vi.setSystemTime(START + 10 * MINUTE);
    await s.resolve(connections[1]?.token ?? "");
    vi.setSystemTime(START + IDLE);
    await s.sweep();
    const listed = await s.a.query(identity.connections.listConnections, {});
    expect(listed.map((connection) => connection.credentialId)).toEqual([
      connections[1]?.connection_id,
    ]);
    expect(await machineCount()).toBe(1);
    expect(
      (
        await s.t.mutation(identity.installKeys.enroll, {
          keyHash: await hashToken(key.secret),
          machineName: "next",
          harnesses: ["codex"],
        })
      ).status,
    ).toBe("limit_reached");

    vi.setSystemTime(START + 11 * MINUTE + IDLE);
    await s.sweep();

    expect(await s.a.query(identity.connections.listConnections, {})).toEqual([]);
    expect(await machineCount()).toBe(0);
    expect((await s.enroll(key.secret, ["codex"], "next")).length).toBe(1);
  });

  test("a second sweep changes nothing and emits no second event", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);
    vi.setSystemTime(START + IDLE);
    await s.sweep();
    vi.setSystemTime(START + IDLE + MINUTE);

    expect(await s.sweep()).toBe(0);

    await expectEnded(s, work, START + IDLE);
  });

  // §Ending a connection: 100 rows a run, and a full batch runs again at once.
  test("ends at most 100 connections a run and schedules the next run for the rest", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const total = SWEEP_BATCH + 30;
    await s.t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        await insertConnectionToken(ctx, {
          userId: s.userId,
          harness: "codex",
          name: "Codex",
          installKeyId: key.installKeyId,
          machineId: `machine-${i}`,
          idleDeadlineAt: START + i,
        });
      }
    });
    vi.setSystemTime(START + IDLE);

    expect(await s.sweep()).toBe(SWEEP_BATCH);
    const live = () =>
      s.t.run(async (ctx) =>
        (await ctx.db.query("credentials").collect()).filter((row) => row.revokedAt === undefined),
      );
    expect(await live()).toHaveLength(30);
    // The earliest deadlines went first.
    const remaining = (await live()).map((row) => row.idleDeadlineAt as number);
    expect(Math.min(...remaining)).toBe(START + SWEEP_BATCH);

    await s.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await live()).toEqual([]);
  });

  // Revoked rows still holding a deadline, such as those account deletion
  // revoked, must not hold back the live rows behind them.
  test("clears revoked rows' deadlines so a later run reaches the live rows behind them", async () => {
    const s = await setup();
    const key = await s.mintKey();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < SWEEP_BATCH + 20; i++) {
        const { credentialId } = await insertConnectionToken(ctx, {
          userId: s.userId,
          harness: "codex",
          name: "Codex",
          installKeyId: key.installKeyId,
          machineId: `revoked-${i}`,
          idleDeadlineAt: START + i,
        });
        await ctx.db.patch("credentials", credentialId, { revokedAt: START - MINUTE });
      }
    });
    const [connection] = await s.enroll(key.secret);
    vi.setSystemTime(START + IDLE);

    expect(await s.sweep()).toBe(0);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await s.t.run((ctx) => ctx.db.query("credentials").collect());
    expect(rows.every((row) => row.idleDeadlineAt === undefined)).toBe(true);
    // The revoked rows keep their first revocation time.
    expect(rows.filter((row) => row.revokedAt === START - MINUTE)).toHaveLength(SWEEP_BATCH + 20);
    expect((await s.credential(connection?.connection_id as Id<"credentials">))?.revokedAt).toBe(
      START + IDLE,
    );
  });

  test("ends sessions only of the swept connection's own account", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const [connection] = await s.enroll(key.secret);
    const credentialId = connection?.connection_id as Id<"credentials">;
    // A session of another account naming this credential, as a forged
    // session row would.
    const foreign = await s.openSession(credentialId, s.otherUserId);
    const foreignPending = await s.ask(foreign, {}, s.otherUserId);
    vi.setSystemTime(START + IDLE);

    await s.sweep();

    expect(await s.session(foreign)).not.toHaveProperty("endedAt");
    expect(await s.decision(foreignPending)).toMatchObject({ state: "pending" });
  });

  // A session that had already ended as done or idle keeps its end; its
  // pending decisions are still cancelled (req-install-keys AC-4.2).
  test("cancels decisions left pending by a session that had already ended", async () => {
    const s = await setup();
    const key = await s.mintKey();
    const [connection] = await s.enroll(key.secret);
    const credentialId = connection?.connection_id as Id<"credentials">;
    const done = await s.openSession(credentialId);
    const pending = await s.ask(done);
    await s.t.mutation(agents.sessions.status, {
      userId: s.userId,
      agentSessionId: done,
      topic: "repo/x",
      state: "done",
      line: "Finished",
    });
    vi.setSystemTime(START + IDLE);

    await s.sweep();

    expect(await s.session(done)).toMatchObject({ endedAt: START, endReason: "done" });
    expect(await s.decision(pending)).toMatchObject({
      state: "cancelled",
      cancelReason: "connection_ended",
    });
  });
});

describe("revocation by the person or the machine", () => {
  // req-install-keys AC-4.2
  test("revokeConnection on an ephemeral connection ends it with the cascade", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);
    vi.setSystemTime(START + MINUTE);

    await s.a.mutation(identity.connections.revokeConnection, { credentialId: work.credentialId });

    await expectEnded(s, work, START + MINUTE);
  });

  test("revokeInstallKey with revokeConnections ends an ephemeral key's connections with the cascade", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);
    vi.setSystemTime(START + MINUTE);

    await s.a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: work.key.installKeyId,
      revokeConnections: true,
    });

    await expectEnded(s, work, START + MINUTE);
  });

  test("revokeInstallKey without revokeConnections ends nothing", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);

    await s.a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: work.key.installKeyId,
      revokeConnections: false,
    });

    expect((await s.credential(work.credentialId))?.revokedAt).toBeUndefined();
    expect(await s.decision(work.open)).toMatchObject({ state: "pending" });
    expect(await s.session(work.sessionId)).not.toHaveProperty("endedAt");
  });

  test("revoke-self on an ephemeral connection ends it with the cascade", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);
    vi.setSystemTime(START + MINUTE);

    await s.t.mutation(internal.identity.selfRevoke.revokeSelf, {
      tokenHash: await hashToken(work.connection.token),
    });

    await expectEnded(s, work, START + MINUTE);
  });

  // DEC-21 (4): a connection made by short code, by a key that is not
  // ephemeral, or by the Mac app keeps its revoke effect: the credential is
  // revoked, and its sessions and decisions are untouched.
  test.each([
    ["revokeConnection", "short code"],
    ["revokeConnection", "persistent key"],
    ["revokeConnection", "Mac"],
    ["revokeInstallKey", "persistent key"],
    ["revoke-self", "short code"],
    ["revoke-self", "persistent key"],
    ["revoke-self", "Mac"],
  ] as const)("%s on a %s connection keeps revokeCredential alone", async (via, source) => {
    const s = await setup();
    const key = await s.mintKey(PERSISTENT);
    let credentialId: Id<"credentials">;
    let token: string;
    if (source === "persistent key") {
      const [connection] = await s.enroll(key.secret);
      credentialId = connection?.connection_id as Id<"credentials">;
      token = connection?.token ?? "";
    } else {
      const minted = await s.t.run((ctx) =>
        source === "Mac"
          ? insertApiToken(ctx, {
              userId: s.userId,
              name: "AgentDesk for Mac",
              harness: "macos",
              machineName: "mac",
            })
          : insertConnectionToken(ctx, { userId: s.userId, harness: "codex", name: "Codex" }),
      );
      credentialId = minted.credentialId;
      token = minted.plaintext;
    }
    const sessionId = await s.openSession(credentialId);
    const pending = await s.ask(sessionId);
    vi.setSystemTime(START + MINUTE);

    if (via === "revokeConnection") {
      await s.a.mutation(identity.connections.revokeConnection, { credentialId });
    } else if (via === "revokeInstallKey") {
      await s.a.mutation(identity.installKeys.revokeInstallKey, {
        installKeyId: key.installKeyId,
        revokeConnections: true,
      });
    } else {
      await s.t.mutation(internal.identity.selfRevoke.revokeSelf, {
        tokenHash: await hashToken(token),
      });
    }

    expect((await s.credential(credentialId))?.revokedAt).toBe(START + MINUTE);
    const session = await s.session(sessionId);
    expect(session).not.toHaveProperty("endedAt");
    expect(session).not.toHaveProperty("endReason");
    expect(await s.decision(pending)).toMatchObject({ state: "pending" });
    expect(await s.decision(pending)).not.toHaveProperty("cancelReason");
    expect(await s.events("decision.cancelled")).toEqual([]);
  });
});

describe("disconnected sessions", () => {
  // component-agent-presence §Sweep: a disconnected end is purged like any
  // other end after 7 days, and the minute sweep leaves it alone.
  test("follow the agent sweep and the 7-day purge like any ended session", async () => {
    const s = await setup();
    const work = await connectionWithWork(s);
    await s.a.mutation(identity.connections.revokeConnection, { credentialId: work.credentialId });

    vi.setSystemTime(START + 24 * 60 * MINUTE);
    await s.t.mutation(agents.sweep.run, {});
    expect(await s.session(work.sessionId)).toMatchObject({
      endedAt: START,
      endReason: "disconnected",
    });
    expect(await s.events("agent.stale")).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ agentSessionId: work.sessionId })]),
    );

    vi.setSystemTime(START + 7 * 24 * 60 * MINUTE + MINUTE);
    await s.t.mutation(agents.purge.run, {});
    expect(await s.session(work.sessionId)).toBeNull();
    // Decisions outlive their purged sessions and keep their reason.
    expect(await s.decision(work.open)).toMatchObject({ cancelReason: "connection_ended" });
  });
});

describe("cron", () => {
  // component-backend-foundation §Scheduling
  test("runs the sweep every minute", () => {
    const entry = Object.values(
      (crons as unknown as { crons: Record<string, { name: string; schedule: unknown }> }).crons,
    ).find((cron) => cron.name === "identity/ephemeral:sweep");

    expect(entry?.schedule).toEqual({ type: "interval", minutes: 1 });
    expect(
      (crons as unknown as { crons: Record<string, unknown> }).crons["ephemeral connection sweep"],
    ).toBe(entry);
  });
});
