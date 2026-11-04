import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { REFUSAL_WINDOW_MS, STALL_MS } from "./accountDeletion";
import { RETRY_BASE_MS, RETRY_MAX_MS } from "./clerkDeletion";
import { POSTHOG_DEFAULT_API_HOST } from "./posthogDeletion";
import { identity } from "./refs";

// component-identity §PostHog person deletion (req-accounts-and-connections
// AC-5.2): the request PostHog receives, the outcomes that complete or retry
// the step, retention, and recovery. `fetch` is a fake, so no test contacts
// PostHog.

const START = Date.UTC(2026, 9, 13, 12, 0, 0);
const API_KEY = "phx_test_personal_key";
const PROJECT = "4242";
const BODY_MARKER = "provider-text-that-must-stay-out";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("POSTHOG_PROJECT_ID", PROJECT);
  vi.stubEnv("POSTHOG_PERSONAL_API_KEY", API_KEY);
  vi.stubEnv("POSTHOG_API_HOST", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Options = {
  purgedAt?: number;
  clerkDoneAt?: number;
  posthog?: "pending" | "done" | "absent";
  posthogAttempt?: number;
};

// A deletion record for user_a whose first PostHog attempt is due now.
async function setup({
  purgedAt,
  clerkDoneAt,
  posthog = "pending",
  posthogAttempt = 1,
}: Options = {}) {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_a",
      email: "a@example.com",
      deletingAt: START,
    });
    if (purgedAt !== undefined) {
      await ctx.db.delete("users", userId);
    }
    return await ctx.db.insert("accountDeletions", {
      userId,
      clerkUserId: "user_a",
      startedAt: START,
      phase: purgedAt === undefined ? "decisions" : "verify",
      generation: 1,
      updatedAt: START,
      restarts: 0,
      ...(purgedAt === undefined ? {} : { purgedAt }),
      clerk:
        clerkDoneAt === undefined
          ? { state: "pending", attempt: 1, nextAttemptAt: START + 30 * 60_000 }
          : { state: "done", attempt: 1, nextAttemptAt: START, doneAt: clerkDoneAt },
      ...(posthog === "absent"
        ? {}
        : {
            posthog:
              posthog === "pending"
                ? { state: "pending" as const, attempt: posthogAttempt, nextAttemptAt: START }
                : {
                    state: "done" as const,
                    attempt: posthogAttempt,
                    nextAttemptAt: START,
                    doneAt: START,
                  },
          }),
    });
  });
  const attempt = (n: number) =>
    t.action(identity.posthogDeletion.deletePostHogPerson, { deletionId, attempt: n });
  const record = () => t.run((ctx) => ctx.db.get("accountDeletions", deletionId));
  const pendingAttempts = async () =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (job) =>
        job.name.startsWith("identity/posthogDeletion:deletePostHogPerson") &&
        job.state.kind === "pending",
    );
  return { t, deletionId, attempt, record, pendingAttempts };
}

function respond(status: number, body: string | null, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(new Response(body, { status, headers }));
}

