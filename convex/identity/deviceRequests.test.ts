import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import {
  ATTEMPT_RETENTION_MS,
  CODE_ALPHABET,
  type CollectResult,
  LOCK_MS,
  lockedUntil,
  normalizeCode,
  REQUEST_RETENTION_MS,
} from "./deviceRequests";
import { identity } from "./refs";
import { hashToken } from "./tokens";

// component-identity §Short-code sign-in (req-accounts-and-connections REQ-6).

const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const MINUTE = 60_000;
const asUserA = { subject: "user_a", email: "a@example.com" };
const asUserB = { subject: "user_b", email: "b@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };
const invalid = (field: string) => ({ data: { code: "invalid", field } });
const CODE_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const WRONG_CODE = "ZZZZ-ZZZZ";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup() {
  const base = convexTest(schema, modules);
  const { userId, otherUserId } = await base.run(async (ctx) => ({
    userId: await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    otherUserId: await ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" }),
  }));
  return {
    base,
    userId,
    otherUserId,
    a: base.withIdentity(asUserA),
    b: base.withIdentity(asUserB),
  };
}

type Base = Awaited<ReturnType<typeof setup>>["base"];
type Client = Awaited<ReturnType<typeof setup>>["a"];

function start(t: Base, harnesses: string[] = ["claude-code", "codex"], machineName = "laptop") {
  return t.mutation(internal.identity.deviceRequests.startDeviceRequest, {
    machineName,
    harnesses,
  });
}

function collect(t: Base, deviceSecret: string) {
  return t.mutation(internal.identity.deviceRequests.collectDeviceRequest, { deviceSecret });
}

function lookup(t: Client, code: string) {
  return t.mutation(identity.deviceRequests.lookupDeviceRequest, { code });
}

function approve(t: Client, code: string) {
  return t.mutation(identity.deviceRequests.approveDeviceRequest, { code });
}

function decline(t: Client, code: string) {
  return t.mutation(identity.deviceRequests.declineDeviceRequest, { code });
}

function requests(t: Base) {
  return t.run((ctx) => ctx.db.query("deviceRequests").collect());
}

function attempts(t: Base) {
  return t.run((ctx) => ctx.db.query("codeAttempts").collect());
}

function credentials(t: Base) {
  return t.run((ctx) => ctx.db.query("credentials").collect());
}

function at(minutes: number, ms = 0) {
  vi.setSystemTime(START + minutes * MINUTE + ms);
}

function approved(result: CollectResult) {
  if (result.status !== "approved") {
    throw new Error(`expected approved, got ${result.status}`);
  }
  return result.connections;
}

// Fills the next getRandomValues call with zero bytes, which encode the code
// 00000000.
function zeroBytesOnce() {
  const spy = vi.spyOn(crypto, "getRandomValues");
  spy.mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
    if (array instanceof Uint8Array) {
      array.fill(0);
    }
    return array;
  });
  return spy;
}

describe("normalizeCode", () => {
  test.each([
    ["ABCD2345", "ABCD2345"],
    ["abcd2345", "ABCD2345"],
    ["abcd-2345", "ABCD2345"],
    ["  AbCd-2345\n", "ABCD2345"],
    ["\tabcd2345 ", "ABCD2345"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeCode(input)).toBe(expected);
  });

  test.each([
    ["too short", "ABCD234"],
    ["too long", "ABCD23456"],
    ["the hyphen elsewhere", "ABC-D2345"],
    ["two hyphens", "AB-CD-2345"],
    ["inner whitespace", "ABCD 2345"],
    ["I", "ABCD234I"],
    ["L", "ABCD234L"],
    ["O", "ABCD234O"],
    ["U", "ABCD234U"],
    ["empty", ""],
  ])("refuses %s", (_label, input) => {
    expect(normalizeCode(input)).toBeNull();
  });
});

describe("lockedUntil", () => {
  test("locks for LOCK_MS after the fifth wrong code in the window", () => {
    expect(lockedUntil([0, 1, 2, 3, 4].map((m) => m * MINUTE))).toBe(4 * MINUTE + LOCK_MS);
  });

  test("does not count a wrong code exactly one window old", () => {
    expect(lockedUntil([0, 10, 11, 12, 13].map((m) => m * MINUTE))).toBe(Number.NEGATIVE_INFINITY);
  });

  test("counts no wrong code entered before the end of an earlier lock", () => {
    const first = [0, 1, 2, 3, 4].map((m) => m * MINUTE);
    const after = [14, 15, 16, 17].map((m) => m * MINUTE);

    expect(lockedUntil([...first, ...after])).toBe(4 * MINUTE + LOCK_MS);
    expect(lockedUntil([...first, ...after, 18 * MINUTE])).toBe(18 * MINUTE + LOCK_MS);
  });
});

