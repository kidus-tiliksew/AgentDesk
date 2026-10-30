import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { agents } from "../agents/refs";
import { decisions } from "../decisions/refs";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { identity } from "./refs";
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

describe("mintInstallKey", () => {
  const keyArgs = {
    clerkUserId: "user_a",
    email: "a@example.com",
    label: "Smoke",
    harnesses: ["claude-code"],
    expiresInDays: 1,
    machineLimit: 1,
    ephemeral: true,
    idleLimitMinutes: 15,
  };

  test("returns an adk_ secret that enrolls, storing only its hash", async () => {
    const t = convexTest(schema, modules);

    const minted = await t.mutation(internal.identity.devMint.mintInstallKey, keyArgs);
    const enrolled = await t.mutation(identity.installKeys.enroll, {
      keyHash: await hashToken(minted.secret),
      machineName: "smoke",
      harnesses: ["claude-code"],
    });

    expect(minted.secret).toMatch(/^adk_[A-Za-z0-9_-]{43}$/);
    expect(enrolled.status).toBe("enrolled");
    const [key] = await t.run((ctx) => ctx.db.query("installKeys").collect());
    expect(key).toMatchObject({
      _id: minted.installKeyId,
      userId: minted.userId,
      label: "Smoke",
      ephemeral: true,
      idleLimitMinutes: 15,
      keyHash: await hashToken(minted.secret),
    });
    expect(JSON.stringify(key)).not.toContain(minted.secret);
  });

  test("validates the key as createInstallKey does and writes nothing on refusal", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.identity.devMint.mintInstallKey, { ...keyArgs, idleLimitMinutes: 1 }),
    ).rejects.toMatchObject({ data: { code: "invalid", field: "idleLimitMinutes" } });
    expect(await t.run((ctx) => ctx.db.query("installKeys").collect())).toHaveLength(0);
  });

  test("refuses a deleting user and inserts no key", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 1 }),
    );

    await expect(
      t.mutation(internal.identity.devMint.mintInstallKey, keyArgs),
    ).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    expect(await t.run((ctx) => ctx.db.query("installKeys").collect())).toHaveLength(0);
  });
});

describe("inspectConnection", () => {
  test("reports the connection, its sessions, and their decisions, and refuses an unknown id", async () => {
    const t = convexTest(schema, modules);
    const minted = await t.mutation(internal.identity.devMint.mintConnectionToken, args);
    const { agentSessionId } = await t.mutation(agents.sessions.open, {
      userId: minted.userId,
      credentialId: minted.credentialId,
      clientName: "Claude Code",
      clientVersion: "2.1.0",
    });
    await t.mutation(agents.sessions.status, {
      userId: minted.userId,
      agentSessionId,
      topic: "repo/x",
      state: "working",
      line: "Working",
    });
    const decision = await t.mutation(decisions.operations.create, {
      userId: minted.userId,
      agentSessionId,
      input: { title: "Ship it?", input_type: "approve_reject", topic: "repo/x" },
    });

    const inspected = await t.query(internal.identity.devMint.inspectConnection, {
      credentialId: minted.credentialId,
    });

    expect(inspected).toEqual({
      revokedAt: null,
      idleDeadlineAt: null,
      lastUsedAt: null,
      sessions: [{ id: agentSessionId, endedAt: null, endReason: null }],
      decisions: [{ id: decision.id, state: "pending", cancelReason: null }],
    });
    await expect(
      t.query(internal.identity.devMint.inspectConnection, { credentialId: "nope" }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});
