import { defineTable } from "convex/server";
import { v } from "convex/values";

// The identity domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition). Only `users` exists so far;
// component-identity §Tables adds the credential and sign-in tables later.
export const tables = {
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    // Set when account deletion starts; the account can no longer act.
    deletingAt: v.optional(v.number()),
  }).index("by_clerk", ["clerkUserId"]),
};
