import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertApiToken, insertConnectionToken } from "./credentials";
import { BACKFILL_PAGE_SIZE, POSTHOG_DEFAULT_INGEST_HOST } from "./posthogPerson";
import { identity } from "./refs";
import { hashToken } from "./tokens";

// component-identity §PostHog Mac property (req-accounts-and-connections
// REQ-7): what triggers a send, what the request holds, and when nothing is
// sent. `fetch` is a fake, so no test contacts PostHog.

const START = Date.UTC(2026, 10, 4, 12, 0, 0);
const PROJECT_TOKEN = "phc_test_project_token";
const asUserA = { subject: "user_a", email: "a@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found" } };

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", PROJECT_TOKEN);
  vi.stubEnv("POSTHOG_INGEST_HOST", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
  );
  return { t, userId, a: t.withIdentity(asUserA) };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

// An unrevoked Mac credential, as a Mac sign-in leaves it.
function insertMac(t: T, userId: Id<"users">, machineName = "Studio Mac") {
  return t.run((ctx) =>
    insertApiToken(ctx, { userId, name: "AgentDesk for Mac", harness: "macos", machineName }),
  );
}

function drain(t: T) {
  return t.finishAllScheduledFunctions(vi.runAllTimers);
}

function queuedJobs(t: T) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.name.startsWith("identity/posthogPerson") && job.state.kind === "pending",
    ),
  );
}

function revokeSelf(t: T, plaintext: string) {
  return hashToken(plaintext).then((tokenHash) =>
    t.mutation(internal.identity.selfRevoke.revokeSelf, { tokenHash }),
  );
}

function sentBodies(): unknown[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

function sentValues(): boolean[] {
  return sentBodies().map(
    (body) =>
      (body as { properties: { $set: { has_mac_app: boolean } } }).properties.$set.has_mac_app,
  );
}

async function signInMac(t: T, a: ReturnType<T["withIdentity"]>) {
  const { code, deviceSecret } = await t.mutation(
    internal.identity.deviceRequests.startDeviceRequest,
    { machineName: "Studio Mac", client: "macos" },
  );
  await a.mutation(identity.deviceRequests.approveDeviceRequest, { code });
  return { deviceSecret };
}

function collect(t: T, deviceSecret: string) {
  return t.mutation(internal.identity.deviceRequests.collectDeviceRequest, { deviceSecret });
}

describe("Mac sign-in", () => {
  // AC-7.1
  test("collecting a Mac request schedules one user-only job and sends true", async () => {
    const { t, a, userId } = await setup();
    const { deviceSecret } = await signInMac(t, a);
    expect(await queuedJobs(t)).toEqual([]);

    const result = await collect(t, deviceSecret);

    expect(result.status).toBe("approved");
    const jobs = await queuedJobs(t);
    expect(jobs.map((job) => [job.name, job.args])).toEqual([
      ["identity/posthogPerson:syncMacApp", [{ userId }]],
    ]);

    await drain(t);

    expect(sentValues()).toEqual([true]);
  });

  test("a second collection sends nothing more", async () => {
    const { t, a } = await setup();
    const { deviceSecret } = await signInMac(t, a);
    const first = await collect(t, deviceSecret);
    expect(first.status).toBe("approved");

    expect(await collect(t, deviceSecret)).toEqual({ status: "not_found" });

    expect(await queuedJobs(t)).toHaveLength(1);
    await drain(t);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an installer's collection schedules nothing", async () => {
    const { t, a } = await setup();
    const { code, deviceSecret } = await t.mutation(
      internal.identity.deviceRequests.startDeviceRequest,
      { machineName: "laptop", harnesses: ["codex"] },
    );
    await a.mutation(identity.deviceRequests.approveDeviceRequest, { code });

    expect((await collect(t, deviceSecret)).status).toBe("approved");

    expect(await queuedJobs(t)).toEqual([]);
  });

  test("a pending or declined Mac request schedules nothing", async () => {
    const { t, a } = await setup();
    const { code, deviceSecret } = await t.mutation(
      internal.identity.deviceRequests.startDeviceRequest,
      { machineName: "Studio Mac", client: "macos" },
    );

    expect(await collect(t, deviceSecret)).toEqual({ status: "pending" });
    await a.mutation(identity.deviceRequests.declineDeviceRequest, { code });
    expect(await collect(t, deviceSecret)).toEqual({ status: "declined" });

    expect(await queuedJobs(t)).toEqual([]);
  });

  test("a collection refused for a deleting account schedules nothing", async () => {
    const { t, a, userId } = await setup();
    const { deviceSecret } = await signInMac(t, a);
    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));

    await expect(collect(t, deviceSecret)).rejects.toMatchObject(unauthenticated);

    expect(await queuedJobs(t)).toEqual([]);
  });
});

