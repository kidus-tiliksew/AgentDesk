import { defineTable } from "convex/server";
import { v } from "convex/values";

// The identity domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition; component-identity §Tables).
export const tables = {
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    // Set when account deletion starts; the account can no longer act.
    deletingAt: v.optional(v.number()),
  }).index("by_clerk", ["clerkUserId"]),

  // Every credential an agent or client presents (component-identity
  // §Credentials). Fields that only one kind uses are optional.
  credentials: defineTable({
    userId: v.id("users"),
    kind: v.union(
      v.literal("connection_token"),
      v.literal("connection_oauth"),
      v.literal("api_token"),
    ),
    // SHA-256 hex of the plaintext token; the plaintext is never stored.
    tokenHash: v.string(),
    oauthClientId: v.optional(v.string()),
    name: v.optional(v.string()),
    harness: v.optional(v.string()),
    machineName: v.optional(v.string()),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Set only on a connection minted by install-key enrollment
    // (§Enrollment): the key, and the one machine id an enrollment run gives
    // all of its connections.
    installKeyId: v.optional(v.id("installKeys")),
    machineId: v.optional(v.string()),
    // Set only on a connection of an ephemeral key, and cleared when it ends:
    // the sweep ends the connection once this time passes (§Ending a
    // connection).
    idleDeadlineAt: v.optional(v.number()),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_user_kind", ["userId", "kind"])
    .index("by_user_oauth", ["userId", "oauthClientId"])
    .index("by_install_key", ["installKeyId", "revokedAt"])
    .index("by_idle_deadline", ["idleDeadlineAt"]),

  // One install key (component-identity §Install keys; req-install-keys
  // REQ-1). Enrollment with the key mints connection tokens without a
  // short-code approval.
  installKeys: defineTable({
    userId: v.id("users"),
    label: v.string(),
    // SHA-256 hex of the `adk_` secret; the plaintext is never stored.
    keyHash: v.string(),
    // Harness ids from convex/identity/harnesses.ts the key may connect.
    harnesses: v.array(v.string()),
    ephemeral: v.boolean(),
    // Set only when `ephemeral`.
    idleLimitMinutes: v.optional(v.number()),
    machineLimit: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["keyHash"])
    .index("by_user", ["userId"]),

  // One short-code sign-in request from the installer or the Mac app
  // (component-identity §Short-code sign-in). The request acts for no account
  // until a person approves it.
  deviceRequests: defineTable({
    // The 8-character code without its display hyphen.
    userCode: v.string(),
    // SHA-256 hex of the requester's device secret; the plaintext is never stored.
    deviceSecretHash: v.string(),
    machineName: v.string(),
    // Harness ids from convex/identity/harnesses.ts, in the installer's order;
    // empty for a Mac request.
    harnesses: v.array(v.string()),
    // Set for a Mac request, which collects one API token instead of
    // connection tokens.
    client: v.optional(v.literal("macos")),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("consumed"),
    ),
    // The approving account, set on approval.
    userId: v.optional(v.id("users")),
    expiresAt: v.number(),
  })
    .index("by_code", ["userCode"])
    .index("by_secret", ["deviceSecretHash"])
    // Account deletion finds the requests an account approved.
    .index("by_user", ["userId"]),

  // One wrong code entered by an account, for the code-entry lock
  // (req-accounts-and-connections AC-6.5).
  codeAttempts: defineTable({
    userId: v.id("users"),
    at: v.number(),
  }).index("by_user_at", ["userId", "at"]),

  // One account deletion (component-identity §Account deletion). It drives
  // the purge and the Clerk deletion, and it outlives the `users` row, so the
  // Clerk subject cannot create a new account: while the Clerk deletion is
  // retried, and for REFUSAL_WINDOW_MS after both steps finish. It holds no
  // email, token, decision, or device data.
  accountDeletions: defineTable({
    userId: v.id("users"),
    clerkUserId: v.string(),
    // The `users.deletingAt` the deletion started at; the purge finishes by
    // `startedAt` plus 24 hours.
    startedAt: v.number(),
    // The purge's current phase. `verify` re-checks every domain before the
    // `users` row is deleted.
    phase: v.union(
      v.literal("decisions"),
      v.literal("agents"),
      v.literal("notifications"),
      v.literal("identity"),
      v.literal("verify"),
    ),
    // The purge chain's current batch number. A batch whose number is not
    // the current one does nothing, so a duplicate or superseded chain stops.
    generation: v.number(),
    // The time of the latest purge or Clerk progress; recovery restarts a
    // deletion whose `updatedAt` is stale.
    updatedAt: v.number(),
    // How many times recovery restarted a stalled purge.
    restarts: v.number(),
    // Set when the purge has deleted the `users` row.
    purgedAt: v.optional(v.number()),
    // Set when the deletion first ran past its 24-hour deadline unfinished.
    overdueAt: v.optional(v.number()),
    // Set once both the purge and the Clerk deletion are done: the record
    // keeps refusing the Clerk subject until then, because a Convex token
    // Clerk issued before the deletion still authenticates until it expires.
    refuseUntil: v.optional(v.number()),
    clerk: v.object({
      state: v.union(v.literal("pending"), v.literal("done")),
      // The current attempt number. An outcome for another attempt is ignored.
      attempt: v.number(),
      // When the current attempt is due.
      nextAttemptAt: v.number(),
      // A short failure code such as `network`, `http_503`, or
      // `missing_secret`; never a response body or a credential.
      lastError: v.optional(v.string()),
      doneAt: v.optional(v.number()),
    }),
  })
    .index("by_clerk", ["clerkUserId"])
    // Recovery reads deletions still running: no `refuseUntil` yet.
    .index("by_refuse_updated", ["refuseUntil", "updatedAt"])
    .index("by_refuse_until", ["refuseUntil"]),
};
