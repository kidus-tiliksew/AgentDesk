import {
  type AgentSession,
  errorCodeSchema,
  normalizeTopic,
  statusInputSchema,
} from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { pendingCountForAgent } from "../decisions/counts";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { agentEvent, emit } from "../notifications/events";

// component-agent-presence §Lifecycle: sessions, activity, and status.

// History keeps the newest rows up to this count (req-agent-status AC-1.2).
const HISTORY_LIMIT = 20;
const MCP_SESSION_ID_BYTES = 32;

// A fresh MCP session id: 32 random bytes as 64 lowercase hex characters. Web
// Crypto only; the default Convex runtime has no Node crypto.
function newMcpSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(MCP_SESSION_ID_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Converts a client-supplied id string to a table id, or throws `invalid`
// naming the field, so a malformed id is a 400 rather than a generic error.
function parseId<Table extends "users" | "credentials" | "agentSessions">(
  ctx: Pick<QueryCtx, "db">,
  table: Table,
  raw: string,
  field: string,
): Id<Table> {
  const id = ctx.db.normalizeId(table, raw);
  if (id === null) {
    throw appError(errorCodeSchema.enum.invalid, `Invalid ${field}`, field);
  }
  return id;
}

function notFound(): never {
  throw appError(errorCodeSchema.enum.not_found, "Agent session not found");
}

// MCP `initialize`: insert a session with no `activatedAt`, `topic`, or status
// fields, so a harness health check creates no card (req-agent-status REQ-2).
export const open = internalMutation({
  args: {
    userId: v.string(),
    credentialId: v.string(),
    clientName: v.string(),
    clientVersion: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ agentSessionId: Id<"agentSessions">; mcpSessionId: string }> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const credentialId = parseId(ctx, "credentials", args.credentialId, "credentialId");
    const mcpSessionId = newMcpSessionId();
    const agentSessionId = await ctx.db.insert("agentSessions", {
      userId,
      credentialId,
      mcpSessionId,
      clientName: args.clientName,
      clientVersion: args.clientVersion,
      lastActivityAt: now,
    });
    return { agentSessionId, mcpSessionId };
  },
});

// Records activity on the caller's session inside the caller's mutation. Every
// agent operation calls it: `status` here, and the decision routes of
// component-decisions.
//
// Loads the session with getOwned, so another user's session is `not_found`
// like a missing one (req-agent-tools AC-7.1). Sets `lastActivityAt`, clears
// `staleSince` (req-agent-status AC-3.3), and clears an `idle` end, so a
// session that went idle re-enters the live set; a `done` end stays until a
// later non-`done` status clears it. The first call sets `activatedAt` and
// `topic` together (REQ-2); later calls never change them and may omit the
// topic. The first call must carry a topic, because the card name needs one
// (AC-2.1) and the contract's AgentSession shape requires one: a missing or
// invalid topic on a session that is not yet activated is rejected as
// `invalid` naming `topic` before any write (req-agent-tools REQ-8, AC-8.2).
//
// `topic` is a raw caller value; it is lowercased and checked by the contract
// (req-agent-tools AC-8.1, AC-8.2). Returns the session as it is after the
// touch.
export async function touch(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  agentSessionId: Id<"agentSessions">,
  topic: string | undefined,
  now: number,
): Promise<Doc<"agentSessions">> {
  const session = await getOwned(ctx, "agentSessions", agentSessionId, userId);
  if (session === null) {
    notFound();
  }
  const patch: Partial<Doc<"agentSessions">> = { lastActivityAt: now, staleSince: undefined };
  if (session.endReason === "idle") {
    patch.endedAt = undefined;
    patch.endReason = undefined;
  }
  if (session.activatedAt === undefined) {
    const normalized = normalizeTopic(topic);
    if (!normalized.success) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid topic", "topic");
    }
    patch.activatedAt = now;
    patch.topic = normalized.data;
  }
  await ctx.db.patch("agentSessions", agentSessionId, patch);
  return { ...session, ...patch };
}