describe("Mac revocation", () => {
  // AC-7.1
  test("revokeConnection of the last Mac sends false", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(sentValues()).toEqual([false]);
  });

  test("revoke-self of the last Mac sends false", async () => {
    const { t, userId } = await setup();
    const { plaintext } = await insertMac(t, userId);

    await revokeSelf(t, plaintext);
    await drain(t);

    expect(sentValues()).toEqual([false]);
  });

  test("revokeConnection sends true while another Mac remains", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId, "Studio Mac");
    await insertMac(t, userId, "MacBook");

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(sentValues()).toEqual([true]);
  });

  test("revoke-self sends true while another Mac remains", async () => {
    const { t, userId } = await setup();
    const { plaintext } = await insertMac(t, userId, "Studio Mac");
    await insertMac(t, userId, "MacBook");

    await revokeSelf(t, plaintext);
    await drain(t);

    expect(sentValues()).toEqual([true]);
  });

  test("a repeated revokeConnection keeps the first time and sends again", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);
    vi.setSystemTime(START + 60_000);
    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    const stored = await t.run((ctx) => ctx.db.get("credentials", credentialId));
    expect(stored?.revokedAt).toBe(START);
    expect(sentValues()).toEqual([false, false]);
  });

  test("a refused revoke-self of a revoked Mac schedules nothing", async () => {
    const { t, a, userId } = await setup();
    const { credentialId, plaintext } = await insertMac(t, userId);
    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);
    fetchMock.mockClear();

    await expect(revokeSelf(t, plaintext)).rejects.toMatchObject(unauthenticated);

    expect(await queuedJobs(t)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a foreign or unknown credential schedules nothing", async () => {
    const { t, a } = await setup();
    const otherId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" }),
    );
    const { credentialId } = await insertMac(t, otherId);

    await expect(
      a.mutation(identity.connections.revokeConnection, { credentialId }),
    ).rejects.toMatchObject(notFound);

    expect(await queuedJobs(t)).toEqual([]);
  });
});

describe("other credential kinds", () => {
  test("revoking a connection token schedules nothing on either surface", async () => {
    const { t, a, userId } = await setup();
    await insertMac(t, userId);
    const viaApp = await t.run((ctx) =>
      insertConnectionToken(ctx, { userId, harness: "codex", name: "Codex" }),
    );
    const viaSelf = await t.run((ctx) =>
      insertConnectionToken(ctx, { userId, harness: "cursor", name: "Cursor" }),
    );

    await a.mutation(identity.connections.revokeConnection, {
      credentialId: viaApp.credentialId,
    });
    await revokeSelf(t, viaSelf.plaintext);

    expect(await queuedJobs(t)).toEqual([]);
  });

  test("revoking an OAuth connection schedules nothing", async () => {
    const { t, a, userId } = await setup();
    const credentialId = await t.run((ctx) =>
      ctx.db.insert("credentials", {
        userId,
        kind: "connection_oauth",
        tokenHash: "b".repeat(64),
        oauthClientId: "client_1",
      }),
    );

    await a.mutation(identity.connections.revokeConnection, { credentialId });

    expect(await queuedJobs(t)).toEqual([]);
  });

  test("API tokens that are not Mac credentials are refused and schedule nothing", async () => {
    const { t, a, userId } = await setup();
    const plain = await t.run((ctx) => insertApiToken(ctx, { userId, name: "CI token" }));
    const otherHarness = await t.run((ctx) =>
      insertApiToken(ctx, { userId, name: "Script", harness: "codex" }),
    );

    for (const { credentialId, plaintext } of [plain, otherHarness]) {
      await expect(
        a.mutation(identity.connections.revokeConnection, { credentialId }),
      ).rejects.toMatchObject(notFound);
      await expect(revokeSelf(t, plaintext)).rejects.toMatchObject(unauthenticated);
    }

    expect(await queuedJobs(t)).toEqual([]);
  });

  test("API tokens that are not Mac credentials do not count as a Mac", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);
    await t.run((ctx) => insertApiToken(ctx, { userId, name: "CI token" }));
    await t.run((ctx) => insertApiToken(ctx, { userId, name: "Script", harness: "codex" }));

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(sentValues()).toEqual([false]);
  });
});

