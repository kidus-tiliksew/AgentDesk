import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { insertConnectionToken, revokeCredential } from "./credentials";
import { endEphemeralConnection } from "./ephemeral";
import { type HarnessId, harnessName, isHarnessId, parseHarnesses } from "./harnesses";
import { INSTALL_KEY_PREFIX, mintToken } from "./tokens";

// component-identity §Install keys and §Enrollment (req-install-keys REQ-1,
// REQ-3; DEC-21). The app creates, lists, and revokes keys as the signed-in
// person. The installer enrolls a machine with a key through the gateway's
// `/device/enroll`, which calls `enroll` through `/svc/identity/enroll` and
// acts for no account until the key resolves.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// The bounds of req-install-keys AC-1.2 and AC-1.3.
export const LABEL_MAX = 64;
export const EXPIRY_DAYS_MIN = 1;
export const EXPIRY_DAYS_MAX = 90;
export const MACHINE_LIMIT_MIN = 1;
export const MACHINE_LIMIT_MAX = 100;
export const IDLE_LIMIT_MINUTES_MIN = 15;
export const IDLE_LIMIT_MINUTES_MAX = 24 * 60;
const MAX_MACHINE_NAME_LENGTH = 255;
const MACHINE_ID_BYTES = 16;

// What the app asks `createInstallKey` for.
export type InstallKeyInput = {
  label: string;
  harnesses: readonly unknown[];
  expiresInDays: number;
  machineLimit: number;
  ephemeral: boolean;
  idleLimitMinutes?: number;
};

// A validated key, ready to insert.
type InstallKeyFields = Pick<
  Doc<"installKeys">,
  "label" | "harnesses" | "ephemeral" | "idleLimitMinutes" | "machineLimit"
> & { expiresInDays: number };

// One listed key (req-install-keys AC-3.1). An explicit projection, so the
// key hash never reaches the client.
export type InstallKey = {
  installKeyId: Id<"installKeys">;
  label: string;
  harnesses: HarnessId[];
  createdAt: number;
  expiresAt: number;
  ephemeral: boolean;
  idleLimitMinutes?: number;
  machineLimit: number;
  machinesConnected: number;
  lastUsedAt?: number;
};

export type EnrolledConnection = {
  harness: HarnessId;
  connection_id: Id<"credentials">;
  token: string;
};

// What `enroll` answers. Every status but `enrolled` writes nothing.
export type EnrollResult =
  | { status: "unknown" }
  | { status: "revoked" }
  | { status: "expired" }
  | { status: "harness_not_allowed"; harness: HarnessId }
  | { status: "limit_reached" }
  | { status: "enrolled"; machineId: string; connections: EnrolledConnection[] };

function invalid(message: string, field: string): never {
  throw appError(errorCodeSchema.enum.invalid, message, field);
}

function integerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

// Validates a new key in field order and throws `invalid` naming the first
// failing field (AC-1.2, AC-1.3). The label is trimmed. The idle limit is
// required for an ephemeral key and refused for any other.
export function validateInstallKey(input: InstallKeyInput): InstallKeyFields {
  const label = input.label.trim();
  if (label.length < 1 || label.length > LABEL_MAX) {
    invalid(`label must be 1 to ${LABEL_MAX} characters`, "label");
  }
  const harnesses = parseHarnesses(input.harnesses);
  if (harnesses === null) {
    invalid("harnesses must be a non-empty list of distinct known harness ids", "harnesses");
  }
  if (!integerIn(input.expiresInDays, EXPIRY_DAYS_MIN, EXPIRY_DAYS_MAX)) {
    invalid(
      `expiresInDays must be an integer from ${EXPIRY_DAYS_MIN} to ${EXPIRY_DAYS_MAX}`,
      "expiresInDays",
    );
  }
  if (!integerIn(input.machineLimit, MACHINE_LIMIT_MIN, MACHINE_LIMIT_MAX)) {
    invalid(
      `machineLimit must be an integer from ${MACHINE_LIMIT_MIN} to ${MACHINE_LIMIT_MAX}`,
      "machineLimit",
    );
  }
  if (input.ephemeral) {
    if (
      input.idleLimitMinutes === undefined ||
      !integerIn(input.idleLimitMinutes, IDLE_LIMIT_MINUTES_MIN, IDLE_LIMIT_MINUTES_MAX)
    ) {
      invalid(
        `idleLimitMinutes must be an integer from ${IDLE_LIMIT_MINUTES_MIN} to ${IDLE_LIMIT_MINUTES_MAX}`,
        "idleLimitMinutes",
      );
    }
  } else if (input.idleLimitMinutes !== undefined) {
    invalid("idleLimitMinutes is set only for an ephemeral key", "idleLimitMinutes");
  }
  return {
    label,
    harnesses,
    expiresInDays: input.expiresInDays,
    machineLimit: input.machineLimit,
    ephemeral: input.ephemeral,
    ...(input.ephemeral ? { idleLimitMinutes: input.idleLimitMinutes } : {}),
  };
}