function logged() {
  return [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

describe("the request", () => {
  test("posts the Clerk user ID to the default host's bulk delete route with the personal key", async () => {
    const { attempt } = await setup();
    respond(200, JSON.stringify({ persons_found: 1, deletion_errors: [] }));

    await attempt(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${POSTHOG_DEFAULT_API_HOST}/api/projects/${PROJECT}/persons/bulk_delete/`);
    expect(POSTHOG_DEFAULT_API_HOST).toBe("https://us.posthog.com");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    });
    // The Clerk subject is the distinct ID, and the body carries no email.
    expect(JSON.parse(String(init?.body))).toEqual({
      distinct_ids: ["user_a"],
      delete_events: true,
    });
    expect(String(init?.body)).not.toContain("example.com");
  });

  test("uses a configured host", async () => {
    const { attempt } = await setup();
    vi.stubEnv("POSTHOG_API_HOST", "https://eu.posthog.com/");
    respond(200, "{}");

    await attempt(1);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://eu.posthog.com/api/projects/${PROJECT}/persons/bulk_delete/`,
    );
  });
});

describe("completion", () => {
  test.each([
    ["an empty deletion_errors", JSON.stringify({ persons_found: 1, deletion_errors: [] })],
    ["no deletion_errors field", JSON.stringify({ persons_found: 1 })],
    ["a null deletion_errors", JSON.stringify({ deletion_errors: null })],
    ["0 persons found", JSON.stringify({ persons_found: 0, deletion_errors: [] })],
    ["an empty body", ""],
    ["a blank body", " \n"],
  ])("a 200 with %s completes the step", async (_name, body) => {
    const { attempt, record, pendingAttempts } = await setup();
    respond(200, body);

    await attempt(1);

    expect(await record()).toMatchObject({
      posthog: { state: "done", attempt: 1, doneAt: START },
    });
    expect((await record())?.posthog?.lastError).toBeUndefined();
    expect(await pendingAttempts()).toHaveLength(0);
  });

  test("a 204 with no body completes the step", async () => {
    const { attempt, record } = await setup();
    respond(204, null);

    await attempt(1);

    expect(await record()).toMatchObject({ posthog: { state: "done" } });
  });
});

describe("retries", () => {
  test.each([
    [
      "a non-empty deletion_errors",
      200,
      JSON.stringify({ deletion_errors: [BODY_MARKER] }),
      "deletion_errors",
    ],
    ["a 2xx body that cannot be parsed", 200, `<html>${BODY_MARKER}</html>`, "unreadable_response"],
    ["a 401", 401, BODY_MARKER, "http_401"],
    ["a 404, which is not a completion case", 404, BODY_MARKER, "http_404"],
    ["a 503", 503, BODY_MARKER, "http_503"],
  ])(
    "%s records a short code and schedules the next attempt",
    async (_name, status, body, code) => {
      const { deletionId, attempt, record, pendingAttempts } = await setup();
      respond(status, body);

      await attempt(1);

      expect(await record()).toMatchObject({
        posthog: {
          state: "pending",
          attempt: 2,
          nextAttemptAt: START + RETRY_BASE_MS,
          lastError: code,
        },
      });
      const jobs = await pendingAttempts();
      expect(jobs.map((job) => job.args[0])).toEqual([{ deletionId, attempt: 2 }]);
      expect(jobs[0]?.scheduledTime).toBe(START + RETRY_BASE_MS);
      // Neither the stored record nor the log holds the body, the key, or the
      // Clerk user ID; the log names the code.
      const stored = JSON.stringify((await record())?.posthog);
      expect(stored).not.toContain(BODY_MARKER);
      expect(stored).not.toContain(API_KEY);
      expect(logged()).toContain(code);
      expect(logged()).not.toContain(BODY_MARKER);
      expect(logged()).not.toContain(API_KEY);
      expect(logged()).not.toContain("user_a");
    },
  );

  test("a 2xx body whose read fails retries", async () => {
    const { attempt, record } = await setup();
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error(BODY_MARKER));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(broken, { status: 200 }));

    await attempt(1);

    expect(await record()).toMatchObject({
      posthog: { state: "pending", attempt: 2, lastError: "unreadable_response" },
    });
    expect(logged()).not.toContain(BODY_MARKER);
  });

  test("a network failure retries", async () => {
    const { attempt, record } = await setup();
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${BODY_MARKER}`));

    await attempt(1);

    expect(await record()).toMatchObject({
      posthog: { state: "pending", attempt: 2, lastError: "network" },
    });
    expect(logged()).not.toContain(BODY_MARKER);
  });

  test("the delay doubles, and a later success clears the error", async () => {
    const { attempt, record } = await setup();
    respond(503, "");
    await attempt(1);
    expect(await record()).toMatchObject({ posthog: { nextAttemptAt: START + RETRY_BASE_MS } });

    respond(502, "");
    await attempt(2);
    expect(await record()).toMatchObject({
      posthog: { attempt: 3, nextAttemptAt: START + 2 * RETRY_BASE_MS, lastError: "http_502" },
    });

    respond(200, "{}");
    await attempt(3);
    const done = (await record())?.posthog;
    expect(done).toMatchObject({ state: "done", attempt: 3 });
    expect(done?.lastError).toBeUndefined();
  });

  test("the delay stops growing at one hour", async () => {
    const { attempt, record } = await setup({ posthogAttempt: 12 });
    respond(500, "");

    await attempt(12);

    expect(await record()).toMatchObject({
      posthog: { attempt: 13, nextAttemptAt: START + RETRY_MAX_MS },
    });
  });

  test("a 429 waits as long as Retry-After asks, in seconds", async () => {
    const { attempt, record, pendingAttempts } = await setup();
    respond(429, "", { "Retry-After": "300" });

    await attempt(1);

    expect(await record()).toMatchObject({
      posthog: { attempt: 2, nextAttemptAt: START + 300_000, lastError: "http_429" },
    });
    expect((await pendingAttempts())[0]?.scheduledTime).toBe(START + 300_000);
  });

  test("a 429 waits as long as Retry-After asks, as an HTTP date", async () => {
    const { attempt, record } = await setup();
    respond(429, "", { "Retry-After": new Date(START + 600_000).toUTCString() });

    await attempt(1);

    expect(await record()).toMatchObject({ posthog: { nextAttemptAt: START + 600_000 } });
  });

  test("a Retry-After shorter than the backoff keeps the backoff", async () => {
    const { attempt, record } = await setup({ posthogAttempt: 4 });
    respond(429, "", { "Retry-After": "1" });

    await attempt(4);

    expect(await record()).toMatchObject({ posthog: { nextAttemptAt: START + 8 * RETRY_BASE_MS } });
  });

  test("a Retry-After longer than the one-hour cap is followed", async () => {
    const { attempt, record } = await setup({ posthogAttempt: 12 });
    respond(429, "", { "Retry-After": "7200" });

    await attempt(12);

    expect(await record()).toMatchObject({ posthog: { nextAttemptAt: START + 7_200_000 } });
  });
});

describe("posthog_not_configured", () => {
  test.each([
    ["project ID", "POSTHOG_PROJECT_ID"],
    ["personal API key", "POSTHOG_PERSONAL_API_KEY"],
  ])("a missing %s completes the step with no request", async (_name, variable) => {
    const { deletionId, attempt, record, pendingAttempts } = await setup();
    vi.stubEnv(variable, "");

    await attempt(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ posthog: { state: "done", doneAt: START } });
    expect(await pendingAttempts()).toHaveLength(0);
    expect(logged()).toBe(`posthog_not_configured for account deletion ${deletionId}`);
  });
});

describe("attempts that send nothing", () => {
  test("a record with no PostHog step sends no request and gains no state", async () => {
    const { attempt, record, pendingAttempts } = await setup({ posthog: "absent" });

    await attempt(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await record())?.posthog).toBeUndefined();
    expect(await pendingAttempts()).toHaveLength(0);
  });

  test("a completed step sends no request", async () => {
    const { attempt } = await setup({ posthog: "done" });

    await attempt(1);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a deleted record sends no request", async () => {
    const { t, deletionId, attempt } = await setup();
    await t.run((ctx) => ctx.db.delete("accountDeletions", deletionId));

    await attempt(1);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an attempt that is not the current one sends no request and changes nothing", async () => {
    const { attempt, record, pendingAttempts } = await setup();
    respond(503, "");
    await attempt(1);
    const after = await record();

    await attempt(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await record()).toEqual(after);
    expect(await pendingAttempts()).toHaveLength(1);
  });
});

describe("recordPostHogOutcome", () => {
  const deleted = { kind: "deleted" as const };
  const failed = { kind: "failed" as const, error: "http_503" };

  test.each([
    ["a stale failure", 1, failed],
    ["a stale completion", 1, deleted],
  ])("%s writes nothing and schedules nothing", async (_name, stale, outcome) => {
    const { t, deletionId, record, pendingAttempts } = await setup({ posthogAttempt: 3 });
    const before = await record();

    await t.mutation(identity.posthogDeletion.recordPostHogOutcome, {
      deletionId,
      attempt: stale,
      outcome,
    });

    expect(await record()).toEqual(before);
    expect(await pendingAttempts()).toHaveLength(0);
  });

  test("a duplicate outcome for a completed step writes nothing and schedules nothing", async () => {
    const { t, deletionId, record, pendingAttempts } = await setup();
    await t.mutation(identity.posthogDeletion.recordPostHogOutcome, {
      deletionId,
      attempt: 1,
      outcome: deleted,
    });
    const before = await record();
    vi.setSystemTime(START + 60_000);

    await t.mutation(identity.posthogDeletion.recordPostHogOutcome, {
      deletionId,
      attempt: 1,
      outcome: failed,
    });

    expect(await record()).toEqual(before);
    expect(await pendingAttempts()).toHaveLength(0);
  });

  test("an outcome for a record with no PostHog step writes nothing", async () => {
    const { t, deletionId, record } = await setup({ posthog: "absent" });
    const before = await record();

    await t.mutation(identity.posthogDeletion.recordPostHogOutcome, {
      deletionId,
      attempt: 1,
      outcome: deleted,
    });

    expect(await record()).toEqual(before);
  });
});

describe("retention", () => {
  test("the refusal window waits for the step and starts at its completion", async () => {
    const { attempt, record } = await setup({
      purgedAt: START - 10 * 60_000,
      clerkDoneAt: START - 5 * 60_000,
    });
    expect((await record())?.refuseUntil).toBeUndefined();
    respond(200, "{}");

    await attempt(1);

    expect(await record()).toMatchObject({ refuseUntil: START + REFUSAL_WINDOW_MS });
  });

  test("a failed attempt starts no refusal window", async () => {
    const { attempt, record } = await setup({ purgedAt: START, clerkDoneAt: START });
    respond(503, "");

    await attempt(1);

    expect((await record())?.refuseUntil).toBeUndefined();
  });

  test("the step finishing first leaves the window to the purge and the Clerk deletion", async () => {
    const { t, deletionId, attempt, record } = await setup({ purgedAt: START });
    respond(200, "{}");
    await attempt(1);
    expect((await record())?.refuseUntil).toBeUndefined();

    const clerkAt = START + 10 * 60_000;
    vi.setSystemTime(clerkAt);
    await t.mutation(identity.clerkDeletion.recordClerkOutcome, {
      deletionId,
      attempt: 1,
      outcome: { kind: "deleted" },
    });

    expect(await record()).toMatchObject({ refuseUntil: clerkAt + REFUSAL_WINDOW_MS });
  });

  test("a purge finishing last starts the window at the purge's end", async () => {
    const { t, deletionId, attempt, record } = await setup({ clerkDoneAt: START });
    respond(200, "{}");
    await attempt(1);
    expect((await record())?.refuseUntil).toBeUndefined();

    const purgeAt = START + 20 * 60_000;
    vi.setSystemTime(purgeAt);
    for (let generation = 1; (await record())?.purgedAt === undefined; generation++) {
      await t.mutation(identity.accountDeletion.purgeBatch, { deletionId, generation });
    }

    expect(await record()).toMatchObject({
      purgedAt: purgeAt,
      refuseUntil: purgeAt + REFUSAL_WINDOW_MS,
    });
  });

  test("a record without `posthog` counts the step as done", async () => {
    const { t, deletionId, record } = await setup({ purgedAt: START, posthog: "absent" });

    await t.mutation(identity.clerkDeletion.recordClerkOutcome, {
      deletionId,
      attempt: 1,
      outcome: { kind: "deleted" },
    });

    expect(await record()).toMatchObject({ refuseUntil: START + REFUSAL_WINDOW_MS });
  });
});

describe("recovery", () => {
  test("restarts an overdue attempt once under a new attempt number", async () => {
    const { t, deletionId, record, pendingAttempts } = await setup({
      purgedAt: START,
      clerkDoneAt: START,
    });
    // The scheduled attempt never ran: its time passed long ago.
    const now = START + STALL_MS + 60_000;
    vi.setSystemTime(now);

    expect(await t.mutation(identity.accountDeletion.resumePurges, {})).toBe(1);

    expect(await record()).toMatchObject({
      posthog: { state: "pending", attempt: 2, nextAttemptAt: now },
    });
    const jobs = await pendingAttempts();
    expect(jobs.map((job) => job.args[0])).toEqual([{ deletionId, attempt: 2 }]);

    // A second run right after finds the deletion progressing and leaves it.
    expect(await t.mutation(identity.accountDeletion.resumePurges, {})).toBe(0);
    expect(await pendingAttempts()).toHaveLength(1);
  });

  test("the superseded attempt then sends nothing, and the new one finishes the step", async () => {
    const { t, attempt, record } = await setup({ purgedAt: START, clerkDoneAt: START });
    vi.setSystemTime(START + STALL_MS + 60_000);
    await t.mutation(identity.accountDeletion.resumePurges, {});

    await attempt(1);
    expect(fetchMock).not.toHaveBeenCalled();

    respond(200, "{}");
    await attempt(2);
    expect(await record()).toMatchObject({ posthog: { state: "done", attempt: 2 } });
  });

  test("leaves an attempt that is not yet overdue alone", async () => {
    const { t, deletionId, record, pendingAttempts } = await setup({
      purgedAt: START,
      clerkDoneAt: START,
    });
    const now = START + STALL_MS + 60_000;
    await t.run((ctx) =>
      ctx.db.patch("accountDeletions", deletionId, {
        posthog: { state: "pending", attempt: 3, nextAttemptAt: now - STALL_MS + 1 },
      }),
    );
    vi.setSystemTime(now);

    await t.mutation(identity.accountDeletion.resumePurges, {});

    expect(await record()).toMatchObject({ posthog: { attempt: 3 } });
    expect(await pendingAttempts()).toHaveLength(0);
  });

  test("leaves a completed step and a record without the step alone", async () => {
    const done = await setup({ purgedAt: START, posthog: "done" });
    const legacy = await setup({ purgedAt: START, posthog: "absent" });
    vi.setSystemTime(START + STALL_MS + 60_000);

    await done.t.mutation(identity.accountDeletion.resumePurges, {});
    await legacy.t.mutation(identity.accountDeletion.resumePurges, {});

    expect(await done.record()).toMatchObject({ posthog: { state: "done", attempt: 1 } });
    expect(await done.pendingAttempts()).toHaveLength(0);
    expect((await legacy.record())?.posthog).toBeUndefined();
    expect(await legacy.pendingAttempts()).toHaveLength(0);
  });

  test("restarts an overdue purge and an overdue Clerk attempt beside the PostHog step", async () => {
    const { t, record, pendingAttempts } = await setup();
    const now = START + 60 * 60_000;
    vi.setSystemTime(now);

    await t.mutation(identity.accountDeletion.resumePurges, {});

    expect(await record()).toMatchObject({
      generation: 2,
      restarts: 1,
      updatedAt: now,
      clerk: { attempt: 2 },
      posthog: { attempt: 2, nextAttemptAt: now },
    });
    expect(await pendingAttempts()).toHaveLength(1);
  });
});
