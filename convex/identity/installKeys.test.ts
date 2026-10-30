import { errorBodySchema } from "@agentdesk/contract";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { insertConnectionToken } from "./credentials";
import { type InstallKeyInput, insertInstallKey } from "./installKeys";
import { identity } from "./refs";
import { hashToken } from "./tokens";

// component-identity §Install keys and §Enrollment (req-install-keys REQ-1 to
// REQ-3; DEC-21).

const START = Date.UTC(2026, 9, 30, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const asUserA = { subject: "user_a", email: "a@example.com" };
const asUserB = { subject: "user_b", email: "b@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found", message: "Install key not found" } };
const SECRET_PATTERN = /^adk_[A-Za-z0-9_-]{43}$/;
const SERVICE_SECRET = "test-service-secret";

const invalid = (field: string) => ({ data: { code: "invalid", field } });

const KEY: InstallKeyInput = {
  label: "Sandboxes",
  harnesses: ["claude-code", "codex"],
  expiresInDays: 30,
  machineLimit: 2,
  ephemeral: false,
};

const EPHEMERAL: InstallKeyInput = {
  label: "Ephemeral sandboxes",
  harnesses: ["claude-code", "codex", "cursor"],
  expiresInDays: 7,
  machineLimit: 3,
  ephemeral: true,
  idleLimitMinutes: 30,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const base = convexTest(schema, modules);
  const { userId, otherUserId } = await base.run(async (ctx) => ({
    userId: await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    otherUserId: await ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" }),
  }));
  return {
    base,
    a: base.withIdentity(asUserA),
    b: base.withIdentity(asUserB),
    userId,
    otherUserId,
  };
}

type Base = Awaited<ReturnType<typeof setup>>["base"];

function snapshot(base: Base) {
  return base.run(async (ctx) => ({
    keys: await ctx.db.query("installKeys").collect(),
    credentials: await ctx.db.query("credentials").collect(),
  }));
}

async function mintKey(base: Base, userId: Id<"users">, input: InstallKeyInput = KEY) {
  return await base.run((ctx) => insertInstallKey(ctx, userId, input, Date.now()));
}

async function enroll(
  base: Base,
  secret: string,
  harnesses: string[] = ["claude-code"],
  machineName = "sandbox-1",
) {
  return await base.mutation(identity.installKeys.enroll, {
    keyHash: await hashToken(secret),
    machineName,
    harnesses,
  });
}

async function enrolled(
  base: Base,
  secret: string,
  harnesses: string[] = ["claude-code"],
  machineName = "sandbox-1",
) {
  const result = await enroll(base, secret, harnesses, machineName);
  if (result.status !== "enrolled") {
    throw new Error(`expected enrolled, got ${result.status}`);
  }
  return result;
}

