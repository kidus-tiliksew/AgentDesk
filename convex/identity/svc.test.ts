import { errorBodySchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertConnectionToken, revokeCredential } from "./credentials";
import { identity } from "./refs";
import { hashToken } from "./tokens";

const SECRET = "test-service-secret";
const PATH = "/svc/identity/resolve-token";

// The modules map includes convex/http.ts, so t.fetch reaches the route
// through the real router.
async function setup() {
  const t = convexTest(schema, modules);
  const { userId, credentialId, plaintext } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    return {
      userId,
      ...(await insertConnectionToken(ctx, { userId, harness: "codex", name: "Codex" })),
    };
  });
  return { t, userId, credentialId, tokenHash: await hashToken(plaintext) };
}

function post(t: ReturnType<typeof convexTest>, body: unknown, authorization = `Bearer ${SECRET}`) {
  return t.fetch(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  return errorBodySchema.parse(await response.json()).error;
}

describe(PATH, () => {
  beforeEach(() => {
    vi.stubEnv("SERVICE_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns 200 with the resolve result", async () => {
    const { t, userId, credentialId, tokenHash } = await setup();

    const response = await post(t, { token_hash: tokenHash });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId,
      credentialId,
      kind: "connection_token",
      harness: "codex",
      name: "Codex",
    });
  });

  test("returns 401 for a wrong service secret without resolving", async () => {
    const { t, credentialId, tokenHash } = await setup();

    const response = await post(t, { token_hash: tokenHash }, `Bearer ${SECRET}x`);

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
    const credential = await t.run((ctx) => ctx.db.get("credentials", credentialId));
    expect(credential?.lastUsedAt).toBeUndefined();
  });

  test.each([
    ["non-hex characters", "z".repeat(64)],
    ["uppercase hex", "A".repeat(64)],
    ["a short hash", "a".repeat(63)],
    ["a long hash", "a".repeat(65)],
  ])("returns 400 naming token_hash for %s", async (_label, tokenHash) => {
    const { t } = await setup();

    const response = await post(t, { token_hash: tokenHash });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "token_hash" });
  });

  test("returns 401 for an unknown token", async () => {
    const { t } = await setup();

    const response = await post(t, { token_hash: await hashToken("adc_unknown") });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  // req-accounts-and-connections AC-4.2
  test("returns 401 for a revoked token", async () => {
    const { t, userId, credentialId, tokenHash } = await setup();
    await t.run((ctx) => revokeCredential(ctx, userId, credentialId));

    const response = await post(t, { token_hash: tokenHash });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });
});

function postTo(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: unknown,
  authorization = `Bearer ${SECRET}`,
) {
  return t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(body),
  });
}

function credentialRows(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("credentials").collect());
}