// MCP `status`: validate, touch, archive the previous status, and replace it
// (req-agent-status REQ-1; req-agent-tools REQ-6).
export const status = internalMutation({
  args: {
    userId: v.string(),
    agentSessionId: v.string(),
    topic: v.string(),
    state: v.string(),
    line: v.string(),
    link: v.optional(v.string()),
    display_name: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AgentSession> => {
    const now = Date.now();
    const userId = parseId(ctx, "users", args.userId, "userId");
    const agentSessionId = parseId(ctx, "agentSessions", args.agentSessionId, "agentSessionId");

    // Validation runs before any write, so a rejected status changes nothing
    // (req-agent-status AC-1.3; req-agent-tools AC-1.3).
    const input = statusInputSchema.safeParse({
      state: args.state,
      line: args.line,
      link: args.link,
      display_name: args.display_name,
    });
    if (!input.success) {
      const issue = input.error.issues[0];
      throw appError(
        errorCodeSchema.enum.invalid,
        issue?.message ?? "Invalid status",
        issue?.path.map(String).join(".") || undefined,
      );
    }
    const topic = normalizeTopic(args.topic);
    if (!topic.success) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid topic", "topic");
    }

    const session = await touch(ctx, userId, agentSessionId, topic.data, now);

    // AC-1.1: the previous current status moves to history; the first status
    // has none. AC-1.2: the oldest rows beyond the limit are deleted.
    if (
      session.state !== undefined &&
      session.line !== undefined &&
      session.statusAt !== undefined
    ) {
      await ctx.db.insert("statusHistory", {
        agentSessionId,
        state: session.state,
        line: session.line,
        link: session.link,
        at: session.statusAt,
      });
      const history = await ctx.db
        .query("statusHistory")
        .withIndex("by_session_at", (q) => q.eq("agentSessionId", agentSessionId))
        .order("asc")
        .collect();
      for (const row of history.slice(0, Math.max(0, history.length - HISTORY_LIMIT))) {
        await ctx.db.delete("statusHistory", row._id);
      }
    }

    // `link` is replaced, so omitting it clears the old link; `displayName`
    // persists until the agent sets a new one (AC-2.2).
    const patch: Partial<Doc<"agentSessions">> = {
      state: input.data.state,
      line: input.data.line,
      link: input.data.link,
      statusAt: now,
    };
    if (input.data.display_name !== undefined) {
      patch.displayName = input.data.display_name;
    }
    if (input.data.state === "done") {
      // REQ-4: a done session leaves the live set.
      patch.endedAt = now;
      patch.endReason = "done";
    } else if (session.endReason === "done") {
      // §Lifecycle: a non-done status on a done session clears its end.
      patch.endedAt = undefined;
      patch.endReason = undefined;
    }
    await ctx.db.patch("agentSessions", agentSessionId, patch);
    // §Lifecycle: every status emits `agent.status_changed`; a done status
    // then also emits `agent.done`.
    await emit(ctx, agentEvent("agent.status_changed", session, now));
    if (input.data.state === "done") {
      await emit(ctx, agentEvent("agent.done", session, now));
    }

    return toAgentSession(
      { ...session, ...patch },
      await pendingCountForAgent(ctx, agentSessionId),
    );
  },
});

// Ends the sessions of a connection that ended (component-agent-presence
// §Lifecycle; req-install-keys AC-4.2). Inside the caller's mutation, every
// session of `userId` opened with `credentialId` that has no `endedAt` gets
// `endedAt` and the end reason `disconnected`. It emits no `agent.done`: the
// agent did not finish, its machine went away. Returns the ids of all of the
// connection's sessions, including those that had already ended as `done` or
// `idle`, so the caller can cancel decisions any of them left pending. A
// second call ends nothing and returns the same ids.
export async function endForConnection(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  credentialId: Id<"credentials">,
  now: number,
): Promise<Id<"agentSessions">[]> {
  const sessions = await ctx.db
    .query("agentSessions")
    .withIndex("by_credential", (q) => q.eq("credentialId", credentialId))
    .collect();
  const ids: Id<"agentSessions">[] = [];
  for (const session of sessions) {
    if (session.userId !== userId) {
      continue;
    }
    if (session.endedAt === undefined) {
      await ctx.db.patch("agentSessions", session._id, { endedAt: now, endReason: "disconnected" });
    }
    ids.push(session._id);
  }
  return ids;
}

// Resolves an MCP session id to the caller's session. Another user's session
// is `not_found` like an unknown id (req-agent-tools AC-7.1).
export const session = internalQuery({
  args: { userId: v.string(), mcpSessionId: v.string() },
  handler: async (ctx, args): Promise<{ agentSessionId: Id<"agentSessions"> }> => {
    const userId = parseId(ctx, "users", args.userId, "userId");
    const found = await ctx.db
      .query("agentSessions")
      .withIndex("by_mcp", (q) => q.eq("mcpSessionId", args.mcpSessionId))
      .unique();
    if (found === null || found.userId !== userId) {
      notFound();
    }
    return { agentSessionId: found._id };
  },
});

// The contract's AgentSession read shape (component-contract §Read shapes).
// Absent values are null and instants are ISO 8601 strings. The card name is
// `displayName` once set, else `clientName · topic` (req-agent-status AC-2.1,
// AC-2.2). `pendingDecisionCount` comes from component-decisions'
// `pendingCountForAgent` (AC-2.3).
export function toAgentSession(
  doc: Doc<"agentSessions">,
  pendingDecisionCount: number,
): AgentSession {
  return {
    id: doc._id,
    display_name: doc.displayName ?? `${doc.clientName} · ${doc.topic ?? ""}`,
    topic: doc.topic ?? "",
    state: doc.state ?? null,
    line: doc.line ?? null,
    link: doc.link ?? null,
    status_at: instant(doc.statusAt),
    last_activity_at: new Date(doc.lastActivityAt).toISOString(),
    stale: doc.staleSince !== undefined,
    ended_at: instant(doc.endedAt),
    pending_decision_count: pendingDecisionCount,
  };
}

function instant(at: number | undefined): string | null {
  return at === undefined ? null : new Date(at).toISOString();
}
