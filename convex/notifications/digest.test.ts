import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { decisions } from "../decisions/refs";
import { DISPATCH_BATCH } from "./digest";
import type { EventKind } from "./events";
import { notifications } from "./refs";
import { ensureSettings } from "./settings";
import { openSession, queued, register, type Setup, setup } from "./test.setup";

// component-notifications §Digests. Fake timers keep both the push
// component's scheduled sender and the scheduled `dispatchUser` runs from
// executing, so no test contacts Expo; tests run the workers directly with
// the arguments `dispatchDue` scheduled.

// 2026-10-12 12:00Z. A row created now under the defaults (UTC, 09:00) is
// next due at 2026-10-13 09:00Z.
const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST_SLOT = Date.UTC(2026, 9, 13, 9, 0);
const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found" } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

type DecisionFields = Partial<
  Pick<Doc<"decisions">, "title" | "priority" | "state" | "deadline" | "answer" | "answeredAt">
>;

async function insertDecision(
  t: Setup["t"],
  userId: Id<"users">,
  agentSessionId: Id<"agentSessions">,
  fields: DecisionFields = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("decisions", {
      userId,
      agentSessionId,
      topic: "repo/x",
      title: "Ship it?",
      inputType: "approve_reject",
      priority: "normal",
      state: "pending",
      searchText: "Ship it?",
      ...fields,
    }),
  );
}

type EventFields = Partial<
  Pick<
    Doc<"events">,
    "action" | "digestId" | "decisionId" | "agentSessionId" | "occurredAt" | "topic"
  >
>;

// An event as `route` leaves it, with `action` "digest" unless overridden.
async function insertEvent(
  t: Setup["t"],
  userId: Id<"users">,
  kind: EventKind,
  fields: EventFields = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("events", {
      userId,
      kind,
      topic: "repo/x",
      occurredAt: START,
      action: "digest",
      ...fields,
    }),
  );
}

// Creates the person's settings row at the current time.
function ensure(t: Setup["t"], userId: Id<"users">) {
  return t.run((ctx) => ensureSettings(ctx, userId, Date.now()));
}