describe("short-code sign-in routes", () => {
  const START_PATH = "/svc/identity/device-start";
  const COLLECT_PATH = "/svc/identity/device-collect";
  const startBody = { machine_name: "devbox", harnesses: ["claude-code", "cursor"] };

  beforeEach(() => {
    vi.stubEnv("SERVICE_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function started(t: ReturnType<typeof convexTest>) {
    const response = await postTo(t, START_PATH, startBody);
    expect(response.status).toBe(200);
    return (await response.json()) as { code: string; device_secret: string; expires_at: number };
  }

  // req-accounts-and-connections AC-6.1
  test("device-start returns the code, the device secret, and the expiry", async () => {
    const { t } = await setup();
    const before = Date.now();

    const body = await started(t);

    expect(Object.keys(body).sort()).toEqual(["code", "device_secret", "expires_at"]);
    expect(body.code).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(body.device_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(body.expires_at).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  test.each([
    ["an empty list", { machine_name: "devbox", harnesses: [] }, "harnesses"],
    ["a duplicate", { machine_name: "devbox", harnesses: ["codex", "codex"] }, "harnesses"],
    ["an unknown harness", { machine_name: "devbox", harnesses: ["windsurf"] }, "harnesses"],
    ["a non-list", { machine_name: "devbox", harnesses: "codex" }, "harnesses"],
    ["a missing machine name", { harnesses: ["codex"] }, "machine_name"],
    ["a blank machine name", { machine_name: "  ", harnesses: ["codex"] }, "machine_name"],
  ])("device-start returns 400 for %s", async (_label, body, field) => {
    const { t } = await setup();

    const response = await postTo(t, START_PATH, body);

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field });
    expect(await t.run((ctx) => ctx.db.query("deviceRequests").collect())).toEqual([]);
  });

  test.each([
    [START_PATH, { machine_name: "devbox", harnesses: [] }],
    [COLLECT_PATH, { device_secret: "x" }],
    ["/svc/identity/revoke-self", { token_hash: "x" }],
  ])("%s checks the service secret before the body", async (path, body) => {
    const { t } = await setup();

    const response = await postTo(t, path, body, `Bearer ${SECRET}x`);

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  test("device-start with a wrong service secret stores nothing", async () => {
    const { t } = await setup();

    await postTo(t, START_PATH, startBody, "Bearer wrong");

    expect(await t.run((ctx) => ctx.db.query("deviceRequests").collect())).toEqual([]);
  });

  // req-accounts-and-connections AC-6.3, AC-6.4
  test("device-collect returns pending, then the approved connections once", async () => {
    const { t, userId } = await setup();
    const { code, device_secret } = await started(t);

    const pending = await postTo(t, COLLECT_PATH, { device_secret });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: "pending" });

    const app = t.withIdentity({ subject: "user_a", email: "a@example.com" });
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    expect(
      await app.mutation(identity.deviceRequests.approveDeviceRequest, { code: typed }),
    ).toEqual({ status: "approved" });

    const response = await postTo(t, COLLECT_PATH, { device_secret });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      connections: { harness: string; connection_id: string; token: string }[];
    };
    expect(body.status).toBe("approved");
    expect(body.connections.map((connection) => connection.harness)).toEqual([
      "claude-code",
      "cursor",
    ]);
    for (const connection of body.connections) {
      expect(Object.keys(connection).sort()).toEqual(["connection_id", "harness", "token"]);
      const resolved = await post(t, { token_hash: await hashToken(connection.token) });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({
        userId,
        credentialId: connection.connection_id,
        kind: "connection_token",
        harness: connection.harness,
      });
    }

    const again = await postTo(t, COLLECT_PATH, { device_secret });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "not_found" });
    // One pre-existing token plus one per harness.
    expect(await credentialRows(t)).toHaveLength(3);
  });

  // req-accounts-and-connections AC-6.6
  test("device-collect returns declined after a decline", async () => {
    const { t } = await setup();
    const { code, device_secret } = await started(t);
    const app = t.withIdentity({ subject: "user_a", email: "a@example.com" });
    await app.mutation(identity.deviceRequests.declineDeviceRequest, { code });

    const response = await postTo(t, COLLECT_PATH, { device_secret });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "declined" });
  });

  test("device-collect returns not_found for an unknown secret", async () => {
    const { t } = await setup();

    const response = await postTo(t, COLLECT_PATH, { device_secret: "A".repeat(43) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "not_found" });
  });

  test("device-collect returns 401 when the approving account is deleting", async () => {
    const { t, userId } = await setup();
    const { code, device_secret } = await started(t);
    const app = t.withIdentity({ subject: "user_a", email: "a@example.com" });
    await app.mutation(identity.deviceRequests.approveDeviceRequest, { code });
    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: Date.now() }));

    const response = await postTo(t, COLLECT_PATH, { device_secret });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
    expect(await credentialRows(t)).toHaveLength(1);
  });

  test.each([
    ["a missing secret", {}],
    ["a short secret", { device_secret: "A".repeat(42) }],
    ["a secret outside base64url", { device_secret: "+".repeat(43) }],
  ])("device-collect returns 400 for %s", async (_label, body) => {
    const { t } = await setup();

    const response = await postTo(t, COLLECT_PATH, body);

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "device_secret" });
  });
});

describe("/svc/identity/revoke-self", () => {
  const REVOKE_PATH = "/svc/identity/revoke-self";

  beforeEach(() => {
    vi.stubEnv("SERVICE_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("revokes the presenting token, so resolve-token answers 401", async () => {
    const { t, tokenHash } = await setup();

    const response = await postTo(t, REVOKE_PATH, { token_hash: tokenHash });

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    const resolved = await post(t, { token_hash: tokenHash });
    expect(resolved.status).toBe(401);
    expect((await errorOf(resolved)).code).toBe("unauthenticated");
  });

  test("returns 401 for a revoked token", async () => {
    const { t, tokenHash } = await setup();
    await postTo(t, REVOKE_PATH, { token_hash: tokenHash });

    const response = await postTo(t, REVOKE_PATH, { token_hash: tokenHash });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  test("returns 401 for an unknown token", async () => {
    const { t } = await setup();

    const response = await postTo(t, REVOKE_PATH, { token_hash: await hashToken("adc_unknown") });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  test("returns 401 for another credential kind without revoking it", async () => {
    const { t, userId } = await setup();
    const oauthId = await t.run((ctx) =>
      ctx.db.insert("credentials", {
        userId,
        kind: "connection_oauth",
        tokenHash: "b".repeat(64),
        oauthClientId: "client_1",
      }),
    );

    const response = await postTo(t, REVOKE_PATH, { token_hash: "b".repeat(64) });

    expect(response.status).toBe(401);
    expect((await t.run((ctx) => ctx.db.get("credentials", oauthId)))?.revokedAt).toBeUndefined();
  });

  test("returns 401 for a deleting account", async () => {
    const { t, userId, credentialId, tokenHash } = await setup();
    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: Date.now() }));

    const response = await postTo(t, REVOKE_PATH, { token_hash: tokenHash });

    expect(response.status).toBe(401);
    expect(
      (await t.run((ctx) => ctx.db.get("credentials", credentialId)))?.revokedAt,
    ).toBeUndefined();
  });

  test("returns 400 naming token_hash for a malformed hash", async () => {
    const { t } = await setup();

    const response = await postTo(t, REVOKE_PATH, { token_hash: "A".repeat(64) });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "token_hash" });
  });

  test("a wrong service secret revokes nothing", async () => {
    const { t, credentialId, tokenHash } = await setup();

    const response = await postTo(t, REVOKE_PATH, { token_hash: tokenHash }, "Bearer wrong");

    expect(response.status).toBe(401);
    expect(
      (await t.run((ctx) => ctx.db.get("credentials", credentialId)))?.revokedAt,
    ).toBeUndefined();
  });
});