// Validates and inserts one key for `userId` and returns its plaintext
// secret, which the caller shows once (AC-1.1). Only the SHA-256 hex is
// stored. `createInstallKey` and the development mint share it.
export async function insertInstallKey(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  input: InstallKeyInput,
  now: number,
): Promise<{ installKeyId: Id<"installKeys">; secret: string }> {
  const { expiresInDays, ...fields } = validateInstallKey(input);
  const { plaintext, hash } = await mintToken(INSTALL_KEY_PREFIX);
  const installKeyId = await ctx.db.insert("installKeys", {
    userId,
    ...fields,
    keyHash: hash,
    expiresAt: now + expiresInDays * DAY,
  });
  return { installKeyId, secret: plaintext };
}

const installKeyArgs = {
  label: v.string(),
  harnesses: v.array(v.string()),
  expiresInDays: v.number(),
  machineLimit: v.number(),
  ephemeral: v.boolean(),
  idleLimitMinutes: v.optional(v.number()),
};

// Creates a key for the signed-in person. An invalid field throws `invalid`
// naming it and writes nothing.
export const createInstallKey = mutation({
  args: installKeyArgs,
  handler: async (ctx, args): Promise<{ installKeyId: Id<"installKeys">; secret: string }> => {
    const user = await requireUser(ctx);
    return await insertInstallKey(ctx, user._id, args, Date.now());
  },
});

// The unrevoked connections a key made.
async function activeConnections(
  ctx: Pick<QueryCtx, "db">,
  installKeyId: Id<"installKeys">,
): Promise<Doc<"credentials">[]> {
  return await ctx.db
    .query("credentials")
    .withIndex("by_install_key", (q) =>
      q.eq("installKeyId", installKeyId).eq("revokedAt", undefined),
    )
    .collect();
}

// The number of distinct machines among a key's unrevoked connections. One
// enrollment run is one machine however many harnesses it connected
// (AC-2.4), and a machine stops counting once all of its connections have
// ended (AC-4.3).
export async function machinesConnected(
  ctx: Pick<QueryCtx, "db">,
  installKeyId: Id<"installKeys">,
): Promise<number> {
  const machines = new Set<string>();
  for (const credential of await activeConnections(ctx, installKeyId)) {
    machines.add(credential.machineId ?? credential._id);
  }
  return machines.size;
}

// Stored harness ids were validated on creation.
function storedHarnesses(key: Doc<"installKeys">): HarnessId[] {
  return key.harnesses.map((harness) => {
    if (!isHarnessId(harness)) {
      throw new Error(`Stored install key holds unknown harness ${harness}`);
    }
    return harness;
  });
}

async function toInstallKey(
  ctx: Pick<QueryCtx, "db">,
  key: Doc<"installKeys">,
): Promise<InstallKey> {
  const listed: InstallKey = {
    installKeyId: key._id,
    label: key.label,
    harnesses: storedHarnesses(key),
    createdAt: key._creationTime,
    expiresAt: key.expiresAt,
    ephemeral: key.ephemeral,
    machineLimit: key.machineLimit,
    machinesConnected: await machinesConnected(ctx, key._id),
  };
  if (key.idleLimitMinutes !== undefined) {
    listed.idleLimitMinutes = key.idleLimitMinutes;
  }
  if (key.lastUsedAt !== undefined) {
    listed.lastUsedAt = key.lastUsedAt;
  }
  return listed;
}

// The signed-in person's keys without `revokedAt`, newest first (AC-3.1). An
// expired key stays listed until revoked; the app shows it as expired. The
// query is reactive, so `machinesConnected` follows enrollments and ended
// connections.
export const listInstallKeys = query({
  args: {},
  handler: async (ctx): Promise<InstallKey[]> => {
    const user = await requireUser(ctx);
    const keys = await ctx.db
      .query("installKeys")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();
    const listed: InstallKey[] = [];
    for (const key of keys) {
      if (key.revokedAt === undefined) {
        listed.push(await toInstallKey(ctx, key));
      }
    }
    return listed;
  },
});

