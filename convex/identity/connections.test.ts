import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { byFirstConnected, type Connection } from "./connections";
import { insertConnectionToken } from "./credentials";
import { identity } from "./refs";
import { hashToken } from "./tokens";

// component-identity §Credentials: listConnections and revokeConnection
// (req-accounts-and-connections REQ-1, REQ-4).

const START = Date.UTC(2026, 9, 11, 12, 0, 0);
const MINUTE = 60_000;
const asUserA = { subject: "user_a", email: "a@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };
const notFound = { data: { code: "not_found", message: "Connection not found" } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

// Account A holds an installer token (oldest), an OAuth connection with no
// name, a revoked token, and an API token. Account B holds one token. Each
// credential is created a minute after the one before it.
async function setup() {
  const base = convexTest(schema, modules);
  const ids = await base.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const otherUserId = await ctx.db.insert("users", {
      clerkUserId: "user_b",
      email: "b@example.com",
    });
    const laptop = await insertConnectionToken(ctx, {
      userId,
      harness: "claude-code",
      name: "Claude Code",
      machineName: "laptop",
    });
    vi.setSystemTime(START + MINUTE);
    const oauthId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_oauth",
      tokenHash: "o".repeat(64),
      oauthClientId: "client_1",
      harness: "cursor",
      lastUsedAt: START + 3 * MINUTE,
    });
    vi.setSystemTime(START + 2 * MINUTE);
    const revokedId = await ctx.db.insert("credentials", {
      userId,
      kind: "connection_token",
      tokenHash: "r".repeat(64),
      name: "Codex",
      revokedAt: START + 2 * MINUTE,
    });
    vi.setSystemTime(START + 3 * MINUTE);
    const apiTokenId = await ctx.db.insert("credentials", {
      userId,
      kind: "api_token",
      tokenHash: "a".repeat(64),
      name: "CI token",
    });
    vi.setSystemTime(START + 4 * MINUTE);
    const other = await insertConnectionToken(ctx, {
      userId: otherUserId,
      harness: "codex",
      name: "Codex",
      machineName: "devbox",
    });
    return {
      userId,
      otherUserId,
      laptopId: laptop.credentialId,
      laptopPlaintext: laptop.plaintext,
      oauthId,
      revokedId,
      apiTokenId,
      otherId: other.credentialId,
    };
  });
  vi.setSystemTime(START + 10 * MINUTE);
  const laptopFirstConnected = (await base.run((ctx) => ctx.db.get("credentials", ids.laptopId)))
    ?._creationTime;
  return { base, t: base.withIdentity(asUserA), laptopFirstConnected, ...ids };
}

function credentials(t: Awaited<ReturnType<typeof setup>>["base"]) {
  return t.run((ctx) => ctx.db.query("credentials").collect());
}

describe("listConnections", () => {
  // req-accounts-and-connections AC-4.1
  test("returns both connection kinds newest first with the public fields only", async () => {
    const { t, base, laptopId, oauthId, laptopFirstConnected } = await setup();
    const oauth = await base.run((ctx) => ctx.db.get("credentials", oauthId));

    const connections = await t.query(identity.connections.listConnections, {});

    expect(connections).toEqual([
      {
        credentialId: oauthId,
        name: "cursor",
        firstConnectedAt: oauth?._creationTime,
        lastUsedAt: START + 3 * MINUTE,
      },
      {
        credentialId: laptopId,
        name: "Claude Code",
        machineName: "laptop",
        firstConnectedAt: laptopFirstConnected,
      },
    ]);
    expect(laptopFirstConnected).toBeGreaterThanOrEqual(START);
    expect(oauth?._creationTime).toBeGreaterThanOrEqual(START + MINUTE);
    for (const connection of connections) {
      expect(connection).not.toHaveProperty("tokenHash");
      expect(connection).not.toHaveProperty("kind");
      expect(connection).not.toHaveProperty("userId");
      expect(connection).not.toHaveProperty("oauthClientId");
      expect(connection).not.toHaveProperty("revokedAt");
    }
  });

  test("excludes revoked credentials, API tokens, and other accounts' credentials", async () => {
    const { t, revokedId, apiTokenId, otherId } = await setup();

    const ids = (await t.query(identity.connections.listConnections, {})).map(
      (connection) => connection.credentialId,
    );

    expect(ids).not.toContain(revokedId);
    expect(ids).not.toContain(apiTokenId);
    expect(ids).not.toContain(otherId);
    expect(ids).toHaveLength(2);
  });

  test("names a credential with neither name nor harness Unknown client", async () => {
    const { t, base, userId } = await setup();
    const bareId = await base.run((ctx) =>
      ctx.db.insert("credentials", {
        userId,
        kind: "connection_oauth",
        tokenHash: "b".repeat(64),
      }),
    );

    const [newest] = await t.query(identity.connections.listConnections, {});

    expect(newest).toEqual({
      credentialId: bareId,
      name: "Unknown client",
      firstConnectedAt: expect.any(Number),
    });
  });

  test("reflects a resolve's lastUsedAt write", async () => {
    const { t, base, laptopId, laptopPlaintext } = await setup();

    await base.mutation(internal.identity.credentials.resolveToken, {
      tokenHash: await hashToken(laptopPlaintext),
    });
    const connections = await t.query(identity.connections.listConnections, {});

    expect(connections.find((c) => c.credentialId === laptopId)?.lastUsedAt).toBe(
      START + 10 * MINUTE,
    );
  });

  test("returns an empty list for an account with no connections", async () => {
    const t = convexTest(schema, modules).withIdentity(asUserA);
    await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }));

    expect(await t.query(identity.connections.listConnections, {})).toEqual([]);
  });

  test("refuses a call without a signed-in person", async () => {
    const { base } = await setup();

    await expect(base.query(identity.connections.listConnections, {})).rejects.toMatchObject(
      unauthenticated,
    );
  });

  test("refuses an account whose deletion has started", async () => {
    const { t, base, userId } = await setup();
    await base.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));

    await expect(t.query(identity.connections.listConnections, {})).rejects.toMatchObject(
      unauthenticated,
    );
  });
});

