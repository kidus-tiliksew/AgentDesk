import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, mutation } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { type ClientId, MAC_CLIENT, MAC_CLIENT_NAME } from "./clients";
import { insertApiToken, insertConnectionToken } from "./credentials";
import { type HarnessId, harnessName, isHarnessId, parseHarnesses } from "./harnesses";
import { hashToken } from "./tokens";

// component-identity §Short-code sign-in (req-accounts-and-connections REQ-6;
// req-mac-app REQ-2). The installer or the Mac app starts a request and polls
// for it through the gateway's service routes, which act for no account. The
// person enters the code in the app, which calls the public mutations below as
// the signed-in account. An installer request lists harnesses and collects one
// connection token per harness; a Mac request names the client `macos` and
// collects one API token.

const MINUTE = 60_000;

// The code alphabet omits I, L, O, and U (AC-6.1). Its 32 symbols let each
// random byte pick one symbol without bias.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;
// A pending request expires 10 minutes after issue (AC-6.1).
export const REQUEST_TTL_MS = 10 * MINUTE;
const DEVICE_SECRET_BYTES = 32;
// Code generation retries a collision with any retained request this many
// times. With 32^8 codes a retry is already rare.
const MAX_CODE_TRIES = 10;
const MAX_MACHINE_NAME_LENGTH = 255;

// The code-entry lock (AC-6.5): the fifth wrong code within a sliding
// 10-minute window locks code entry for the account for 10 minutes after that
// fifth wrong code.
export const MAX_WRONG_CODES = 5;
export const ATTEMPT_WINDOW_MS = 10 * MINUTE;
export const LOCK_MS = 10 * MINUTE;
// Attempts are kept for the window plus the lock, so the four wrong codes
// before a fifth remain readable for the whole lock it starts.
export const ATTEMPT_RETENTION_MS = ATTEMPT_WINDOW_MS + LOCK_MS;
// The daily purge deletes requests older than one day.
export const REQUEST_RETENTION_MS = 24 * 60 * MINUTE;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export type StartResult = { code: string; deviceSecret: string; expiresAt: number };

// A code entry the app shows a distinct state for. `not_found` covers a wrong,
// malformed, or already used code.
export type CodeRefusal = { status: "not_found" } | { status: "expired" } | { status: "locked" };
// `harnesses` is empty and `client` is set for a Mac request.
export type LookupResult =
  | { status: "found"; machineName: string; harnesses: HarnessId[]; client?: ClientId }
  | CodeRefusal;
export type ApproveResult = { status: "approved" } | CodeRefusal;
export type DeclineResult = { status: "declined" } | CodeRefusal;

export type CollectedConnection = {
  harness: HarnessId;
  connection_id: Id<"credentials">;
  token: string;
};
export type CollectedApiToken = {
  credential_id: Id<"credentials">;
  token: string;
};
export type CollectResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "declined" }
  | { status: "not_found" }
  | { status: "approved"; connections: CollectedConnection[] }
  | { status: "approved"; api_token: CollectedApiToken };

// Returns the stored form of a code the person typed: surrounding whitespace
// removed, upper case, and the optional hyphen of `XXXX-XXXX` removed. Returns
// null when the result is not 8 symbols of the code alphabet.
export function normalizeCode(input: string): string | null {
  const upper = input.trim().toUpperCase();
  const half = CODE_LENGTH / 2;
  const code =
    upper.length === CODE_LENGTH + 1 && upper[half] === "-"
      ? upper.slice(0, half) + upper.slice(half + 1)
      : upper;
  return CODE_PATTERN.test(code) ? code : null;
}

// Returns the end of the code-entry lock that a list of wrong-code times
// produces, or -Infinity when they produce none. `times` is ascending. Each
// wrong code counts the wrong codes before it in the sliding window that were
// not entered before the end of an earlier lock; the fifth starts a lock that
// clears the window. Entries during a lock are refused without being
// recorded, so they never extend it.
export function lockedUntil(times: readonly number[]): number {
  let until = Number.NEGATIVE_INFINITY;
  let window: number[] = [];
  for (const at of times) {
    if (at < until) {
      continue;
    }
    window = window.filter((earlier) => earlier > at - ATTEMPT_WINDOW_MS && earlier >= until);
    window.push(at);
    if (window.length >= MAX_WRONG_CODES) {
      until = at + LOCK_MS;
      window = [];
    }
  }
  return until;
}

// What a request connects: the installer's harnesses, or the Mac client.
type Requester = { harnesses: HarnessId[] } | { client: ClientId };