describe("createInstallKey", () => {
  // req-install-keys AC-1.1
  test("returns the secret once and stores only its SHA-256 hex", async () => {
    const { base, a, userId } = await setup();

    const created = await a.mutation(identity.installKeys.createInstallKey, {
      ...KEY,
      harnesses: [...KEY.harnesses] as string[],
    });

    expect(created.secret).toMatch(SECRET_PATTERN);
    const { keys } = await snapshot(base);
    expect(keys).toEqual([
      {
        _id: created.installKeyId,
        _creationTime: expect.any(Number),
        userId,
        label: "Sandboxes",
        keyHash: await hashToken(created.secret),
        harnesses: ["claude-code", "codex"],
        ephemeral: false,
        machineLimit: 2,
        expiresAt: START + 30 * DAY,
      },
    ]);
    expect(JSON.stringify(keys)).not.toContain(created.secret);
    expect(JSON.stringify(keys)).not.toContain(created.secret.slice(4));
  });

  test("mints a different secret for every key", async () => {
    const { a } = await setup();
    const args = { ...KEY, harnesses: ["codex"] };

    const first = await a.mutation(identity.installKeys.createInstallKey, args);
    const second = await a.mutation(identity.installKeys.createInstallKey, args);

    expect(first.secret).not.toBe(second.secret);
  });

  // req-install-keys AC-1.3
  test("stores an ephemeral key's idle limit and trims the label", async () => {
    const { base, a } = await setup();

    const created = await a.mutation(identity.installKeys.createInstallKey, {
      ...EPHEMERAL,
      label: "  Ephemeral sandboxes \n",
      harnesses: ["cursor"],
    });

    const { keys } = await snapshot(base);
    expect(keys[0]).toMatchObject({
      _id: created.installKeyId,
      label: "Ephemeral sandboxes",
      harnesses: ["cursor"],
      ephemeral: true,
      idleLimitMinutes: 30,
      machineLimit: 3,
      expiresAt: START + 7 * DAY,
    });
  });

  // req-install-keys AC-1.2, AC-1.3: each bound is inclusive.
  test.each<[string, Partial<InstallKeyInput>]>([
    ["a 1-character label", { label: "x" }],
    ["a 64-character label", { label: "x".repeat(64) }],
    ["every harness", { harnesses: ["cursor", "codex", "claude-code"] }],
    ["a 1-day expiry", { expiresInDays: 1 }],
    ["a 90-day expiry", { expiresInDays: 90 }],
    ["a machine limit of 1", { machineLimit: 1 }],
    ["a machine limit of 100", { machineLimit: 100 }],
    ["a 15-minute idle limit", { ephemeral: true, idleLimitMinutes: 15 }],
    ["a 24-hour idle limit", { ephemeral: true, idleLimitMinutes: 1440 }],
  ])("accepts %s", async (_label, change) => {
    const { base, a } = await setup();

    await a.mutation(identity.installKeys.createInstallKey, {
      ...KEY,
      harnesses: [...KEY.harnesses] as string[],
      ...change,
    } as never);

    expect((await snapshot(base)).keys).toHaveLength(1);
  });

  // req-install-keys AC-1.2, AC-1.3
  test.each<[string, Partial<InstallKeyInput>, string]>([
    ["an empty label", { label: "" }, "label"],
    ["a blank label", { label: "   " }, "label"],
    ["a 65-character label", { label: "x".repeat(65) }, "label"],
    ["no harnesses", { harnesses: [] }, "harnesses"],
    ["a repeated harness", { harnesses: ["codex", "codex"] }, "harnesses"],
    ["an unknown harness", { harnesses: ["codex", "vim"] }, "harnesses"],
    ["a 0-day expiry", { expiresInDays: 0 }, "expiresInDays"],
    ["a 91-day expiry", { expiresInDays: 91 }, "expiresInDays"],
    ["a fractional expiry", { expiresInDays: 1.5 }, "expiresInDays"],
    ["a machine limit of 0", { machineLimit: 0 }, "machineLimit"],
    ["a machine limit of 101", { machineLimit: 101 }, "machineLimit"],
    ["a fractional machine limit", { machineLimit: 2.5 }, "machineLimit"],
    ["an ephemeral key without an idle limit", { ephemeral: true }, "idleLimitMinutes"],
    ["a 14-minute idle limit", { ephemeral: true, idleLimitMinutes: 14 }, "idleLimitMinutes"],
    ["a 1441-minute idle limit", { ephemeral: true, idleLimitMinutes: 1441 }, "idleLimitMinutes"],
    ["a fractional idle limit", { ephemeral: true, idleLimitMinutes: 15.5 }, "idleLimitMinutes"],
    ["an idle limit on a key that is not ephemeral", { idleLimitMinutes: 30 }, "idleLimitMinutes"],
  ])("refuses %s naming the field and writes nothing", async (_label, change, field) => {
    const { base, a } = await setup();

    await expect(
      a.mutation(identity.installKeys.createInstallKey, {
        ...KEY,
        harnesses: [...KEY.harnesses] as string[],
        ...change,
      } as never),
    ).rejects.toMatchObject(invalid(field));

    expect((await snapshot(base)).keys).toEqual([]);
  });

  test("refuses a call without a signed-in person or with a deleting account", async () => {
    const { base, a, userId } = await setup();
    const args = { ...KEY, harnesses: ["codex"] };

    await expect(base.mutation(identity.installKeys.createInstallKey, args)).rejects.toMatchObject(
      unauthenticated,
    );
    await base.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));
    await expect(a.mutation(identity.installKeys.createInstallKey, args)).rejects.toMatchObject(
      unauthenticated,
    );
    expect((await snapshot(base)).keys).toEqual([]);
  });
});

