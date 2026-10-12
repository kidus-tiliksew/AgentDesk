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
  })
    .index("by_hash", ["tokenHash"])
    .index("by_user_kind", ["userId", "kind"])
    .index("by_user_oauth", ["userId", "oauthClientId"]),

  // One installer short-code sign-in request (component-identity §Short-code
  // sign-in). The request acts for no account until a person approves it.
  deviceRequests: defineTable({
    // The 8-character code without its display hyphen.
    userCode: v.string(),
    // SHA-256 hex of the installer's device secret; the plaintext is never stored.
    deviceSecretHash: v.string(),
    machineName: v.string(),
    // Harness ids from convex/identity/harnesses.ts, in the installer's order.
    harnesses: v.array(v.string()),
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
    .index("by_secret", ["deviceSecretHash"]),

  // One wrong code entered by an account, for the code-entry lock
  // (req-accounts-and-connections AC-6.5).
  codeAttempts: defineTable({
    userId: v.id("users"),
    at: v.number(),
  }).index("by_user_at", ["userId", "at"]),
};
