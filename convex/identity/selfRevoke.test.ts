import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertApiToken, insertConnectionToken } from "./credentials";
import { hashToken } from "./tokens";

// component-identity §Service routes: the installer's uninstall revokes the
// connection token it presents, and the Mac app's sign-out revokes its API
// token (req-mac-app AC-2.7).

const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const unauthenticated = { data: { code: "unauthenticated" } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const laptop = await insertConnectionToken(ctx, {
      userId,
      harness: "codex",
      name: "Codex",
      machineName: "laptop",
    });
    const sibling = await insertConnectionToken(ctx, {
      userId,
      harness: "cursor",
      name: "Cursor",
      machineName: "laptop",
    });
    const oauthId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_oauth",
      tokenHash: "b".repeat(64),
      oauthClientId: "client_1",
    });
    const apiTokenId = await ctx.db.insert("credentials", {
      userId,
      kind: "api_token",
      tokenHash: "c".repeat(64),
      name: "CI token",
    });
    // An API token naming a harness other than the Mac client.
    await ctx.db.insert("credentials", {
      userId,
      kind: "api_token",
      tokenHash: "e".repeat(64),
      name: "Script",
      harness: "codex",
    });
    const mac = await insertApiToken(ctx, {
      userId,
      name: "AgentDesk for Mac",
      harness: "macos",
      machineName: "Studio Mac",
    });
    return { userId, laptop, sibling, oauthId, apiTokenId, mac };
  });
  return {
    t,
    ...ids,
    laptopHash: await hashToken(ids.laptop.plaintext),
    siblingHash: await hashToken(ids.sibling.plaintext),
    macHash: await hashToken(ids.mac.plaintext),
  };
}

function revokeSelf(t: Awaited<ReturnType<typeof setup>>["t"], tokenHash: string) {
  return t.mutation(internal.identity.selfRevoke.revokeSelf, { tokenHash });
}

function revokedAts(t: Awaited<ReturnType<typeof setup>>["t"]) {
  return t.run(async (ctx) =>
    (await ctx.db.query("credentials").collect()).map((credential) => credential.revokedAt ?? null),
  );
}

describe("revokeSelf", () => {
  // req-accounts-and-connections AC-4.2
  test("revokes the presenting connection token only", async () => {
    const { t, laptop, laptopHash, siblingHash } = await setup();

    expect(await revokeSelf(t, laptopHash)).toBeNull();

    const credential = await t.run((ctx) => ctx.db.get("credentials", laptop.credentialId));
    expect(credential?.revokedAt).toBe(START);
    await expect(
      t.mutation(internal.identity.credentials.resolveToken, { tokenHash: laptopHash }),
    ).rejects.toMatchObject(unauthenticated);
    expect(
      await t.mutation(internal.identity.credentials.resolveToken, { tokenHash: siblingHash }),
    ).toMatchObject({ harness: "cursor" });
  });

  // req-mac-app AC-2.7
  test("revokes the presenting Mac API token only", async () => {
    const { t, mac, macHash, laptopHash } = await setup();

    expect(await revokeSelf(t, macHash)).toBeNull();

    const credential = await t.run((ctx) => ctx.db.get("credentials", mac.credentialId));
    expect(credential?.revokedAt).toBe(START);
    await expect(
      t.mutation(internal.identity.credentials.resolveToken, { tokenHash: macHash }),
    ).rejects.toMatchObject(unauthenticated);
    expect(
      await t.mutation(internal.identity.credentials.resolveToken, { tokenHash: laptopHash }),
    ).toMatchObject({ harness: "codex" });
    await expect(revokeSelf(t, macHash)).rejects.toMatchObject(unauthenticated);
  });

  test("refuses an already revoked token and keeps the first revokedAt", async () => {
    const { t, laptop, laptopHash } = await setup();
    await revokeSelf(t, laptopHash);
    vi.setSystemTime(START + 60_000);

    await expect(revokeSelf(t, laptopHash)).rejects.toMatchObject(unauthenticated);

    const credential = await t.run((ctx) => ctx.db.get("credentials", laptop.credentialId));
    expect(credential?.revokedAt).toBe(START);
  });

  test.each([
    ["an unknown hash", () => "d".repeat(64)],
    ["an OAuth connection", () => "b".repeat(64)],
    ["an API token", () => "c".repeat(64)],
    ["an API token naming another harness", () => "e".repeat(64)],
  ])("refuses %s and revokes nothing", async (_label, pick) => {
    const { t } = await setup();
    const before = await revokedAts(t);

    await expect(revokeSelf(t, pick())).rejects.toMatchObject(unauthenticated);

    expect(await revokedAts(t)).toEqual(before);
  });

  test("refuses a token of an account whose deletion has started", async () => {
    const { t, userId, laptopHash } = await setup();
    await t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));
    const before = await revokedAts(t);

    await expect(revokeSelf(t, laptopHash)).rejects.toMatchObject(unauthenticated);

    expect(await revokedAts(t)).toEqual(before);
  });

  test("refuses a token whose account is gone", async () => {
    const { t, userId, laptopHash } = await setup();
    await t.run((ctx) => ctx.db.delete("users", userId));

    await expect(revokeSelf(t, laptopHash)).rejects.toMatchObject(unauthenticated);
  });
});