describe("listInstallKeys", () => {
  // req-install-keys AC-3.1
  test("lists the account's unrevoked keys newest first with the public fields only", async () => {
    const { base, a, userId, otherUserId } = await setup();
    const older = await mintKey(base, userId, KEY);
    vi.setSystemTime(START + MINUTE);
    const newer = await mintKey(base, userId, EPHEMERAL);
    const revoked = await mintKey(base, userId, KEY);
    await base.run((ctx) =>
      ctx.db.patch("installKeys", revoked.installKeyId, { revokedAt: START }),
    );
    await mintKey(base, otherUserId, KEY);
    vi.setSystemTime(START + 2 * MINUTE);
    await enrolled(base, newer.secret, ["codex", "cursor"]);

    const keys = await a.query(identity.installKeys.listInstallKeys, {});

    const rows = (await snapshot(base)).keys;
    const created = (id: Id<"installKeys">) => rows.find((row) => row._id === id)?._creationTime;
    expect(keys).toEqual([
      {
        installKeyId: newer.installKeyId,
        label: "Ephemeral sandboxes",
        harnesses: ["claude-code", "codex", "cursor"],
        createdAt: created(newer.installKeyId),
        expiresAt: START + MINUTE + 7 * DAY,
        ephemeral: true,
        idleLimitMinutes: 30,
        machineLimit: 3,
        machinesConnected: 1,
        lastUsedAt: START + 2 * MINUTE,
      },
      {
        installKeyId: older.installKeyId,
        label: "Sandboxes",
        harnesses: ["claude-code", "codex"],
        createdAt: created(older.installKeyId),
        expiresAt: START + 30 * DAY,
        ephemeral: false,
        machineLimit: 2,
        machinesConnected: 0,
      },
    ]);
    expect(JSON.stringify(keys)).not.toContain("keyHash");
  });

  test("keeps an expired key listed until it is revoked", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, expiresInDays: 1 });
    vi.setSystemTime(START + 2 * DAY);

    const keys = await a.query(identity.installKeys.listInstallKeys, {});

    expect(keys.map((listed) => listed.installKeyId)).toEqual([key.installKeyId]);
    expect(keys[0]?.expiresAt).toBeLessThan(Date.now());
  });

  // req-install-keys AC-2.4, AC-4.3
  test("counts distinct machines among unrevoked connections", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, machineLimit: 5 });
    const first = await enrolled(base, key.secret, ["claude-code", "codex"], "one");
    const second = await enrolled(base, key.secret, ["codex"], "two");
    const count = async () => (await a.query(identity.installKeys.listInstallKeys, {}))[0];

    expect((await count())?.machinesConnected).toBe(2);

    // One of two connections of a machine ended: the machine still counts.
    const [firstClaude, firstCodex] = first.connections;
    await a.mutation(identity.connections.revokeConnection, {
      credentialId: firstClaude?.connection_id,
    });
    expect((await count())?.machinesConnected).toBe(2);

    await a.mutation(identity.connections.revokeConnection, {
      credentialId: firstCodex?.connection_id,
    });
    expect((await count())?.machinesConnected).toBe(1);

    await a.mutation(identity.connections.revokeConnection, {
      credentialId: second.connections[0]?.connection_id,
    });
    expect((await count())?.machinesConnected).toBe(0);
  });

  test("returns an empty list for an account without keys and refuses without a person", async () => {
    const { base, a } = await setup();

    expect(await a.query(identity.installKeys.listInstallKeys, {})).toEqual([]);
    await expect(base.query(identity.installKeys.listInstallKeys, {})).rejects.toMatchObject(
      unauthenticated,
    );
  });
});

