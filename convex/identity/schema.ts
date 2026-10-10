import { defineTable } from "convex/server";
import { v } from "convex/values";

// The identity domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition). component-identity §Tables adds
// the short-code sign-in tables, deviceRequests and codeAttempts, in Phase 3.
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
};