async function settingsOf(t: Setup["t"], userId: Id<"users">) {
  const row = await t.run((ctx) =>
    ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
  if (row === null) {
    throw new Error("No settings row");
  }
  return row;
}

function digestsOf(t: Setup["t"], userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db
      .query("digests")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

function eventOf(t: Setup["t"], eventId: Id<"events">) {
  return t.run((ctx) => ctx.db.get("events", eventId));
}

// Runs the person's worker for the slot their row holds now.
async function runWorker(t: Setup["t"], userId: Id<"users">) {
  const row = await settingsOf(t, userId);
  return await t.mutation(notifications.digest.dispatchUser, {
    settingsId: row._id,
    expectedNextDigestAt: row.nextDigestAt,
  });
}

function dispatchDue(t: Setup["t"]) {
  return t.mutation(notifications.digest.dispatchDue, {});
}

type WorkerArgs = { settingsId: Id<"settings">; expectedNextDigestAt: number };

// The arguments of every scheduled `dispatchUser`, oldest first.
async function scheduledWorkers(t: Setup["t"]): Promise<WorkerArgs[]> {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((job) => job.name.startsWith("notifications/digest"))
    .map((job) => job.args[0] as WorkerArgs);
}

// Person A with a settings row and two registered installs, at a moment one
// minute after the row's first slot.
async function dueSetup() {
  const s = await setup();
  await register(s.asA, "install-1", "ExponentPushToken[1]");
  await register(s.asA, "install-2", "ExponentPushToken[2]");
  await ensure(s.t, s.userA);
  const sessionA = await openSession(s.t, s.userA, "Builder");
  vi.setSystemTime(FIRST_SLOT + MINUTE);
  return { ...s, sessionA };
}

describe("dispatchUser", () => {
  // req-notification-rules AC-6.2, REQ-6
  test("sends nothing without digest events or pending decisions and still advances the slot", async () => {
    const { t, userA } = await dueSetup();

    expect(await runWorker(t, userA)).toBeNull();

    expect(await digestsOf(t, userA)).toEqual([]);
    expect(await queued(t, "install-1")).toHaveLength(0);
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(FIRST_SLOT + DAY);
  });

  // AC-6.3
  test("sends a digest of pending decisions only", async () => {
    const { t, userA, sessionA } = await dueSetup();
    const pending = await insertDecision(t, userA, sessionA);
    await insertDecision(t, userA, sessionA, { state: "answered", answer: { kind: "approve" } });

    const digestId = await runWorker(t, userA);

    const [digest] = await digestsOf(t, userA);
    expect(digest).toMatchObject({
      _id: digestId,
      eventIds: [],
      pendingDecisionIds: [pending],
      sentAt: FIRST_SLOT + MINUTE,
    });
    const [push] = await queued(t, "install-1");
    expect(push).toMatchObject({ title: "Daily digest", body: "0 events · 1 pending decision" });
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(FIRST_SLOT + DAY);
  });

  // REQ-1, AC-1.2, REQ-6
  test("holds and stamps only unstamped digest events, with every pending decision", async () => {
    const { t, userA, userB, sessionA } = await dueSetup();
    const decision = await insertDecision(t, userA, sessionA);
    const urgent = await insertDecision(t, userA, sessionA, { priority: "urgent" });
    const expired = await insertEvent(t, userA, "decision.expired", { decisionId: decision });
    const done = await insertEvent(t, userA, "agent.done", { agentSessionId: sessionA });
    const earlier = await t.run((ctx) =>
      ctx.db.insert("digests", {
        userId: userA,
        eventIds: [],
        pendingDecisionIds: [],
        sentAt: START - DAY,
      }),
    );
    const excluded = [
      await insertEvent(t, userA, "decision.created", { action: "push" }),
      await insertEvent(t, userA, "agent.status_changed", { action: "mute" }),
      await insertEvent(t, userA, "decision.answered", { action: null }),
      await insertEvent(t, userA, "agent.stale", { action: undefined }),
      await insertEvent(t, userA, "agent.done", { digestId: earlier }),
      await insertEvent(t, userB, "agent.done"),
    ];
    const before = await Promise.all(excluded.map((id) => eventOf(t, id)));

    const digestId = await runWorker(t, userA);
    if (digestId === null) {
      throw new Error("No digest sent");
    }

    const digests = await digestsOf(t, userA);
    const digest = digests.find((row) => row._id === digestId);
    expect(digest?.eventIds).toEqual([expired, done]);
    expect(digest?.pendingDecisionIds.sort()).toEqual([decision, urgent].sort());
    expect((await eventOf(t, expired))?.digestId).toBe(digestId);
    expect((await eventOf(t, done))?.digestId).toBe(digestId);
    expect(await Promise.all(excluded.map((id) => eventOf(t, id)))).toEqual(before);
    const [push] = await queued(t, "install-1");
    expect(push?.body).toBe("2 events · 2 pending decisions");
    // A digest holding an urgent decision is still not time-sensitive.
    expect(push).not.toHaveProperty("interruptionLevel");
  });

  // REQ-7
  test("queues one digest push per current device with protected data", async () => {
    const { t, userA, userB, asA, asB, sessionA } = await dueSetup();
    await register(asA, "install-3", "ExponentPushToken[3]");
    await asA.mutation(notifications.devices.unregisterDevice, { deviceId: "install-3" });
    await register(asB, "install-b", "ExponentPushToken[b]");
    await insertDecision(t, userA, sessionA);
    await insertEvent(t, userA, "agent.done", { agentSessionId: sessionA });

    const digestId = await runWorker(t, userA);

    for (const deviceId of ["install-1", "install-2"]) {
      const pushes = await queued(t, deviceId);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        title: "Daily digest",
        body: "1 event · 1 pending decision",
        state: "awaiting_delivery",
      });
      expect(pushes[0]?.data).toEqual({ kind: "digest", digestId });
    }
    expect(await queued(t, "install-3")).toHaveLength(0);
    expect(await queued(t, "install-b")).toHaveLength(0);
    expect(await digestsOf(t, userB)).toEqual([]);
    // A digest push writes no event delivery rows.
    expect(await t.run((ctx) => ctx.db.query("pushDeliveries").collect())).toEqual([]);
  });

  // REQ-6, REQ-7
  test("a repeated worker sends nothing more", async () => {
    const { t, userA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);
    const slot = (await settingsOf(t, userA)).nextDigestAt;
    const args = { settingsId: (await settingsOf(t, userA))._id, expectedNextDigestAt: slot };

    expect(await t.mutation(notifications.digest.dispatchUser, args)).not.toBeNull();
    expect(await t.mutation(notifications.digest.dispatchUser, args)).toBeNull();
    // The advanced slot is not due, so its own worker does nothing either.
    expect(await runWorker(t, userA)).toBeNull();
    expect(await dispatchDue(t)).toBe(0);

    expect(await digestsOf(t, userA)).toHaveLength(1);
    expect(await queued(t, "install-1")).toHaveLength(1);
    expect(await queued(t, "install-2")).toHaveLength(1);
  });

  // REQ-6, REQ-7
  test("overlapping workers for one slot send one digest", async () => {
    const { t, userA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);
    await insertEvent(t, userA, "agent.done");
    const row = await settingsOf(t, userA);
    const args = { settingsId: row._id, expectedNextDigestAt: row.nextDigestAt };

    const results = await Promise.all([
      t.mutation(notifications.digest.dispatchUser, args),
      t.mutation(notifications.digest.dispatchUser, args),
      t.mutation(notifications.digest.dispatchUser, args),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await digestsOf(t, userA)).toHaveLength(1);
    expect(await queued(t, "install-1")).toHaveLength(1);
    expect(await queued(t, "install-2")).toHaveLength(1);
  });

  test("does nothing for a slot that settings moved after dispatch", async () => {
    const { t, userA, asA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);
    expect(await dispatchDue(t)).toBe(1);
    const [scheduled] = await scheduledWorkers(t);
    if (scheduled === undefined) {
      throw new Error("No worker scheduled");
    }

    // A new digest time recomputes the slot from now, so the scheduled one is
    // stale.
    await asA.mutation(notifications.settings.updateSettings, { digestTime: "18:00" });
    expect(await t.mutation(notifications.digest.dispatchUser, scheduled)).toBeNull();

    expect(await digestsOf(t, userA)).toEqual([]);
    expect(await queued(t, "install-1")).toHaveLength(0);
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(Date.UTC(2026, 9, 13, 18, 0));
  });

  test("does nothing for a slot that is not yet due or a removed settings row", async () => {
    const { t, userA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);
    vi.setSystemTime(FIRST_SLOT - MINUTE);
    expect(await runWorker(t, userA)).toBeNull();
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(FIRST_SLOT);

    vi.setSystemTime(FIRST_SLOT + MINUTE);
    const row = await settingsOf(t, userA);
    await t.run((ctx) => ctx.db.delete("settings", row._id));
    expect(
      await t.mutation(notifications.digest.dispatchUser, {
        settingsId: row._id,
        expectedNextDigestAt: row.nextDigestAt,
      }),
    ).toBeNull();
    expect(await digestsOf(t, userA)).toEqual([]);
  });

  test("sends no digest to an account being deleted and advances its slot", async () => {
    const { t, userA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);
    await t.run((ctx) => ctx.db.patch("users", userA, { deletingAt: Date.now() }));

    expect(await runWorker(t, userA)).toBeNull();

    expect(await digestsOf(t, userA)).toEqual([]);
    expect(await queued(t, "install-1")).toHaveLength(0);
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(FIRST_SLOT + DAY);
  });

  // REQ-6
  test("sends one digest after several missed days and schedules the next local slot", async () => {
    const { t, userA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);
    await insertEvent(t, userA, "agent.done", { occurredAt: FIRST_SLOT + DAY });
    const now = FIRST_SLOT + 3 * DAY + 2 * HOUR;
    vi.setSystemTime(now);

    expect(await dispatchDue(t)).toBe(1);
    const workers = await scheduledWorkers(t);
    for (const args of workers) {
      await t.mutation(notifications.digest.dispatchUser, args);
    }
    expect(await runWorker(t, userA)).toBeNull();

    expect(await digestsOf(t, userA)).toHaveLength(1);
    expect(await queued(t, "install-1")).toHaveLength(1);
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(FIRST_SLOT + 4 * DAY);
    expect(await dispatchDue(t)).toBe(0);
  });

  test("handles a second person independently", async () => {
    const { t, userA, userB, asB, sessionA } = await dueSetup();
    vi.setSystemTime(START);
    await register(asB, "install-b", "ExponentPushToken[b]");
    await ensure(t, userB);
    const sessionB = await openSession(t, userB);
    vi.setSystemTime(FIRST_SLOT + MINUTE);
    const eventA = await insertEvent(t, userA, "agent.done", { agentSessionId: sessionA });
    const decisionB = await insertDecision(t, userB, sessionB);

    expect(await dispatchDue(t)).toBe(2);
    for (const args of await scheduledWorkers(t)) {
      await t.mutation(notifications.digest.dispatchUser, args);
    }

    const [digestA] = await digestsOf(t, userA);
    const [digestB] = await digestsOf(t, userB);
    expect(digestA).toMatchObject({ eventIds: [eventA], pendingDecisionIds: [] });
    expect(digestB).toMatchObject({ eventIds: [], pendingDecisionIds: [decisionB] });
    expect((await queued(t, "install-1"))[0]?.data).toEqual({
      kind: "digest",
      digestId: digestA?._id,
    });
    expect((await queued(t, "install-b"))[0]?.data).toEqual({
      kind: "digest",
      digestId: digestB?._id,
    });
    expect((await settingsOf(t, userB)).nextDigestAt).toBe(FIRST_SLOT + DAY);
  });

  test("a failed send rolls back the digest, stamps, queued sends, and slot", async () => {
    const { t, userA, asA, sessionA } = await dueSetup();
    // A device row without a component token makes the component's send
    // throw after install-1 and install-2 were queued.
    await t.run((ctx) =>
      ctx.db.insert("devices", {
        userId: userA,
        deviceId: "install-9",
        name: "No token",
        platform: "android",
      }),
    );
    await insertDecision(t, userA, sessionA);
    const event = await insertEvent(t, userA, "agent.done");

    await expect(runWorker(t, userA)).rejects.toMatchObject({ data: { code: "NoPushToken" } });

    expect(await digestsOf(t, userA)).toEqual([]);
    expect((await eventOf(t, event))?.digestId).toBeUndefined();
    expect(await queued(t, "install-1")).toHaveLength(0);
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(FIRST_SLOT);

    // The slot stays due, so a later run sends the digest.
    await register(asA, "install-9", "ExponentPushToken[9]");
    expect(await dispatchDue(t)).toBe(1);
    const digestId = await runWorker(t, userA);
    expect((await eventOf(t, event))?.digestId).toBe(digestId);
    for (const deviceId of ["install-1", "install-2", "install-9"]) {
      expect(await queued(t, deviceId)).toHaveLength(1);
    }
  });

  // REQ-6: the next slot is the local digest time across daylight-saving
  // changes in New York (2026-11-01 fall back, 2027-03-14 spring forward).
  test("schedules the next local digest time across daylight-saving changes", async () => {
    const { t, userA, asA, sessionA } = await dueSetup();
    await insertDecision(t, userA, sessionA);

    // 08:00 EDT on 2026-10-31; the next 09:00 is 13:00Z that day.
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 0));
    await asA.mutation(notifications.settings.updateSettings, { timeZone: "America/New_York" });
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(Date.UTC(2026, 9, 31, 13, 0));

    vi.setSystemTime(Date.UTC(2026, 9, 31, 13, 1));
    expect(await runWorker(t, userA)).not.toBeNull();
    // 09:00 EST on 2026-11-01.
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(Date.UTC(2026, 10, 1, 14, 0));

    // 08:00 EST on 2027-03-13; the next 09:00 is 14:00Z that day.
    vi.setSystemTime(Date.UTC(2027, 2, 13, 13, 0));
    expect(await runWorker(t, userA)).not.toBeNull();
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(Date.UTC(2027, 2, 13, 14, 0));
    vi.setSystemTime(Date.UTC(2027, 2, 13, 14, 1));
    expect(await runWorker(t, userA)).not.toBeNull();
    // 09:00 EDT on 2027-03-14.
    expect((await settingsOf(t, userA)).nextDigestAt).toBe(Date.UTC(2027, 2, 14, 13, 0));
  });
});