describe("revokeInstallKey", () => {
  // req-install-keys AC-3.2
  test("refuses the key's next enrollment and leaves its connections working", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId);
    const { connections } = await enrolled(base, key.secret);
    vi.setSystemTime(START + MINUTE);

    expect(
      await a.mutation(identity.installKeys.revokeInstallKey, {
        installKeyId: key.installKeyId,
        revokeConnections: false,
      }),
    ).toBeNull();

    const { keys, credentials } = await snapshot(base);
    expect(keys[0]?.revokedAt).toBe(START + MINUTE);
    expect(credentials[0]?.revokedAt).toBeUndefined();
    expect(await enroll(base, key.secret)).toEqual({ status: "revoked" });
    const connection = connections[0];
    await expect(
      base.mutation(internal.identity.credentials.resolveToken, {
        tokenHash: await hashToken(connection?.token ?? ""),
      }),
    ).resolves.toMatchObject({ credentialId: connection?.connection_id });
    expect(await a.query(identity.installKeys.listInstallKeys, {})).toEqual([]);
  });

  test("with revokeConnections, revokes every connection the key made and no other", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, machineLimit: 3 });
    await enrolled(base, key.secret, ["claude-code", "codex"], "one");
    await enrolled(base, key.secret, ["codex"], "two");
    const other = await base.run((ctx) =>
      insertConnectionToken(ctx, {
        userId,
        harness: "codex",
        name: "Codex",
        machineName: "laptop",
      }),
    );
    // A connection the person revoked earlier keeps its first revocation time.
    const { credentials: before } = await snapshot(base);
    const earlier = before.find((row) => row.machineName === "two");
    await base.run((ctx) =>
      ctx.db.patch("credentials", earlier?._id as Id<"credentials">, { revokedAt: START - MINUTE }),
    );
    vi.setSystemTime(START + MINUTE);

    await a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: key.installKeyId,
      revokeConnections: true,
    });

    const { credentials } = await snapshot(base);
    for (const credential of credentials) {
      if (credential._id === other.credentialId) {
        expect(credential.revokedAt).toBeUndefined();
      } else if (credential._id === earlier?._id) {
        expect(credential.revokedAt).toBe(START - MINUTE);
      } else {
        expect(credential.revokedAt).toBe(START + MINUTE);
      }
    }
    const listed = await a.query(identity.connections.listConnections, {});
    expect(listed.map((connection) => connection.credentialId)).toEqual([other.credentialId]);
  });

  test("a second revoke keeps the first time and can still revoke the connections", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId);
    await enrolled(base, key.secret);
    await a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: key.installKeyId,
      revokeConnections: false,
    });
    vi.setSystemTime(START + MINUTE);

    await a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: key.installKeyId,
      revokeConnections: true,
    });

    const { keys, credentials } = await snapshot(base);
    expect(keys[0]?.revokedAt).toBe(START);
    expect(credentials[0]?.revokedAt).toBe(START + MINUTE);
  });

  // req-accounts-and-connections AC-1.1
  test.each<[string, (ids: { other: string; deleted: string }) => unknown]>([
    ["an omitted id", () => undefined],
    ["a malformed id", () => "not-an-id"],
    ["a number", () => 7],
    ["another account's key", (ids) => ids.other],
    ["a deleted key", (ids) => ids.deleted],
  ])("refuses %s with not_found and writes nothing", async (_label, pick) => {
    const { base, a, userId, otherUserId } = await setup();
    const other = await mintKey(base, otherUserId);
    await enrolled(base, other.secret);
    const deleted = await mintKey(base, userId);
    await base.run((ctx) => ctx.db.delete("installKeys", deleted.installKeyId));
    const before = await snapshot(base);

    await expect(
      a.mutation(identity.installKeys.revokeInstallKey, {
        installKeyId: pick({ other: other.installKeyId, deleted: deleted.installKeyId }),
        revokeConnections: true,
      }),
    ).rejects.toMatchObject(notFound);

    expect(await snapshot(base)).toEqual(before);
  });

  test("refuses a call without a signed-in person", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);

    await expect(
      base.mutation(identity.installKeys.revokeInstallKey, {
        installKeyId: key.installKeyId,
        revokeConnections: false,
      }),
    ).rejects.toMatchObject(unauthenticated);
  });
});

