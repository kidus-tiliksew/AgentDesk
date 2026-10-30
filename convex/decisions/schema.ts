import { defineTable } from "convex/server";
import { v } from "convex/values";

// The decisions domain's tables, spread into convex/schema.ts
// (component-backend-foundation §Composition; component-decisions §Table).

// The contract's input types, mirrored from inputTypeSchema in
// @agentdesk/contract.
export const inputTypeValidator = v.union(
  v.literal("approve_reject"),
  v.literal("single_choice"),
  v.literal("multiple_choice"),
  v.literal("free_text"),
  v.literal("single_choice_or_text"),
);

// The contract's answer payload, stored in its wire shape so reads pass it
// through unchanged. The contract validates every answer before it is stored.
export const answerValidator = v.union(
  v.object({ kind: v.literal("approve") }),
  v.object({ kind: v.literal("reject") }),
  v.object({ kind: v.literal("option"), option_id: v.string() }),
  v.object({ kind: v.literal("options"), option_ids: v.array(v.string()) }),
  v.object({ kind: v.literal("text"), text: v.string() }),
);

export const decisionStateValidator = v.union(
  v.literal("pending"),
  v.literal("answered"),
  v.literal("expired"),
  v.literal("cancelled"),
);

export const answeredViaValidator = v.union(
  v.literal("app"),
  v.literal("notification"),
  v.literal("api"),
  v.literal("chat"),
  v.literal("default"),
);

export const cancelReasonValidator = v.literal("connection_ended");

export const tables = {
  decisions: defineTable({
    userId: v.id("users"),
    // The asking session. The daily purge may delete it later, so readers
    // never require it to exist (component-agent-presence §Sweep;
    // req-decision-requests REQ-7).
    agentSessionId: v.id("agentSessions"),
    topic: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    inputType: inputTypeValidator,
    options: v.optional(v.array(v.object({ id: v.string(), label: v.string() }))),
    recommendation: v.optional(answerValidator),
    priority: v.union(v.literal("normal"), v.literal("urgent")),
    // Absent on rows created before the field existed; reads treat absent as
    // false (req-agent-tools AC-10.1).
    interactive: v.optional(v.boolean()),
    // Epoch milliseconds.
    deadline: v.optional(v.number()),
    default: v.optional(answerValidator),
    expiryJobId: v.optional(v.id("_scheduled_functions")),
    state: decisionStateValidator,
    // Set on settlement.
    answer: v.optional(answerValidator),
    note: v.optional(v.string()),
    answeredAt: v.optional(v.number()),
    answeredVia: v.optional(answeredViaValidator),
    appliedByDefault: v.optional(v.boolean()),
    // Set only by a relayed answer: the user's chat message as received and
    // the relaying session, which the daily purge may delete later
    // (component-decisions §Relayed answers; req-decision-requests AC-8.1).
    chatMessage: v.optional(v.string()),
    relayedByAgentSessionId: v.optional(v.id("agentSessions")),
    parentId: v.optional(v.id("decisions")),
    idempotencyKey: v.optional(v.string()),
    // Title, body, option labels, and once settled the answer text or
    // selected option labels, then the note or the chat message, joined for
    // history search.
    searchText: v.string(),
    // The time the state left `pending`.
    settledAt: v.optional(v.number()),
    // Set only on a decision cancelled because its agent's ephemeral
    // connection ended (§State machine; req-install-keys AC-4.2). The app
    // reads it; the contract's Decision does not carry it.
    cancelReason: v.optional(cancelReasonValidator),
  })
    // The public API's list without a state filter, newest created first.
    .index("by_user", ["userId"])
    .index("by_user_state", ["userId", "state"])
    .index("by_user_idem", ["userId", "idempotencyKey"])
    .index("by_parent", ["parentId"])
    .index("by_agent_state", ["agentSessionId", "state"])
    // History with no search text: settled decisions, newest settled first.
    // Pending rows carry no `settledAt`, so `settledAt > 0` skips them.
    .index("by_user_settled", ["userId", "settledAt"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["userId", "state"] }),
};