// Returns what a start names, or throws `invalid`. A request names exactly one
// of `harnesses` and `client`. Any `client` together with `harnesses`, and any
// `client` other than `macos`, is refused naming `client`. Without `client`,
// the harness list is checked as before, so a start that names neither is
// refused naming `harnesses`.
function parseRequester(args: { harnesses?: readonly unknown[]; client?: unknown }): Requester {
  if (args.client !== undefined) {
    if (args.harnesses !== undefined || args.client !== MAC_CLIENT) {
      throw appError(
        errorCodeSchema.enum.invalid,
        `Client must be ${MAC_CLIENT}, without harnesses`,
        "client",
      );
    }
    return { client: MAC_CLIENT };
  }
  const harnesses = args.harnesses === undefined ? null : parseHarnesses(args.harnesses);
  if (harnesses === null) {
    throw appError(
      errorCodeSchema.enum.invalid,
      "Harnesses must be a non-empty list of distinct known harness ids",
      "harnesses",
    );
  }
  return { harnesses };
}

// The installer or the Mac app starts a request (AC-6.1; req-mac-app AC-2.1).
// The request belongs to no account. A new code differs from every retained
// request's code, so a lookup of an expired code is unambiguous and no two
// unexpired pending requests share one.
export const startDeviceRequest = internalMutation({
  args: {
    machineName: v.string(),
    harnesses: v.optional(v.array(v.string())),
    client: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<StartResult> => {
    const now = Date.now();
    const machineName = args.machineName.trim();
    if (machineName === "" || machineName.length > MAX_MACHINE_NAME_LENGTH) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid machine name", "machineName");
    }
    const requester = parseRequester(args);

    const code = await unusedCode(ctx);
    const deviceSecret = base64url(crypto.getRandomValues(new Uint8Array(DEVICE_SECRET_BYTES)));
    const expiresAt = now + REQUEST_TTL_MS;
    await ctx.db.insert("deviceRequests", {
      userCode: code,
      deviceSecretHash: await hashToken(deviceSecret),
      machineName,
      ...("client" in requester
        ? { harnesses: [], client: requester.client }
        : { harnesses: requester.harnesses }),
      status: "pending",
      expiresAt,
    });
    return { code, deviceSecret, expiresAt };
  },
});

// The app shows the requesting machine and harnesses, or that AgentDesk for
// Mac will connect, for a pending code and connects nothing (AC-6.2;
// req-mac-app AC-2.2).
export const lookupDeviceRequest = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<LookupResult> => {
    const now = Date.now();
    const user = await requireUser(ctx);
    const entry = await enterCode(ctx, user._id, code, now);
    if (entry.status !== "pending") {
      return entry;
    }
    const { request } = entry;
    const found: Extract<LookupResult, { status: "found" }> = {
      status: "found",
      machineName: request.machineName,
      harnesses: storedHarnesses(request),
    };
    if (request.client !== undefined) {
      found.client = request.client;
    }
    return found;
  },
});

// Approval is the code's first use (AC-6.1). The requester's next collection
// mints the credentials for the approving account.
export const approveDeviceRequest = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<ApproveResult> => {
    const now = Date.now();
    const user = await requireUser(ctx);
    const entry = await enterCode(ctx, user._id, code, now);
    if (entry.status !== "pending") {
      return entry;
    }
    await ctx.db.patch("deviceRequests", entry.request._id, {
      status: "approved",
      userId: user._id,
    });
    return { status: "approved" };
  },
});

// Decline is the code's first use (AC-6.1, AC-6.6).
export const declineDeviceRequest = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<DeclineResult> => {
    const now = Date.now();
    const user = await requireUser(ctx);
    const entry = await enterCode(ctx, user._id, code, now);
    if (entry.status !== "pending") {
      return entry;
    }
    await ctx.db.patch("deviceRequests", entry.request._id, { status: "declined" });
    return { status: "declined" };
  },
});