describe("dispatchDue", () => {
  test(`schedules at most ${DISPATCH_BATCH} due rows, earliest first, and later runs take the rest`, async () => {
    const { t } = await setup();
    const extra = 5;
    const total = DISPATCH_BATCH + extra;
    const userIds = await t.run(async (ctx) => {
      const ids: Id<"users">[] = [];
      for (let i = 0; i < total; i += 1) {
        const userId = await ctx.db.insert("users", {
          clerkUserId: `user_${i}`,
          email: `${i}@example.com`,
        });
        await ensureSettings(ctx, userId, START);
        ids.push(userId);
      }
      return ids;
    });
    // Distinct slots in reverse insertion order, so the earliest-first order
    // differs from insertion order.
    const slots = new Map<Id<"settings">, number>();
    await t.run(async (ctx) => {
      for (const [i, userId] of userIds.entries()) {
        const row = await ensureSettings(ctx, userId, START);
        const slot = FIRST_SLOT + (total - i) * 1000;
        await ctx.db.patch("settings", row._id, { nextDigestAt: slot });
        slots.set(row._id, slot);
      }
      // One row not yet due.
      const later = await ctx.db.insert("users", { clerkUserId: "user_late", email: "l@x.com" });
      await ensureSettings(ctx, later, FIRST_SLOT + DAY);
    });
    vi.setSystemTime(FIRST_SLOT + HOUR);

    expect(await dispatchDue(t)).toBe(DISPATCH_BATCH);
    const first = await scheduledWorkers(t);
    expect(first).toHaveLength(DISPATCH_BATCH);
    const ordered = [...slots.entries()].sort((a, b) => a[1] - b[1]);
    expect(first).toEqual(
      ordered
        .slice(0, DISPATCH_BATCH)
        .map(([settingsId, expectedNextDigestAt]) => ({ settingsId, expectedNextDigestAt })),
    );
    for (const args of first) {
      expect(await t.mutation(notifications.digest.dispatchUser, args)).toBeNull();
    }

    expect(await dispatchDue(t)).toBe(extra);
    const second = (await scheduledWorkers(t)).slice(DISPATCH_BATCH);
    expect(second).toEqual(
      ordered
        .slice(DISPATCH_BATCH)
        .map(([settingsId, expectedNextDigestAt]) => ({ settingsId, expectedNextDigestAt })),
    );
    for (const args of second) {
      await t.mutation(notifications.digest.dispatchUser, args);
    }
    expect(await dispatchDue(t)).toBe(0);
  });
});

