import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { hashToken } from "./tokens";

const args = {
  clerkUserId: "user_a",
  email: "a@example.com",
  harness: "claude-code",
  name: "Claude Code",
};

describe("mintConnectionToken", () => {
  test("creates the user once and one credential per call", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.identity.devMint.mintConnectionToken, args);
    const second = await t.mutation(internal.identity.devMint.mintConnectionToken, {
      ...args,
      machineName: "laptop",
    });

    expect(second.userId).toBe(first.userId);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
    const credentials = await t.run((ctx) => ctx.db.query("credentials").collect());
    expect(credentials).toHaveLength(2);
    expect(credentials.map((c) => c.tokenHash).sort()).toEqual(
      [await hashToken(first.token), await hashToken(second.token)].sort(),
    );
    expect(first.token).toMatch(/^adc_/);
  });

  test("returns a token that resolves to the minted credential", async () => {
    const t = convexTest(schema, modules);

    const minted = await t.mutation(internal.identity.devMint.mintConnectionToken, args);
    const resolved = await t.mutation(internal.identity.credentials.resolveToken, {
      tokenHash: await hashToken(minted.token),
    });

    expect(resolved).toMatchObject({ userId: minted.userId, credentialId: minted.credentialId });
  });

  test("refuses a deleting user and inserts no credential", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 1 }),
    );

    await expect(
      t.mutation(internal.identity.devMint.mintConnectionToken, args),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(0);
  });
});

describe("mintApiToken", () => {
  const apiArgs = { clerkUserId: "user_a", email: "a@example.com", name: "Local API checks" };

  test("returns an adp_ token that resolves as an api_token, storing only its hash", async () => {
    const t = convexTest(schema, modules);

    const minted = await t.mutation(internal.identity.devMint.mintApiToken, apiArgs);
    const resolved = await t.mutation(internal.identity.credentials.resolveToken, {
      tokenHash: await hashToken(minted.token),
    });

    expect(minted.token).toMatch(/^adp_[A-Za-z0-9_-]{43}$/);
    expect(resolved).toMatchObject({
      userId: minted.userId,
      credentialId: minted.credentialId,
      kind: "api_token",
      name: "Local API checks",
    });
    const [credential] = await t.run((ctx) => ctx.db.query("credentials").collect());
    expect(credential?.tokenHash).toBe(await hashToken(minted.token));
    expect(JSON.stringify(credential)).not.toContain(minted.token);
  });

  test("reuses the user that a connection-token mint created", async () => {
    const t = convexTest(schema, modules);

    const connection = await t.mutation(internal.identity.devMint.mintConnectionToken, args);
    const api = await t.mutation(internal.identity.devMint.mintApiToken, apiArgs);

    expect(api.userId).toBe(connection.userId);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
  });

  test("refuses a deleting user and inserts no credential", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 1 }),
    );

    await expect(t.mutation(internal.identity.devMint.mintApiToken, apiArgs)).rejects.toMatchObject(
      { data: { code: "unauthenticated" } },
    );
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(0);
  });
});
