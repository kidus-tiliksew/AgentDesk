import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertConnectionToken, revokeCredential } from "./credentials";
import { hashToken } from "./tokens";

const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found" } };

async function setup() {
  const t = convexTest(schema, modules);
  const { userId, plaintext, credentialId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const minted = await insertConnectionToken(ctx, {
      userId,
      harness: "claude-code",
      name: "Claude Code",
      machineName: "laptop",
    });
    return { userId, ...minted };
  });
  return { t, userId, credentialId, tokenHash: await hashToken(plaintext) };
}

function stored(t: Awaited<ReturnType<typeof setup>>["t"], id: Id<"credentials">) {
  return t.run((ctx) => ctx.db.get("credentials", id));
}

describe("insertConnectionToken", () => {
  test("stores the SHA-256 hex of the plaintext and never the plaintext", async () => {
    const { t, credentialId, tokenHash } = await setup();

    const credential = await stored(t, credentialId);

    expect(credential).toMatchObject({ kind: "connection_token", tokenHash });
    expect(JSON.stringify(credential)).not.toContain("adc_");
  });
});

describe("resolveToken", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves a minted token to its user and credential", async () => {
    const { t, userId, credentialId, tokenHash } = await setup();

    const resolved = await t.mutation(internal.identity.credentials.resolveToken, { tokenHash });

    expect(resolved).toEqual({
      userId,
      credentialId,
      kind: "connection_token",
      harness: "claude-code",
      name: "Claude Code",
    });
  });

  test("throws unauthenticated for an unknown hash", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.identity.credentials.resolveToken, {
        tokenHash: await hashToken("adc_unknown"),
      }),
    ).rejects.toMatchObject(unauthenticated);
  });

  // req-accounts-and-connections AC-4.2
  test("throws unauthenticated for a revoked credential", async () => {
    const { t, userId, credentialId, tokenHash } = await setup();
    await t.run((ctx) => revokeCredential(ctx, userId, credentialId));

    await expect(
      t.mutation(internal.identity.credentials.resolveToken, { tokenHash }),
    ).rejects.toMatchObject(unauthenticated);
  });

  test("throws unauthenticated for a credential of a deleting user", async () => {
    const { t, userId, tokenHash } = await setup();
    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: 1 }));

    await expect(
      t.mutation(internal.identity.credentials.resolveToken, { tokenHash }),
    ).rejects.toMatchObject(unauthenticated);
  });

  test("writes lastUsedAt on the first resolve and at most once a minute after", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-10-10T00:00:00Z").getTime();
    vi.setSystemTime(start);
    const { t, credentialId, tokenHash } = await setup();
    const resolve = () => t.mutation(internal.identity.credentials.resolveToken, { tokenHash });

    await resolve();
    expect((await stored(t, credentialId))?.lastUsedAt).toBe(start);

    vi.setSystemTime(start + 30_000);
    await resolve();
    expect((await stored(t, credentialId))?.lastUsedAt).toBe(start);

    vi.setSystemTime(start + 61_000);
    await resolve();
    expect((await stored(t, credentialId))?.lastUsedAt).toBe(start + 61_000);
  });
});

describe("revokeCredential", () => {
  test("sets revokedAt on the owner's credential and keeps it on a second revoke", async () => {
    const { t, userId, credentialId } = await setup();

    await t.run((ctx) => revokeCredential(ctx, userId, credentialId));
    const first = (await stored(t, credentialId))?.revokedAt;
    await t.run((ctx) => revokeCredential(ctx, userId, credentialId));
    const second = (await stored(t, credentialId))?.revokedAt;

    expect(first).toBeTypeOf("number");
    expect(second).toBe(first);
  });

  // req-accounts-and-connections AC-1.1
  test("throws not_found for another user's credential without revoking it", async () => {
    const { t, credentialId } = await setup();
    const other = await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" }),
    );

    await expect(t.run((ctx) => revokeCredential(ctx, other, credentialId))).rejects.toMatchObject(
      notFound,
    );
    expect((await stored(t, credentialId))?.revokedAt).toBeUndefined();
  });

  test("throws not_found for a missing credential", async () => {
    const { t, userId, credentialId } = await setup();
    await t.run((ctx) => ctx.db.delete("credentials", credentialId));

    await expect(t.run((ctx) => revokeCredential(ctx, userId, credentialId))).rejects.toMatchObject(
      notFound,
    );
  });
});