describe("listConnections with install keys", () => {
  // req-install-keys AC-3.3
  test("names the key that made each connection, even after the key is revoked", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId);
    const { connections } = await enrolled(base, key.secret, ["codex"]);
    const other = await base.run((ctx) =>
      insertConnectionToken(ctx, { userId, harness: "cursor", name: "Cursor" }),
    );
    await a.mutation(identity.installKeys.revokeInstallKey, {
      installKeyId: key.installKeyId,
      revokeConnections: false,
    });

    const listed = await a.query(identity.connections.listConnections, {});

    const byId = new Map(listed.map((connection) => [connection.credentialId, connection]));
    expect(byId.get(connections[0]?.connection_id as Id<"credentials">)).toEqual({
      credentialId: connections[0]?.connection_id,
      name: "Codex",
      machineName: "sandbox-1",
      firstConnectedAt: expect.any(Number),
      installKeyLabel: "Sandboxes",
    });
    expect(byId.get(other.credentialId)).not.toHaveProperty("installKeyLabel");
    expect(JSON.stringify(listed)).not.toContain("machineId");
  });
});

describe("enroll", () => {
  // req-install-keys AC-2.1, AC-2.4
  test("connects every harness in request order as one machine", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId, EPHEMERAL);
    vi.setSystemTime(START + MINUTE);

    const result = await enrolled(base, key.secret, ["cursor", "claude-code"], "  sandbox-7 ");

    expect(result.machineId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.connections.map((connection) => connection.harness)).toEqual([
      "cursor",
      "claude-code",
    ]);
    const { keys, credentials } = await snapshot(base);
    expect(keys[0]?.lastUsedAt).toBe(START + MINUTE);
    expect(credentials).toHaveLength(2);
    for (const [index, connection] of result.connections.entries()) {
      expect(connection.token).toMatch(/^adc_[A-Za-z0-9_-]{43}$/);
      expect(credentials[index]).toEqual({
        _id: connection.connection_id,
        _creationTime: expect.any(Number),
        userId,
        kind: "connection_token",
        tokenHash: await hashToken(connection.token),
        harness: connection.harness,
        name: connection.harness === "cursor" ? "Cursor" : "Claude Code",
        machineName: "sandbox-7",
        installKeyId: key.installKeyId,
        machineId: result.machineId,
        idleDeadlineAt: START + MINUTE + 30 * MINUTE,
      });
      // Each connection resolves on its own and can be revoked separately.
      await expect(
        base.mutation(internal.identity.credentials.resolveToken, {
          tokenHash: await hashToken(connection.token),
        }),
      ).resolves.toMatchObject({ userId, credentialId: connection.connection_id });
    }
    expect(JSON.stringify(credentials)).not.toContain(result.connections[0]?.token);
  });

  test("gives a key that is not ephemeral no idle deadline and each run its own machine", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);

    const first = await enrolled(base, key.secret, ["codex"]);
    const second = await enrolled(base, key.secret, ["codex"]);

    expect(first.machineId).not.toBe(second.machineId);
    const { credentials } = await snapshot(base);
    for (const credential of credentials) {
      expect(credential).not.toHaveProperty("idleDeadlineAt");
    }
  });

  // req-install-keys AC-2.2
  test("answers unknown for a key no row holds and writes nothing", async () => {
    const { base, userId } = await setup();
    await mintKey(base, userId);
    const before = await snapshot(base);

    expect(await enroll(base, `adk_${"z".repeat(43)}`)).toEqual({ status: "unknown" });

    expect(await snapshot(base)).toEqual(before);
  });

  test("answers harness_not_allowed and connects none of the run's harnesses", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);
    const before = await snapshot(base);

    expect(await enroll(base, key.secret, ["claude-code", "cursor"])).toEqual({
      status: "harness_not_allowed",
      harness: "cursor",
    });

    expect(await snapshot(base)).toEqual(before);
  });

  test("names the first harness outside the key in request order", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, harnesses: ["codex"] });

    expect(await enroll(base, key.secret, ["codex", "cursor", "claude-code"])).toEqual({
      status: "harness_not_allowed",
      harness: "cursor",
    });
  });

  test("answers revoked for a revoked key and writes nothing", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);
    await base.run((ctx) => ctx.db.patch("installKeys", key.installKeyId, { revokedAt: START }));
    const before = await snapshot(base);

    expect(await enroll(base, key.secret)).toEqual({ status: "revoked" });

    expect(await snapshot(base)).toEqual(before);
  });

  test("answers expired from the expiry time on and writes nothing", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, expiresInDays: 1 });
    vi.setSystemTime(START + DAY - 1);
    expect((await enroll(base, key.secret)).status).toBe("enrolled");
    vi.setSystemTime(START + DAY);
    const before = await snapshot(base);

    expect(await enroll(base, key.secret)).toEqual({ status: "expired" });

    expect(await snapshot(base)).toEqual(before);
  });

  // req-install-keys AC-2.2, AC-2.4
  test("answers limit_reached once the key's machines are connected, and writes nothing", async () => {
    const { base, a, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, machineLimit: 2 });
    const first = await enrolled(base, key.secret, ["claude-code", "codex"]);
    await enrolled(base, key.secret, ["codex"]);
    const before = await snapshot(base);

    expect(await enroll(base, key.secret, ["codex"])).toEqual({ status: "limit_reached" });
    expect(await snapshot(base)).toEqual(before);

    // Ending one of two connections of a machine frees nothing; ending both
    // frees the machine.
    await a.mutation(identity.connections.revokeConnection, {
      credentialId: first.connections[0]?.connection_id,
    });
    expect(await enroll(base, key.secret, ["codex"])).toEqual({ status: "limit_reached" });
    await a.mutation(identity.connections.revokeConnection, {
      credentialId: first.connections[1]?.connection_id,
    });
    expect((await enroll(base, key.secret, ["codex"])).status).toBe("enrolled");
  });

  // The key and its connections are read in the enrollment's transaction, so
  // concurrent runs serialize and only one takes the last machine.
  test("simultaneous runs for the last machine have one winner", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, machineLimit: 2 });
    await enrolled(base, key.secret);

    const results = await Promise.all([
      enroll(base, key.secret, ["claude-code", "codex"], "a"),
      enroll(base, key.secret, ["codex"], "b"),
      enroll(base, key.secret, ["claude-code"], "c"),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "enrolled",
      "limit_reached",
      "limit_reached",
    ]);
    const machines = new Set((await snapshot(base)).credentials.map((row) => row.machineId));
    expect(machines.size).toBe(2);
  });

  test.each<[string, string[], string]>([
    ["a blank machine name", ["claude-code"], "machineName"],
    ["no harnesses", [], "harnesses"],
    ["a repeated harness", ["codex", "codex"], "harnesses"],
    ["an unknown harness", ["vim"], "harnesses"],
  ])("refuses %s naming the field and writes nothing", async (label, harnesses, field) => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);
    const before = await snapshot(base);

    await expect(
      enroll(base, key.secret, harnesses, label === "a blank machine name" ? "   " : "box"),
    ).rejects.toMatchObject(invalid(field));

    expect(await snapshot(base)).toEqual(before);
  });

  test("refuses a machine name over 255 characters and accepts 255", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);

    await expect(enroll(base, key.secret, ["codex"], "m".repeat(256))).rejects.toMatchObject(
      invalid("machineName"),
    );
    expect((await enroll(base, key.secret, ["codex"], "m".repeat(255))).status).toBe("enrolled");
  });

  test("refuses a key whose owner is being deleted or gone and writes nothing", async () => {
    const { base, userId, otherUserId } = await setup();
    const key = await mintKey(base, userId);
    const gone = await mintKey(base, otherUserId);
    await base.run(async (ctx) => {
      await ctx.db.patch("users", userId, { deletingAt: START });
      await ctx.db.delete("users", otherUserId);
    });
    const before = await snapshot(base);

    await expect(enroll(base, key.secret)).rejects.toMatchObject(unauthenticated);
    await expect(enroll(base, gone.secret)).rejects.toMatchObject(unauthenticated);

    expect(await snapshot(base)).toEqual(before);
  });
});