// The installer or the Mac app collects its request. An approved installer
// request mints one connection token per harness, and an approved Mac request
// mints one API token, for the approving account. The request is consumed in
// the same mutation, so the plaintext tokens are returned exactly once
// (DEC-6; AC-6.3, AC-6.4; req-mac-app AC-2.3). An approved or declined request stays collectable
// after the code's expiry until it is consumed or purged; expiry governs only
// a pending request.
export const collectDeviceRequest = internalMutation({
  args: { deviceSecret: v.string() },
  handler: async (ctx, { deviceSecret }): Promise<CollectResult> => {
    const now = Date.now();
    const deviceSecretHash = await hashToken(deviceSecret);
    const request = await ctx.db
      .query("deviceRequests")
      .withIndex("by_secret", (q) => q.eq("deviceSecretHash", deviceSecretHash))
      .first();
    if (request === null || request.status === "consumed") {
      return { status: "not_found" };
    }
    if (request.status === "pending") {
      return now >= request.expiresAt ? { status: "expired" } : { status: "pending" };
    }
    if (request.status === "declined") {
      await ctx.db.patch("deviceRequests", request._id, { status: "consumed" });
      return { status: "declined" };
    }

    const user = request.userId === undefined ? null : await ctx.db.get("users", request.userId);
    if (user === null || user.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Approving account is not active");
    }
    if (request.client === MAC_CLIENT) {
      const { plaintext, credentialId } = await insertApiToken(ctx, {
        userId: user._id,
        name: MAC_CLIENT_NAME,
        harness: MAC_CLIENT,
        machineName: request.machineName,
      });
      await ctx.db.patch("deviceRequests", request._id, { status: "consumed" });
      return { status: "approved", api_token: { credential_id: credentialId, token: plaintext } };
    }
    const connections: CollectedConnection[] = [];
    for (const harness of storedHarnesses(request)) {
      const { plaintext, credentialId } = await insertConnectionToken(ctx, {
        userId: user._id,
        harness,
        name: harnessName(harness),
        machineName: request.machineName,
      });
      connections.push({ harness, connection_id: credentialId, token: plaintext });
    }
    await ctx.db.patch("deviceRequests", request._id, { status: "consumed" });
    return { status: "approved", connections };
  },
});

// The daily purge, run at 03:10 UTC from convex/crons.ts.
export const purge = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();
    const requests = await ctx.db
      .query("deviceRequests")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", now - REQUEST_RETENTION_MS))
      .collect();
    for (const request of requests) {
      await ctx.db.delete("deviceRequests", request._id);
    }
    // No index covers `at` alone, so the daily run scans the attempts.
    const attempts = await ctx.db
      .query("codeAttempts")
      .filter((q) => q.lt(q.field("at"), now - ATTEMPT_RETENTION_MS))
      .collect();
    for (const attempt of attempts) {
      await ctx.db.delete("codeAttempts", attempt._id);
    }
  },
});

type CodeEntry = CodeRefusal | { status: "pending"; request: Doc<"deviceRequests"> };

// The code entry shared by lookup, approval, and decline, so none of them can
// bypass the lock (AC-6.5). A wrong code records an attempt and returns
// not_found instead of throwing, because a thrown error would roll the attempt
// back. A code already approved, declined, or consumed is wrong: it never
// reveals that another account used it.
async function enterCode(
  ctx: MutationCtx,
  userId: Id<"users">,
  input: string,
  now: number,
): Promise<CodeEntry> {
  if (await codeEntryLocked(ctx, userId, now)) {
    return { status: "locked" };
  }
  const code = normalizeCode(input);
  const request = code === null ? null : await findByCode(ctx, code);
  if (request === null || request.status !== "pending") {
    await ctx.db.insert("codeAttempts", { userId, at: now });
    return { status: "not_found" };
  }
  if (now >= request.expiresAt) {
    return { status: "expired" };
  }
  return { status: "pending", request };
}

async function codeEntryLocked(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  now: number,
): Promise<boolean> {
  const attempts = await ctx.db
    .query("codeAttempts")
    .withIndex("by_user_at", (q) => q.eq("userId", userId).gt("at", now - ATTEMPT_RETENTION_MS))
    .collect();
  return now < lockedUntil(attempts.map((attempt) => attempt.at));
}

function findByCode(ctx: Pick<MutationCtx, "db">, code: string) {
  return ctx.db
    .query("deviceRequests")
    .withIndex("by_code", (q) => q.eq("userCode", code))
    .first();
}

async function unusedCode(ctx: Pick<MutationCtx, "db">): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_TRIES; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    const code = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    if ((await findByCode(ctx, code)) === null) {
      return code;
    }
  }
  throw new Error("No unused sign-in code after retries");
}

// Stored harness ids were validated by startDeviceRequest.
function storedHarnesses(request: Doc<"deviceRequests">): HarnessId[] {
  return request.harnesses.map((harness) => {
    if (!isHarnessId(harness)) {
      throw new Error(`Stored request holds unknown harness ${harness}`);
    }
    return harness;
  });
}

// The device secret is unprefixed base64url, unlike a connection token.
function base64url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