describe("state read when the job runs", () => {
  test("a revocation before a queued sign-in job runs makes both send false", async () => {
    const { t, a } = await setup();
    const { deviceSecret } = await signInMac(t, a);
    const result = await collect(t, deviceSecret);
    if (result.status !== "approved" || !("api_token" in result)) {
      throw new Error("expected an approved Mac collection");
    }

    await a.mutation(identity.connections.revokeConnection, {
      credentialId: result.api_token.credential_id,
    });
    expect(await queuedJobs(t)).toHaveLength(2);
    await drain(t);

    expect(sentValues()).toEqual([false, false]);
  });

  test("a new Mac before a queued revocation job runs makes it send true", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await insertMac(t, userId, "MacBook");
    await drain(t);

    expect(sentValues()).toEqual([true]);
  });

  // AC-7.3
  test("a job queued before deletion starts sends nothing", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);
    await a.mutation(identity.connections.revokeConnection, { credentialId });

    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a job queued before the users row goes sends nothing", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);
    await a.mutation(identity.connections.revokeConnection, { credentialId });

    await t.run((ctx) => ctx.db.delete("users", userId));
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("account deletion revokes the Mac and schedules no property send", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.accountDeletion.deleteAccount, {});

    const stored = await t.run((ctx) => ctx.db.get("credentials", credentialId));
    expect(stored?.revokedAt).toBe(START);
    expect(await queuedJobs(t)).toEqual([]);
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
  ])("a project token that is %s sends nothing", async (_name, token) => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", token);
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  // AC-7.2
  test("posts the exact envelope to the default host", async () => {
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId, "Studio Mac");
    await insertMac(t, userId, "MacBook");

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${POSTHOG_DEFAULT_INGEST_HOST}/i/v0/e/`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      api_key: PROJECT_TOKEN,
      event: "$set",
      distinct_id: "user_a",
      properties: { $set: { has_mac_app: true } },
    });
  });

  // AC-7.2
  test("holds no email, machine name, connection name, or credential data", async () => {
    const { t, a, userId } = await setup();
    const { credentialId, plaintext } = await insertMac(t, userId, "Studio Mac");
    const tokenHash = await hashToken(plaintext);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    for (const secret of [
      "a@example.com",
      "Studio Mac",
      "AgentDesk for Mac",
      credentialId,
      plaintext,
      tokenHash,
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  test.each([
    "https://eu.i.posthog.com",
    "https://eu.i.posthog.com/",
    "https://eu.i.posthog.com///",
  ])("posts to the configured host %s", async (host) => {
    vi.stubEnv("POSTHOG_INGEST_HOST", host);
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://eu.i.posthog.com/i/v0/e/");
  });
});

describe("failures", () => {
  test.each([
    ["a server error", 503, "posthog_mac_app_failed http_503"],
    ["a refusal", 401, "posthog_mac_app_failed http_401"],
  ])("%s logs a short code and is not retried", async (_name, status, logged) => {
    fetchMock.mockImplementation(
      async () => new Response("provider-text-that-must-stay-out", { status }),
    );
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls).toEqual([[logged]]);
    expect(await queuedJobs(t)).toEqual([]);
    const stored = await t.run((ctx) => ctx.db.get("credentials", credentialId));
    expect(stored?.revokedAt).toBe(START);
  });

  test("a network failure logs a short code and is not retried", async () => {
    fetchMock.mockRejectedValue(new Error("provider-text-that-must-stay-out"));
    const { t, a } = await setup();
    const { deviceSecret } = await signInMac(t, a);

    expect((await collect(t, deviceSecret)).status).toBe("approved");
    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls).toEqual([["posthog_mac_app_failed network"]]);
    expect(await queuedJobs(t)).toEqual([]);
  });

  test("the next revocation sends the current value after a failure", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("", { status: 500 }));
    const { t, a, userId } = await setup();
    const { credentialId } = await insertMac(t, userId);

    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);
    await a.mutation(identity.connections.revokeConnection, { credentialId });
    await drain(t);

    expect(sentValues()).toEqual([false, false]);
  });
});

describe("backfillMacApp", () => {
  // Accounts across two pages: the first and last have a Mac, and the others
  // show each kind of account the backfill skips.
  async function populate(t: T) {
    const total = BACKFILL_PAGE_SIZE + 5;
    const ids: Id<"users">[] = [];
    for (let index = 0; index < total; index++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("users", {
            clerkUserId: `user_${index}`,
            email: `${index}@example.com`,
          }),
        ),
      );
    }
    const [first, revoked, deleting, plain, otherHarness] = ids as [
      Id<"users">,
      Id<"users">,
      Id<"users">,
      Id<"users">,
      Id<"users">,
    ];
    const last = ids[total - 1] as Id<"users">;
    await insertMac(t, first);
    await insertMac(t, last);
    const { credentialId } = await insertMac(t, revoked);
    await t.run((ctx) => ctx.db.patch("credentials", credentialId, { revokedAt: START }));
    await insertMac(t, deleting);
    await t.run((ctx) => ctx.db.patch("users", deleting, { deletingAt: START }));
    await t.run((ctx) => insertApiToken(ctx, { userId: plain, name: "CI token" }));
    await t.run((ctx) =>
      insertApiToken(ctx, { userId: otherHarness, name: "Script", harness: "codex" }),
    );
    return { first, last };
  }

  test("reads one bounded page in a step and schedules the next page", async () => {
    const t = convexTest(schema, modules);
    const { first } = await populate(t);

    await t.mutation(identity.posthogPerson.backfillMacApp, {});

    const jobs = await queuedJobs(t);
    expect(
      jobs.filter((job) => job.name === "identity/posthogPerson:syncMacApp").map((job) => job.args),
    ).toEqual([[{ userId: first }]]);
    const next = jobs.filter((job) => job.name === "identity/posthogPerson:backfillMacApp");
    expect(next).toHaveLength(1);
    expect(next[0]?.args[0]).toEqual({ cursor: expect.any(String) });
  });

  test("finishes the scan and sends true only for active accounts with a Mac", async () => {
    const t = convexTest(schema, modules);
    await populate(t);

    await t.mutation(identity.posthogPerson.backfillMacApp, {});
    await drain(t);

    const bodies = sentBodies() as { distinct_id: string }[];
    expect(bodies.map((body) => body.distinct_id).sort()).toEqual([
      "user_0",
      `user_${BACKFILL_PAGE_SIZE + 4}`,
    ]);
    expect(sentValues()).toEqual([true, true]);
    expect(await queuedJobs(t)).toEqual([]);
  });

  test("a deployment with no accounts ends at once", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(identity.posthogPerson.backfillMacApp, {});

    expect(await queuedJobs(t)).toEqual([]);
  });

  test("an account that starts deleting after a step sends nothing", async () => {
    const { t, userId } = await setup();
    await insertMac(t, userId);

    await t.mutation(identity.posthogPerson.backfillMacApp, {});
    expect(await queuedJobs(t)).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("without a project token the scan finishes and sends nothing", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", undefined);
    const { t, userId } = await setup();
    await insertMac(t, userId);

    await t.mutation(identity.posthogPerson.backfillMacApp, {});
    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
