import { errorBodySchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertConnectionToken, revokeCredential } from "./credentials";
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
