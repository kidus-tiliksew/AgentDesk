import { errorCodeSchema, normalizeTopic } from "@agentdesk/contract";
import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { PRIORITIES, RULE_ACTIONS, RULE_EVENT_KINDS } from "./schema";

// component-notifications §Rules: the signed-in person's notification rules.
// The app calls Convex as that person (DEC-3, DEC-7), so each function
// resolves the account with requireUser before reading any row and takes no
// user id from the client. `route` reads the rules at routing time, so a saved
// rule governs every later event (req-notification-rules AC-1.1).

type RuleEventKind = (typeof RULE_EVENT_KINDS)[number];
type RuleAction = (typeof RULE_ACTIONS)[number];
type Priority = (typeof PRIORITIES)[number];

// A rule as the app reads it. The contract has no rule read shape, so this
// module defines one in the contract's style: an absent match field is null
// and `updated_at` is an ISO 8601 string.
export type NotificationRule = {
  id: string;
  topic: string | null;
  agent_session_id: string | null;
  event_kind: RuleEventKind | null;
  priority: Priority | null;
  action: RuleAction;
  updated_at: string;
};

const RULE_NOT_FOUND = "Notification rule not found";
const SESSION_NOT_FOUND = "Agent session not found";

function invalid(field: string, message = `Invalid ${field}`): never {
  throw appError(errorCodeSchema.enum.invalid, message, field);
}

function oneOf<T extends string>(values: readonly T[], raw: string, field: string): T {
  if (!(values as readonly string[]).includes(raw)) {
    invalid(field);
  }
  return raw as T;
}

function parseId<Table extends "rules" | "agentSessions">(
  ctx: Pick<QueryCtx, "db">,
  table: Table,
  raw: string,
  field: string,
): Id<Table> {
  const id = ctx.db.normalizeId(table, raw);
  if (id === null) {
    invalid(field);
  }
  return id;
}

function toNotificationRule(rule: Doc<"rules">): NotificationRule {
  return {
    id: rule._id,
    topic: rule.topic ?? null,
    agent_session_id: rule.agentSessionId ?? null,
    event_kind: rule.eventKind ?? null,
    priority: rule.priority ?? null,
    action: rule.action,
    updated_at: new Date(rule.updatedAt).toISOString(),
  };
}

// Latest save first; creation time, newest first, and then the id break ties,
// so the order is total.
function byUpdate(a: Doc<"rules">, b: Doc<"rules">): number {
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a._creationTime !== b._creationTime) {
    return b._creationTime - a._creationTime;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// The person's rules, latest save first.
export const list = query({
  args: {},
  handler: async (ctx): Promise<NotificationRule[]> => {
    const user = await requireUser(ctx);
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rules.sort(byUpdate).map(toNotificationRule);
  },
});

// Creates a rule when `ruleId` is absent, and otherwise replaces every
// editable field of the person's rule: an omitted match field clears the
// stored one. Each save stamps `updatedAt` with this mutation's time. A rule
// with no match field is `invalid` (req-notification-rules AC-3.3). A rule
// that combines `priority` with an agent kind saves, and never matches,
// because only decision events carry a priority.
export const save = mutation({
  args: {
    ruleId: v.optional(v.string()),
    topic: v.optional(v.string()),
    agentSessionId: v.optional(v.string()),
    eventKind: v.optional(v.string()),
    priority: v.optional(v.string()),
    action: v.string(),
  },
  handler: async (ctx, args): Promise<NotificationRule> => {
    const user = await requireUser(ctx);
    const ruleId =
      args.ruleId === undefined ? undefined : parseId(ctx, "rules", args.ruleId, "ruleId");
    const agentSessionId =
      args.agentSessionId === undefined
        ? undefined
        : parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");
    const action = oneOf(RULE_ACTIONS, args.action, "action");
    if (
      args.topic === undefined &&
      args.agentSessionId === undefined &&
      args.eventKind === undefined &&
      args.priority === undefined
    ) {
      throw appError(errorCodeSchema.enum.invalid, "A rule needs at least one match field");
    }
    let topic: string | undefined;
    if (args.topic !== undefined) {
      const normalized = normalizeTopic(args.topic);
      if (!normalized.success) {
        invalid("topic");
      }
      topic = normalized.data;
    }
    const eventKind =
      args.eventKind === undefined
        ? undefined
        : oneOf(RULE_EVENT_KINDS, args.eventKind, "eventKind");
    const priority =
      args.priority === undefined ? undefined : oneOf(PRIORITIES, args.priority, "priority");

    if (ruleId !== undefined && (await getOwned(ctx, "rules", ruleId, user._id)) === null) {
      throw appError(errorCodeSchema.enum.not_found, RULE_NOT_FOUND);
    }
    if (
      agentSessionId !== undefined &&
      (await getOwned(ctx, "agentSessions", agentSessionId, user._id)) === null
    ) {
      throw appError(errorCodeSchema.enum.not_found, SESSION_NOT_FOUND);
    }

    // Absent match fields are left out, so a replacement clears them.
    const fields: WithoutSystemFields<Doc<"rules">> = {
      userId: user._id,
      action,
      updatedAt: Date.now(),
    };
    if (topic !== undefined) {
      fields.topic = topic;
    }
    if (agentSessionId !== undefined) {
      fields.agentSessionId = agentSessionId;
    }
    if (eventKind !== undefined) {
      fields.eventKind = eventKind;
    }
    if (priority !== undefined) {
      fields.priority = priority;
    }
    let id: Id<"rules">;
    if (ruleId === undefined) {
      id = await ctx.db.insert("rules", fields);
    } else {
      await ctx.db.replace("rules", ruleId, fields);
      id = ruleId;
    }
    const saved = await ctx.db.get("rules", id);
    if (saved === null) {
      throw new Error("Saved rule is missing");
    }
    return toNotificationRule(saved);
  },
});

// Deletes one of the person's rules.
export const remove = mutation({
  args: { ruleId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const ruleId = parseId(ctx, "rules", args.ruleId, "ruleId");
    if ((await getOwned(ctx, "rules", ruleId, user._id)) === null) {
      throw appError(errorCodeSchema.enum.not_found, RULE_NOT_FOUND);
    }
    await ctx.db.delete("rules", ruleId);
    return null;
  },
});