describe("/svc/identity/enroll", () => {
  const PATH = "/svc/identity/enroll";

  function post(base: Base, body: unknown, authorization = `Bearer ${SERVICE_SECRET}`) {
    return base.fetch(PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.stubEnv("SERVICE_SECRET", SERVICE_SECRET);
  });

  test("translates the wire fields and answers an enrollment with machine_id", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);

    const response = await post(base, {
      key_hash: await hashToken(key.secret),
      machine_name: "sandbox-1",
      harnesses: ["codex", "claude-code"],
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: "enrolled",
      machine_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      connections: [
        { harness: "codex", connection_id: expect.any(String), token: expect.any(String) },
        { harness: "claude-code", connection_id: expect.any(String), token: expect.any(String) },
      ],
    });
    const { credentials } = await snapshot(base);
    expect(credentials.map((row) => row.machineId)).toEqual([body.machine_id, body.machine_id]);
  });

  test("passes every other status through", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId, { ...KEY, harnesses: ["codex"] });

    const refused = await post(base, {
      key_hash: await hashToken(key.secret),
      machine_name: "box",
      harnesses: ["cursor"],
    });
    const unknown = await post(base, {
      key_hash: "f".repeat(64),
      machine_name: "box",
      harnesses: ["codex"],
    });

    expect(await refused.json()).toEqual({ status: "harness_not_allowed", harness: "cursor" });
    expect(await unknown.json()).toEqual({ status: "unknown" });
  });

  test("answers 400 naming the mutation's field for an invalid machine name", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);

    const response = await post(base, {
      key_hash: await hashToken(key.secret),
      machine_name: "  ",
      harnesses: ["codex"],
    });

    expect(response.status).toBe(400);
    expect(errorBodySchema.parse(await response.json()).error).toMatchObject({
      code: "invalid",
      field: "machineName",
    });
  });

  test("refuses a body that is not a key hash, and a wrong service credential", async () => {
    const { base, userId } = await setup();
    const key = await mintKey(base, userId);

    const plaintext = await post(base, {
      key_hash: key.secret,
      machine_name: "box",
      harnesses: ["codex"],
    });
    const wrong = await post(
      base,
      { key_hash: await hashToken(key.secret), machine_name: "box", harnesses: ["codex"] },
      "Bearer wrong",
    );

    expect(plaintext.status).toBe(400);
    expect(errorBodySchema.parse(await plaintext.json()).error.field).toBe("key_hash");
    expect(wrong.status).toBe(401);
    expect((await snapshot(base)).credentials).toEqual([]);
  });
});
