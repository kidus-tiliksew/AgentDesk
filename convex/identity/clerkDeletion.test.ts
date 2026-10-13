import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { STALL_MS } from "./accountDeletion";
import { CLERK_API, RETRY_BASE_MS, RETRY_MAX_MS } from "./clerkDeletion";
import { identity } from "./refs";

// component-identity §Account deletion: the Clerk user's deletion through
// the Clerk Backend API. `fetch` is a fake, so no test contacts Clerk.

const START = Date.UTC(2026, 9, 13, 12, 0, 0);
const SECRET = "sk_test_secret";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CLERK_SECRET_KEY", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// A deletion record for user_a whose first Clerk attempt is due now.
// `purged` marks the purge as finished.
async function setup(purged = false) {
  const t = convexTest(schema, modules);
  const deletionId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_a",
      email: "a@example.com",
      deletingAt: START,
    });
    if (purged) {
      await ctx.db.delete("users", userId);
    }
    return await ctx.db.insert("accountDeletions", {
      userId,
      clerkUserId: "user_a",
      startedAt: START,
      phase: purged ? "verify" : "decisions",
      generation: 1,
      updatedAt: START,
      restarts: 0,
      ...(purged ? { purgedAt: START } : {}),
      clerk: { state: "pending", attempt: 1, nextAttemptAt: START },
    });
  });
  const attempt = (n: number) =>
    t.action(identity.clerkDeletion.deleteClerkUser, { deletionId, attempt: n });
  const record = () => t.run((ctx) => ctx.db.get("accountDeletions", deletionId));
  const pendingAttempts = async () =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (job) =>
        job.name.startsWith("identity/clerkDeletion:deleteClerkUser") &&
        job.state.kind === "pending",
    );
  return { t, deletionId, attempt, record, pendingAttempts };
}

function respond(status: number, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(new Response(status === 204 ? null : "{}", { status, headers }));
}

describe("deleteClerkUser", () => {
  test("deletes the Clerk user with the server secret and records the step done", async () => {
    const { attempt, record } = await setup();
    respond(200);

    await attempt(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${CLERK_API}/users/user_a`);
    expect(init).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(await record()).toMatchObject({ clerk: { state: "done", doneAt: START } });
  });

  test("a Clerk user that no longer exists completes the step", async () => {
    const { attempt, record } = await setup();
    respond(404);

    await attempt(1);

    expect(await record()).toMatchObject({ clerk: { state: "done" } });
  });

  test("deletes the record once the purge has also finished", async () => {
    const { attempt, record } = await setup(true);
    respond(200);

    await attempt(1);

    expect(await record()).toBeNull();
  });

  test("a server error retries with a doubling delay, then succeeds", async () => {
    const { attempt, record, pendingAttempts } = await setup();
    respond(503);
    await attempt(1);

    expect(await record()).toMatchObject({
      clerk: {
        state: "pending",
        attempt: 2,
        nextAttemptAt: START + RETRY_BASE_MS,
        lastError: "http_503",
      },
    });
    const [next] = await pendingAttempts();
    expect(next?.scheduledTime).toBe(START + RETRY_BASE_MS);

    respond(502);
    await attempt(2);
    expect(await record()).toMatchObject({
      clerk: { attempt: 3, nextAttemptAt: START + 2 * RETRY_BASE_MS, lastError: "http_502" },
    });

    respond(200);
    await attempt(3);
    expect(await record()).toMatchObject({ clerk: { state: "done" } });
    // The failure log names the code, never the secret or the Clerk user.
    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain("user_a");
  });

  test("the delay stops growing at one hour", async () => {
    const { t, deletionId, attempt, record } = await setup();
    await t.run((ctx) =>
      ctx.db.patch("accountDeletions", deletionId, {
        clerk: { state: "pending", attempt: 12, nextAttemptAt: START },
      }),
    );
    respond(500);

    await attempt(12);

    expect(await record()).toMatchObject({
      clerk: { attempt: 13, nextAttemptAt: START + RETRY_MAX_MS },
    });
  });

  test("a rate limit waits at least as long as Retry-After asks", async () => {
    const { attempt, record } = await setup();
    respond(429, { "Retry-After": "300" });

    await attempt(1);

    expect(await record()).toMatchObject({
      clerk: { attempt: 2, nextAttemptAt: START + 300_000, lastError: "http_429" },
    });
  });

  test("a network failure retries", async () => {
    const { attempt, record } = await setup();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await attempt(1);

    expect(await record()).toMatchObject({ clerk: { attempt: 2, lastError: "network" } });
  });

  test("a missing or refused secret stays pending and visible and retries", async () => {
    const { attempt, record } = await setup();
    vi.stubEnv("CLERK_SECRET_KEY", "");

    await attempt(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({
      clerk: { state: "pending", attempt: 2, lastError: "missing_secret" },
    });

    vi.stubEnv("CLERK_SECRET_KEY", SECRET);
    respond(401);
    await attempt(2);
    expect(await record()).toMatchObject({
      clerk: { state: "pending", attempt: 3, lastError: "http_401" },
    });
  });

  test("an attempt that is not the current one does nothing", async () => {
    const { attempt, record } = await setup();
    respond(503);
    await attempt(1);
    const after = await record();

    await attempt(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await record()).toEqual(after);
  });

  test("recovery starts a new attempt when the scheduled one is overdue", async () => {
    const { t, deletionId, record, pendingAttempts } = await setup(true);
    // The scheduled attempt never ran: its time passed long ago.
    vi.setSystemTime(START + STALL_MS + 60_000);

    expect(await t.mutation(identity.accountDeletion.resumePurges, {})).toBe(1);

    expect(await record()).toMatchObject({
      clerk: { state: "pending", attempt: 2, nextAttemptAt: START + STALL_MS + 60_000 },
    });
    const jobs = await pendingAttempts();
    expect(jobs.map((job) => job.args[0])).toEqual([{ deletionId, attempt: 2 }]);
  });
});