describe("startDeviceRequest", () => {
  // req-accounts-and-connections AC-6.1
  test("issues an 8-character code, a 32-byte secret, and a 10-minute expiry", async () => {
    const { base } = await setup();

    const started = await start(base);

    expect(started.code).toMatch(CODE_PATTERN);
    expect(started.deviceSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const decoded = atob(started.deviceSecret.replaceAll("-", "+").replaceAll("_", "/"));
    expect(decoded).toHaveLength(32);
    expect(started.expiresAt).toBe(START + 10 * MINUTE);
  });

  test("stores the code without a hyphen and the secret only as its SHA-256 hex", async () => {
    const { base } = await setup();

    const started = await start(base, ["cursor", "claude-code"], "  devbox ");

    const [row] = await requests(base);
    expect(row).toMatchObject({
      userCode: started.code,
      deviceSecretHash: await hashToken(started.deviceSecret),
      machineName: "devbox",
      harnesses: ["cursor", "claude-code"],
      status: "pending",
      expiresAt: START + 10 * MINUTE,
    });
    expect(row?.userId).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(started.deviceSecret);
  });

  test("issues codes from the alphabet that differ from every retained code", async () => {
    const { base } = await setup();

    const codes = [];
    for (let i = 0; i < 40; i++) {
      codes.push((await start(base)).code);
    }

    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(CODE_PATTERN);
      expect([...code].every((symbol) => CODE_ALPHABET.includes(symbol))).toBe(true);
    }
  });

  test("retries a code that a retained request holds", async () => {
    const { base } = await setup();
    zeroBytesOnce();
    const first = await start(base);
    expect(first.code).toBe("00000000");
    // The first request has expired, and its code is still not reused.
    at(11);

    const spy = zeroBytesOnce();
    const second = await start(base);

    expect(second.code).toMatch(CODE_PATTERN);
    expect(second.code).not.toBe("00000000");
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test.each([
    ["an empty list", []],
    ["a duplicate", ["codex", "codex"]],
    ["an unknown harness", ["codex", "windsurf"]],
    ["a display name", ["Claude Code"]],
  ])("refuses %s with invalid and stores nothing", async (_label, harnesses) => {
    const { base } = await setup();

    await expect(start(base, harnesses)).rejects.toMatchObject(invalid("harnesses"));

    expect(await requests(base)).toEqual([]);
  });

  test("refuses an empty machine name", async () => {
    const { base } = await setup();

    await expect(start(base, ["codex"], "  ")).rejects.toMatchObject(invalid("machineName"));
  });
});

describe("lookupDeviceRequest", () => {
  // req-accounts-and-connections AC-6.2
  test("returns the machine name and harnesses and connects nothing", async () => {
    const { base, a } = await setup();
    const { code } = await start(base, ["cursor", "codex"], "devbox");

    expect(await lookup(a, code)).toEqual({
      status: "found",
      machineName: "devbox",
      harnesses: ["cursor", "codex"],
    });

    expect(await credentials(base)).toEqual([]);
    expect((await requests(base))[0]?.status).toBe("pending");
    expect(await attempts(base)).toEqual([]);
  });

  test("accepts any letter case, the optional hyphen, and surrounding whitespace", async () => {
    const { base, a } = await setup();
    const { code } = await start(base);
    const typed = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()} `;

    expect((await lookup(a, typed)).status).toBe("found");
  });

  // req-accounts-and-connections AC-6.1
  test("returns expired from the expiry time on, without recording an attempt", async () => {
    const { base, a } = await setup();
    const { code } = await start(base);
    at(10, -1);
    expect((await lookup(a, code)).status).toBe("found");

    at(10);

    expect(await lookup(a, code)).toEqual({ status: "expired" });
    expect(await attempts(base)).toEqual([]);
  });

  test.each([
    ["a wrong code", WRONG_CODE],
    ["a malformed code", "not a code"],
  ])("returns not_found for %s and records an attempt", async (_label, code) => {
    const { base, a, userId } = await setup();
    await start(base);

    expect(await lookup(a, code)).toEqual({ status: "not_found" });

    expect(await attempts(base)).toMatchObject([{ userId, at: START }]);
  });
});

describe("approveDeviceRequest and declineDeviceRequest", () => {
  // req-accounts-and-connections AC-6.1
  test("approval assigns the account and is the code's first use", async () => {
    const { base, a, b, userId } = await setup();
    const { code } = await start(base);

    expect(await approve(a, code)).toEqual({ status: "approved" });

    expect((await requests(base))[0]).toMatchObject({ status: "approved", userId });
    expect(await lookup(a, code)).toEqual({ status: "not_found" });
    expect(await approve(b, code)).toEqual({ status: "not_found" });
    expect(await decline(a, code)).toEqual({ status: "not_found" });
    expect((await requests(base))[0]).toMatchObject({ status: "approved", userId });
    expect(await credentials(base)).toEqual([]);
  });

  // req-accounts-and-connections AC-6.6
  test("decline is the code's first use", async () => {
    const { base, a } = await setup();
    const { code } = await start(base);

    expect(await decline(a, code)).toEqual({ status: "declined" });

    expect((await requests(base))[0]?.status).toBe("declined");
    expect(await approve(a, code)).toEqual({ status: "not_found" });
    expect(await lookup(a, code)).toEqual({ status: "not_found" });
  });

  test.each([
    ["approve", approve],
    ["decline", decline],
  ])("%s refuses an expired code and leaves it pending", async (_label, act) => {
    const { base, a } = await setup();
    const { code } = await start(base);
    at(10);

    expect(await act(a, code)).toEqual({ status: "expired" });

    expect((await requests(base))[0]?.status).toBe("pending");
  });

  test("concurrent approvals from two accounts have one winner", async () => {
    const { base, a, b, userId, otherUserId } = await setup();
    const { code } = await start(base);

    const results = await Promise.all([approve(a, code), approve(b, code)]);

    expect(results.map((result) => result.status).sort()).toEqual(["approved", "not_found"]);
    const winner = results[0]?.status === "approved" ? userId : otherUserId;
    expect((await requests(base))[0]).toMatchObject({ status: "approved", userId: winner });
  });

  test("a concurrent approval and decline have one winner", async () => {
    const { base, a, b } = await setup();
    const { code } = await start(base);

    const results = await Promise.all([approve(a, code), decline(b, code)]);

    expect(results.filter((result) => result.status === "not_found")).toHaveLength(1);
  });
});

describe("app functions without an active account", () => {
  const calls = [
    ["lookupDeviceRequest", lookup],
    ["approveDeviceRequest", approve],
    ["declineDeviceRequest", decline],
  ] as const;

  test.each(calls)("%s refuses a call without a signed-in person", async (_label, call) => {
    const { base } = await setup();
    const { code } = await start(base);

    await expect(call(base as unknown as Client, code)).rejects.toMatchObject(unauthenticated);

    expect((await requests(base))[0]?.status).toBe("pending");
    expect(await attempts(base)).toEqual([]);
  });

  test.each(calls)("%s refuses an identity with no account", async (_label, call) => {
    const { base } = await setup();
    const { code } = await start(base);

    await expect(
      call(base.withIdentity({ subject: "user_c", email: "c@example.com" }), code),
    ).rejects.toMatchObject(unauthenticated);

    expect(await attempts(base)).toEqual([]);
  });

  test.each(calls)("%s refuses an account whose deletion has started", async (_label, call) => {
    const { base, a, userId } = await setup();
    const { code } = await start(base);
    await base.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START }));

    await expect(call(a, code)).rejects.toMatchObject(unauthenticated);

    expect((await requests(base))[0]?.status).toBe("pending");
    expect(await attempts(base)).toEqual([]);
  });
});

// req-accounts-and-connections AC-6.5
describe("code-entry lock", () => {
  async function wrongCodes(t: Client, minutes: number[]) {
    for (const minute of minutes) {
      at(minute);
      expect(await lookup(t, WRONG_CODE)).toEqual({ status: "not_found" });
    }
  }

  test("the fifth wrong code locks the account, including for a correct code", async () => {
    const { base, a } = await setup();
    const { code } = await start(base);

    await wrongCodes(a, [0, 0, 0, 0]);
    expect((await lookup(a, code)).status).toBe("found");
    await wrongCodes(a, [0]);

    expect(await attempts(base)).toHaveLength(5);
    expect(await lookup(a, code)).toEqual({ status: "locked" });
    expect(await approve(a, code)).toEqual({ status: "locked" });
    expect(await decline(a, code)).toEqual({ status: "locked" });
    expect(await lookup(a, WRONG_CODE)).toEqual({ status: "locked" });
    expect((await requests(base))[0]?.status).toBe("pending");
    // Refused entries record nothing.
    expect(await attempts(base)).toHaveLength(5);
  });

  test("wrong codes through approve and decline count toward the lock", async () => {
    const { base, a } = await setup();
    const { code } = await start(base);

    for (const act of [approve, decline, approve, decline, approve]) {
      expect(await act(a, WRONG_CODE)).toEqual({ status: "not_found" });
    }

    expect(await approve(a, code)).toEqual({ status: "locked" });
    expect((await requests(base))[0]?.status).toBe("pending");
  });

  test("a used code counts as a wrong code", async () => {
    const { base, a, b } = await setup();
    const { code } = await start(base);
    await approve(b, code);

    for (let i = 0; i < 5; i++) {
      expect(await lookup(a, code)).toEqual({ status: "not_found" });
    }

    expect(await lookup(a, WRONG_CODE)).toEqual({ status: "locked" });
  });

  test("the lock applies to one account only", async () => {
    const { base, a, b } = await setup();
    const { code } = await start(base);

    await wrongCodes(a, [0, 0, 0, 0, 0]);

    expect(await lookup(a, code)).toEqual({ status: "locked" });
    expect(await approve(b, code)).toEqual({ status: "approved" });
  });

  test("staggered wrong codes lock for 10 minutes after the fifth", async () => {
    const { base, a } = await setup();
    await wrongCodes(a, [0, 1, 2, 3, 4]);
    at(9);
    const { code } = await start(base);

    // The first wrong code has left the 10-minute window, and the lock holds.
    for (const minute of [10, 12, 13]) {
      at(minute);
      expect(await lookup(a, code)).toEqual({ status: "locked" });
      expect(await approve(a, code)).toEqual({ status: "locked" });
      expect(await decline(a, code)).toEqual({ status: "locked" });
    }
    at(14, -1);
    expect(await approve(a, code)).toEqual({ status: "locked" });

    at(14);
    expect(await approve(a, code)).toEqual({ status: "approved" });
  });

  test("entries during the lock do not extend it", async () => {
    const { base, a } = await setup();
    await wrongCodes(a, [0, 0, 0, 0, 0]);
    for (const minute of [2, 5, 9]) {
      at(minute);
      expect(await lookup(a, WRONG_CODE)).toEqual({ status: "locked" });
    }

    at(LOCK_MS / MINUTE);
    const { code } = await start(base);

    expect(await approve(a, code)).toEqual({ status: "approved" });
  });

  test("four wrong codes within the window do not lock", async () => {
    const { base, a } = await setup();
    await wrongCodes(a, [0, 10, 11, 12, 13]);
    const { code } = await start(base);

    expect((await lookup(a, code)).status).toBe("found");
  });
});

describe("collectDeviceRequest", () => {
  test("returns pending before approval and expired from the expiry on", async () => {
    const { base } = await setup();
    const { deviceSecret } = await start(base);

    expect(await collect(base, deviceSecret)).toEqual({ status: "pending" });
    at(10);
    expect(await collect(base, deviceSecret)).toEqual({ status: "expired" });
    expect((await requests(base))[0]?.status).toBe("pending");
  });

  test("returns not_found for an unknown secret", async () => {
    const { base } = await setup();
    await start(base);

    expect(await collect(base, "A".repeat(43))).toEqual({ status: "not_found" });
  });

  // req-accounts-and-connections AC-6.3, AC-6.4
  test("approval mints one connection per harness, returned exactly once", async () => {
    const { base, a, userId } = await setup();
    const { code, deviceSecret } = await start(base, ["codex", "claude-code", "cursor"], "devbox");
    await approve(a, code);

    const connections = approved(await collect(base, deviceSecret));

    expect(connections.map((connection) => connection.harness)).toEqual([
      "codex",
      "claude-code",
      "cursor",
    ]);
    const stored = await credentials(base);
    expect(stored).toHaveLength(3);
    for (const connection of connections) {
      expect(connection.token).toMatch(/^adc_/);
      const credential = stored.find((row) => row._id === connection.connection_id);
      expect(credential).toMatchObject({
        userId,
        kind: "connection_token",
        harness: connection.harness,
        machineName: "devbox",
        tokenHash: await hashToken(connection.token),
      });
      expect(JSON.stringify(credential)).not.toContain(connection.token);
      expect(
        await base.mutation(internal.identity.credentials.resolveToken, {
          tokenHash: await hashToken(connection.token),
        }),
      ).toMatchObject({ userId, credentialId: connection.connection_id });
    }
    expect(stored.map((row) => row.name)).toEqual(["Codex", "Claude Code", "Cursor"]);
    expect(new Set(connections.map((connection) => connection.token)).size).toBe(3);

    expect((await requests(base))[0]?.status).toBe("consumed");
    expect(await collect(base, deviceSecret)).toEqual({ status: "not_found" });
    expect(await credentials(base)).toHaveLength(3);
  });

  test("an approved request stays collectable after the code expires", async () => {
    const { base, a } = await setup();
    const { code, deviceSecret } = await start(base, ["codex"]);
    at(9);
    await approve(a, code);
    at(30);

    expect(approved(await collect(base, deviceSecret))).toHaveLength(1);
  });

  test("concurrent collections return one batch", async () => {
    const { base, a } = await setup();
    const { code, deviceSecret } = await start(base);
    await approve(a, code);

    const results = await Promise.all([collect(base, deviceSecret), collect(base, deviceSecret)]);

    expect(results.map((result) => result.status).sort()).toEqual(["approved", "not_found"]);
    expect(await credentials(base)).toHaveLength(2);
  });

  // req-accounts-and-connections AC-6.6
  test("a declined request returns declined once and mints nothing", async () => {
    const { base, a } = await setup();
    const { code, deviceSecret } = await start(base);
    await decline(a, code);

    expect(await collect(base, deviceSecret)).toEqual({ status: "declined" });

    expect((await requests(base))[0]?.status).toBe("consumed");
    expect(await collect(base, deviceSecret)).toEqual({ status: "not_found" });
    expect(await credentials(base)).toEqual([]);
  });

  test.each([
    [
      "deleting",
      (t: Base, userId: Id<"users">) =>
        t.run((ctx) => ctx.db.patch("users", userId, { deletingAt: START })),
    ],
    ["deleted", (t: Base, userId: Id<"users">) => t.run((ctx) => ctx.db.delete("users", userId))],
  ])("refuses an approving account that is %s and mints nothing", async (_label, remove) => {
    const { base, a, userId } = await setup();
    const { code, deviceSecret } = await start(base);
    await approve(a, code);
    await remove(base, userId);

    await expect(collect(base, deviceSecret)).rejects.toMatchObject(unauthenticated);

    expect(await credentials(base)).toEqual([]);
    expect((await requests(base))[0]?.status).toBe("approved");
  });
});

describe("purge", () => {
  function purge(t: Base) {
    return t.mutation(internal.identity.deviceRequests.purge, {});
  }

  test("deletes requests older than one day", async () => {
    const { base } = await setup();
    await start(base);
    const created = (await requests(base))[0]?._creationTime ?? 0;

    vi.setSystemTime(Math.floor(created) + REQUEST_RETENTION_MS);
    await purge(base);
    expect(await requests(base)).toHaveLength(1);

    vi.setSystemTime(Math.ceil(created) + REQUEST_RETENTION_MS + 1);
    await purge(base);
    expect(await requests(base)).toEqual([]);
  });

  test("deletes attempts older than the retention", async () => {
    const { base, a } = await setup();
    await lookup(a, WRONG_CODE);
    at(1);
    await lookup(a, WRONG_CODE);

    vi.setSystemTime(START + ATTEMPT_RETENTION_MS);
    await purge(base);
    expect(await attempts(base)).toHaveLength(2);

    vi.setSystemTime(START + ATTEMPT_RETENTION_MS + 1);
    await purge(base);
    expect((await attempts(base)).map((attempt) => attempt.at)).toEqual([START + MINUTE]);
  });

  test("keeps the attempts that a running lock needs", () => {
    expect(ATTEMPT_RETENTION_MS).toBe(20 * MINUTE);
  });
});