// Revokes one of the signed-in person's keys, so its next enrollment is
// refused (AC-3.2). With `revokeConnections`, every unrevoked connection the
// key made is revoked in the same transaction: through endEphemeralConnection
// for an ephemeral key, which also ends its sessions and cancels their
// pending decisions, and through revokeCredential otherwise. Without it, the
// key's connections keep working. The id is validated in the handler, so an
// omitted, malformed, missing, or foreign id answers `not_found` and writes
// nothing (req-accounts-and-connections AC-1.1). A second revoke keeps the
// first `revokedAt`.
export const revokeInstallKey = mutation({
  args: { installKeyId: v.optional(v.any()), revokeConnections: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const user = await requireUser(ctx);
    const raw: unknown = args.installKeyId;
    const installKeyId = typeof raw === "string" ? ctx.db.normalizeId("installKeys", raw) : null;
    const key =
      installKeyId === null ? null : await getOwned(ctx, "installKeys", installKeyId, user._id);
    if (key === null) {
      throw appError(errorCodeSchema.enum.not_found, "Install key not found");
    }
    if (key.revokedAt === undefined) {
      await ctx.db.patch("installKeys", key._id, { revokedAt: now });
    }
    if (args.revokeConnections) {
      for (const credential of await activeConnections(ctx, key._id)) {
        if (key.ephemeral) {
          await endEphemeralConnection(ctx, credential, now);
        } else {
          await revokeCredential(ctx, user._id, credential._id);
        }
      }
    }
    return null;
  },
});

// One 16-byte machine id in lowercase hex, shared by every connection of one
// enrollment run.
function newMachineId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(MACHINE_ID_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Enrolls one machine with an install key (§Enrollment; req-install-keys
// REQ-2). The key is read through `by_hash`, the request is checked against
// it, and the connections are minted in this one transaction. The key's
// connections are read through `by_install_key` in the same transaction, so
// Convex serializes concurrent enrollments on one key and two runs cannot
// both take its last machine. Every status but `enrolled` writes nothing, so
// a refused run connects nothing (AC-2.2). The plaintext tokens are returned
// once, in the request's harness order.
export const enroll = internalMutation({
  args: { keyHash: v.string(), machineName: v.string(), harnesses: v.array(v.string()) },
  handler: async (ctx, args): Promise<EnrollResult> => {
    const now = Date.now();
    const key = await ctx.db
      .query("installKeys")
      .withIndex("by_hash", (q) => q.eq("keyHash", args.keyHash))
      .unique();
    if (key === null) {
      return { status: "unknown" };
    }
    if (key.revokedAt !== undefined) {
      return { status: "revoked" };
    }
    if (key.expiresAt <= now) {
      return { status: "expired" };
    }
    const owner = await ctx.db.get("users", key.userId);
    if (owner === null || owner.deletingAt !== undefined) {
      throw appError(errorCodeSchema.enum.unauthenticated, "Install key owner is not active");
    }

    const machineName = args.machineName.trim();
    if (machineName === "" || machineName.length > MAX_MACHINE_NAME_LENGTH) {
      invalid(`machineName must be 1 to ${MAX_MACHINE_NAME_LENGTH} characters`, "machineName");
    }
    const harnesses = parseHarnesses(args.harnesses);
    if (harnesses === null) {
      invalid("harnesses must be a non-empty list of distinct known harness ids", "harnesses");
    }
    const allowed = new Set<string>(key.harnesses);
    const refused = harnesses.find((harness) => !allowed.has(harness));
    if (refused !== undefined) {
      return { status: "harness_not_allowed", harness: refused };
    }
    if ((await machinesConnected(ctx, key._id)) >= key.machineLimit) {
      return { status: "limit_reached" };
    }

    const machineId = newMachineId();
    const idle =
      key.ephemeral && key.idleLimitMinutes !== undefined
        ? { idleDeadlineAt: now + key.idleLimitMinutes * MINUTE }
        : {};
    const connections: EnrolledConnection[] = [];
    for (const harness of harnesses) {
      const { plaintext, credentialId } = await insertConnectionToken(ctx, {
        userId: key.userId,
        harness,
        name: harnessName(harness),
        machineName,
        installKeyId: key._id,
        machineId,
        ...idle,
      });
      connections.push({ harness, connection_id: credentialId, token: plaintext });
    }
    await ctx.db.patch("installKeys", key._id, { lastUsedAt: now });
    return { status: "enrolled", machineId, connections };
  },
});