describe("byFirstConnected", () => {
  // Convex never gives two documents one creation time in convex-test, so the
  // tie-breaker is checked on the comparator directly.
  test("orders newest first and breaks a tie by ascending credential id", () => {
    const entry = (credentialId: string, firstConnectedAt: number): Connection => ({
      credentialId: credentialId as Id<"credentials">,
      name: credentialId,
      firstConnectedAt,
    });

    const sorted = [entry("b", 1), entry("c", 2), entry("a", 1), entry("d", 0)].sort(
      byFirstConnected,
    );

    expect(sorted.map((connection) => connection.credentialId)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("revokeConnection", () => {
  // req-accounts-and-connections AC-4.2
  test("revokes an owned connection, so its next resolve is unauthenticated", async () => {
    const { t, base, laptopId, laptopPlaintext } = await setup();
    const tokenHash = await hashToken(laptopPlaintext);

    expect(
      await t.mutation(identity.connections.revokeConnection, { credentialId: laptopId }),
    ).toBeNull();

    const stored = await base.run((ctx) => ctx.db.get("credentials", laptopId));
    expect(stored?.revokedAt).toBe(START + 10 * MINUTE);
    await expect(
      base.mutation(internal.identity.credentials.resolveToken, { tokenHash }),
    ).rejects.toMatchObject(unauthenticated);
    const ids = (await t.query(identity.connections.listConnections, {})).map(
      (connection) => connection.credentialId,
    );
    expect(ids).not.toContain(laptopId);
  });

  test("revokes an OAuth connection", async () => {
    const { t, base, oauthId } = await setup();

    await t.mutation(identity.connections.revokeConnection, { credentialId: oauthId });

    expect((await base.run((ctx) => ctx.db.get("credentials", oauthId)))?.revokedAt).toBe(
      START + 10 * MINUTE,
    );
  });

  test("a repeated revoke succeeds and keeps the first revokedAt", async () => {
    const { t, base, laptopId } = await setup();
    await t.mutation(identity.connections.revokeConnection, { credentialId: laptopId });
    vi.setSystemTime(START + 20 * MINUTE);

    expect(
      await t.mutation(identity.connections.revokeConnection, { credentialId: laptopId }),
    ).toBeNull();

    expect((await base.run((ctx) => ctx.db.get("credentials", laptopId)))?.revokedAt).toBe(
      START + 10 * MINUTE,
    );
  });

  test("an already revoked connection from before succeeds without a write", async () => {
    const { t, base, revokedId } = await setup();

    await t.mutation(identity.connections.revokeConnection, { credentialId: revokedId });

    expect((await base.run((ctx) => ctx.db.get("credentials", revokedId)))?.revokedAt).toBe(
      START + 2 * MINUTE,
    );
  });

  // req-accounts-and-connections AC-1.1
  test.each([
    ["another account's connection", (ids: Ids) => ids.otherId],
    ["an API token", (ids: Ids) => ids.apiTokenId],
    ["a deleted credential", (ids: Ids) => ids.deletedId],
    ["an id from another table", (ids: Ids) => ids.userId],
    ["a malformed id", () => "not-an-id"],
    ["an empty string", () => ""],
    ["a number", () => 42],
    ["null", () => null],
  ])("answers not_found for %s and writes nothing", async (_label, pick) => {
    const ctx = await setup();
    const deletedId = await ctx.base.run(async (db) => {
      const id = await db.db.insert("credentials", {
        userId: ctx.userId,
        kind: "connection_token",
        tokenHash: "d".repeat(64),
      });
      await db.db.delete("credentials", id);
      return id;
    });
    const before = await credentials(ctx.base);

    await expect(
      ctx.t.mutation(identity.connections.revokeConnection, {
        credentialId: pick({ ...ctx, deletedId }),
      }),
    ).rejects.toMatchObject(notFound);

    expect(await credentials(ctx.base)).toEqual(before);
  });

  test("answers not_found for an omitted id", async () => {
    const { t, base } = await setup();
    const before = await credentials(base);

    await expect(t.mutation(identity.connections.revokeConnection, {})).rejects.toMatchObject(
      notFound,
    );

    expect(await credentials(base)).toEqual(before);
  });

  test("refuses a call without a signed-in person and writes nothing", async () => {
    const { base, laptopId } = await setup();
    const before = await credentials(base);

    await expect(
      base.mutation(identity.connections.revokeConnection, { credentialId: laptopId }),
    ).rejects.toMatchObject(unauthenticated);

    expect(await credentials(base)).toEqual(before);
  });

  test("refuses an account whose deletion has started and writes nothing", async () => {
    const { t, base, userId, laptopId } = await setup();
    await base.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));
    const before = await credentials(base);

    await expect(
      t.mutation(identity.connections.revokeConnection, { credentialId: laptopId }),
    ).rejects.toMatchObject(unauthenticated);

    expect(await credentials(base)).toEqual(before);
  });
});

type Ids = {
  userId: Id<"users">;
  otherId: Id<"credentials">;
  apiTokenId: Id<"credentials">;
  deletedId: Id<"credentials">;
};

// req-accounts-and-connections AC-4.1, AC-6.4: each harness a short-code
// sign-in connects is its own connection, listed with its display name and
// machine name and revoked separately.
describe("connections from short-code sign-in", () => {
  async function signIn() {
    const base = convexTest(schema, modules);
    await base.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    );
    const t = base.withIdentity(asUserA);
    const { code, deviceSecret } = await base.mutation(
      internal.identity.deviceRequests.startDeviceRequest,
      { machineName: "studio", harnesses: ["claude-code", "codex", "cursor"] },
    );
    await t.mutation(identity.deviceRequests.approveDeviceRequest, { code });
    const collected = await base.mutation(internal.identity.deviceRequests.collectDeviceRequest, {
      deviceSecret,
    });
    if (collected.status !== "approved") {
      throw new Error(`expected approved, got ${collected.status}`);
    }
    return { base, t, connections: collected.connections };
  }

  test("lists each harness with its display name and machine name", async () => {
    const { t } = await signIn();

    const listed = await t.query(identity.connections.listConnections, {});

    expect(
      listed
        .map(({ name, machineName }) => ({ name, machineName }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    ).toEqual([
      { name: "Claude Code", machineName: "studio" },
      { name: "Codex", machineName: "studio" },
      { name: "Cursor", machineName: "studio" },
    ]);
  });

  test("revokes one harness connection without the others", async () => {
    const { base, t, connections } = await signIn();
    const [first, ...rest] = connections;
    if (first === undefined) {
      throw new Error("no connections");
    }

    await t.mutation(identity.connections.revokeConnection, { credentialId: first.connection_id });

    await expect(
      base.mutation(internal.identity.credentials.resolveToken, {
        tokenHash: await hashToken(first.token),
      }),
    ).rejects.toMatchObject(unauthenticated);
    for (const connection of rest) {
      expect(
        await base.mutation(internal.identity.credentials.resolveToken, {
          tokenHash: await hashToken(connection.token),
        }),
      ).toMatchObject({ credentialId: connection.connection_id });
    }
    const listed = (await t.query(identity.connections.listConnections, {})).map(
      (connection) => connection.credentialId,
    );
    expect(listed.sort()).toEqual(rest.map((connection) => connection.connection_id).sort());
  });
});
