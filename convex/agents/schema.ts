import { defineTable } from "convex/server";
import { v } from "convex/values";

// The agents domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition; component-agent-presence §Tables).

// The four status states of req-agent-status AC-1.3, mirrored from
// statusStateSchema in @agentdesk/contract.
export const statusStateValidator = v.union(
  v.literal("working"),
  v.literal("waiting"),
  v.literal("blocked"),
  v.literal("done"),
);

export const tables = {
  // One row per MCP session. `open` inserts it with only the initialization
  // fields; the first `touch` sets `activatedAt` and `topic`, and `status`
  // sets the current status fields (component-agent-presence §Lifecycle).
  agentSessions: defineTable({
    userId: v.id("users"),
    credentialId: v.id("credentials"),
    // 32 random bytes as 64 lowercase hex characters.
    mcpSessionId: v.string(),
    clientName: v.string(),
    clientVersion: v.string(),
    displayName: v.optional(v.string()),
    topic: v.optional(v.string()),
    state: v.optional(statusStateValidator),
    line: v.optional(v.string()),
    link: v.optional(v.string()),
    statusAt: v.optional(v.number()),
    // Set on the first tool call; a session without it appears on no card
    // (req-agent-status REQ-2).
    activatedAt: v.optional(v.number()),
    lastActivityAt: v.number(),
    staleSince: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.union(v.literal("done"), v.literal("idle"))),
  })
    .index("by_mcp", ["mcpSessionId"])
    .index("by_user_ended", ["userId", "endedAt"])
    .index("by_activity", ["lastActivityAt"]),

  // Previous statuses of a session, at most 20 per session
  // (req-agent-status AC-1.1, AC-1.2).
  statusHistory: defineTable({
    agentSessionId: v.id("agentSessions"),
    state: statusStateValidator,
    line: v.string(),
    link: v.optional(v.string()),
    at: v.number(),
  }).index("by_session_at", ["agentSessionId", "at"]),
};