describe("digests:get", () => {
  async function sentDigest() {
    const s = await dueSetup();
    const { t, userA, sessionA } = s;
    const normal = await insertDecision(t, userA, sessionA, { title: "Normal" });
    const urgent = await insertDecision(t, userA, sessionA, {
      title: "Urgent",
      priority: "urgent",
    });
    const gone = await insertDecision(t, userA, sessionA, { title: "Gone" });
    const ended = await openSession(t, userA);
    const later = await insertEvent(t, userA, "agent.done", {
      agentSessionId: sessionA,
      occurredAt: START + HOUR,
    });
    const expired = await insertEvent(t, userA, "decision.expired", {
      decisionId: gone,
      agentSessionId: sessionA,
      occurredAt: START,
    });
    const stale = await insertEvent(t, userA, "agent.done", {
      agentSessionId: ended,
      occurredAt: START + 2 * HOUR,
      topic: undefined,
    });
    const digestId = await runWorker(t, userA);
    if (digestId === null) {
      throw new Error("No digest sent");
    }
    return { ...s, normal, urgent, gone, ended, later, expired, stale, digestId };
  }

  // req-notification-rules AC-6.3; component-decisions §Removal
  test("returns the saved events and the saved decisions in their current state", async () => {
    const s = await sentDigest();
    const { t, asA } = s;
    // After sending: one decision is answered, one is answered and removed,
    // and one agent session is deleted.
    vi.setSystemTime(FIRST_SLOT + 2 * MINUTE);
    await asA.mutation(decisions.app.answer, {
      decisionId: s.normal,
      answer: { kind: "approve" },
    });
    await asA.mutation(decisions.app.answer, { decisionId: s.gone, answer: { kind: "reject" } });
    await asA.mutation(decisions.app.remove, { decisionId: s.gone });
    await t.run((ctx) => ctx.db.delete("agentSessions", s.ended));

    const digest = await asA.query(notifications.digests.get, { digestId: s.digestId });

    expect(digest.id).toBe(s.digestId);
    expect(digest.sent_at).toBe(new Date(FIRST_SLOT + MINUTE).toISOString());
    expect(digest.events).toEqual([
      {
        id: s.expired,
        kind: "decision.expired",
        topic: "repo/x",
        occurred_at: new Date(START).toISOString(),
        action: "digest",
        decision_id: s.gone,
        agent_session_id: s.sessionA,
        decision_title: null,
        agent_name: "Builder",
      },
      {
        id: s.later,
        kind: "agent.done",
        topic: "repo/x",
        occurred_at: new Date(START + HOUR).toISOString(),
        action: "digest",
        decision_id: null,
        agent_session_id: s.sessionA,
        decision_title: null,
        agent_name: "Builder",
      },
      {
        id: s.stale,
        kind: "agent.done",
        topic: null,
        occurred_at: new Date(START + 2 * HOUR).toISOString(),
        action: "digest",
        decision_id: null,
        agent_session_id: s.ended,
        decision_title: null,
        agent_name: "Ended agent",
      },
    ]);
    expect(digest.pending_decisions.map((decision) => decision.id)).toEqual([s.urgent, s.normal]);
    expect(digest.pending_decisions[0]).toMatchObject({
      title: "Urgent",
      priority: "urgent",
      state: "pending",
      answer: null,
      answered_at: null,
      agent_name: "Builder",
    });
    expect(digest.pending_decisions[1]).toMatchObject({
      title: "Normal",
      state: "answered",
      answer: { kind: "approve" },
      answered_at: new Date(FIRST_SLOT + 2 * MINUTE).toISOString(),
      applied_by_default: false,
    });
  });

  // req-decision-requests AC-8.3
  test("shows how each saved decision was answered, with the chat message only for chat", async () => {
    const { t, asA, userA, sessionA } = await dueSetup();
    const inChat = await insertDecision(t, userA, sessionA, { title: "In chat" });
    const inApp = await insertDecision(t, userA, sessionA, { title: "In app" });
    const open = await insertDecision(t, userA, sessionA, { title: "Open" });
    const digestId = await runWorker(t, userA);
    if (digestId === null) {
      throw new Error("No digest sent");
    }

    await t.mutation(decisions.operations.resolve, {
      userId: userA,
      agentSessionId: sessionA,
      decisionId: inChat,
      answer: { kind: "approve" },
      chatMessage: "yes, ship it",
    });
    await asA.mutation(decisions.app.answer, {
      decisionId: inApp,
      answer: { kind: "reject" },
      note: "Not today",
    });

    const digest = await asA.query(notifications.digests.get, { digestId });
    const byId = new Map(digest.pending_decisions.map((decision) => [decision.id, decision]));
    expect(byId.get(inChat)).toMatchObject({
      state: "answered",
      answer: { kind: "approve" },
      answered_via: "chat",
      chat_message: "yes, ship it",
    });
    expect(byId.get(inApp)).toMatchObject({
      state: "answered",
      answer: { kind: "reject" },
      answered_via: "app",
      chat_message: null,
    });
    expect(byId.get(open)).toMatchObject({
      state: "pending",
      answered_via: null,
      chat_message: null,
    });
  });

  test("shows the title of a decision that still exists", async () => {
    const { t, asA, userA, sessionA } = await dueSetup();
    const decision = await insertDecision(t, userA, sessionA, { title: "Deploy?" });
    const event = await insertEvent(t, userA, "decision.expired", { decisionId: decision });
    const digestId = await runWorker(t, userA);
    if (digestId === null) {
      throw new Error("No digest sent");
    }
    const digest = await asA.query(notifications.digests.get, { digestId });
    expect(digest.events).toEqual([
      expect.objectContaining({ id: event, decision_id: decision, decision_title: "Deploy?" }),
    ]);
  });

  test("conceals another person's digest and a missing one as not_found", async () => {
    const s = await sentDigest();
    await expect(
      s.asB.query(notifications.digests.get, { digestId: s.digestId }),
    ).rejects.toMatchObject(notFound);

    await s.t.run((ctx) => ctx.db.delete("digests", s.digestId));
    await expect(
      s.asA.query(notifications.digests.get, { digestId: s.digestId }),
    ).rejects.toMatchObject(notFound);
  });

  test("refuses a malformed id as invalid naming digestId", async () => {
    const s = await sentDigest();
    await expect(
      s.asA.query(notifications.digests.get, { digestId: "not-an-id" }),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "digestId" } });
    // An id of another table is malformed for digests.
    await expect(
      s.asA.query(notifications.digests.get, { digestId: s.normal }),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "digestId" } });
  });

  test("is unauthenticated before any id check", async () => {
    const s = await sentDigest();
    for (const digestId of [s.digestId, "not-an-id"]) {
      await expect(s.t.query(notifications.digests.get, { digestId })).rejects.toMatchObject(
        unauthenticated,
      );
      await expect(
        s.t
          .withIdentity({ subject: "user_unknown" })
          .query(notifications.digests.get, { digestId }),
      ).rejects.toMatchObject(unauthenticated);
    }
  });
});
