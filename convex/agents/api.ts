import { type AgentSession, type AgentSessionPage, errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { pendingCountForAgent } from "../decisions/counts";
import { decodeCursorJson, encodeCursorJson } from "../decisions/cursor";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { liveSessionsFor, recentSessionsFor, withPendingCounts } from "./app";
import { toAgentSession } from "./sessions";

// component-agent-presence §Service routes: the public HTTP API's agent
// session reads, behind `/svc/agents/list` and `/svc/agents/get`. They follow
// the app's rules: only activated sessions appear, and the ended set is the
// app's 7-day recent window (req-public-api-and-webhooks REQ-2).

type Phase = "live" | "ended";

// The position of the last item of a page. `key` is `lastActivityAt` for a
// live session and `endedAt` for an ended one.
const cursorSchema = z.object({
  v: z.literal(1),
  phase: z.enum(["live", "ended"]),
  key: z.number(),
  created: z.number(),
  id: z.string(),
});
type Position = Omit<z.infer<typeof cursorSchema>, "v">;

function positionOf(session: Doc<"agentSessions">, phase: Phase): Position {
  return {
    phase,
    key: (phase === "live" ? session.lastActivityAt : session.endedAt) ?? 0,
    created: session._creationTime,
    id: session._id,
  };
}

// Whether `a` comes after `b` in the list order: every live session before
// every ended one, then the key newest first, then creation time newest
// first, then the id ascending, the tie-breaks of `liveAgents` and
// `recentAgents`.
function isAfter(a: Position, b: Position): boolean {
  if (a.phase !== b.phase) {
    return a.phase === "ended";
  }
  if (a.key !== b.key) {
    return a.key < b.key;
  }
  if (a.created !== b.created) {
    return a.created < b.created;
  }
  return a.id > b.id;
}

function parseUserId(ctx: Pick<QueryCtx, "db">, raw: string): Id<"users"> {
  const userId = ctx.db.normalizeId("users", raw);
  if (userId === null) {
    throw appError(errorCodeSchema.enum.invalid, "Invalid userId", "userId");
  }
  return userId;
}

function parseCursor(cursor: string): Position {
  const parsed = cursorSchema.safeParse(decodeCursorJson(cursor));
  if (!parsed.success) {
    throw appError(errorCodeSchema.enum.invalid, "cursor is not a cursor of this list", "cursor");
  }
  const { v: _version, ...position } = parsed.data;
  return position;
}

// Live sessions first in `liveAgents` order, then ended sessions in
// `recentAgents` order, so a client reading live sessions stops at the first
// ended one. Each page holds the items strictly after the cursor's position.
// Pages observe live data: activity or an end between pages can move a
// session, as in decision history.
export const list = internalQuery({
  args: { userId: v.string(), cursor: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args): Promise<AgentSessionPage> => {
    const userId = parseUserId(ctx, args.userId);
    const after = args.cursor === undefined ? null : parseCursor(args.cursor);
    const ordered = [
      ...(await liveSessionsFor(ctx, userId)).map((s) => ({ s, p: positionOf(s, "live") })),
      ...(await recentSessionsFor(ctx, userId, Date.now())).map((s) => ({
        s,
        p: positionOf(s, "ended"),
      })),
    ];
    const remaining = after === null ? ordered : ordered.filter(({ p }) => isAfter(p, after));
    const page = remaining.slice(0, args.limit);
    const last = page.at(-1);
    return {
      items: await withPendingCounts(
        ctx,
        page.map(({ s }) => s),
      ),
      next_cursor:
        last === undefined || remaining.length <= page.length
          ? null
          : encodeCursorJson({ v: 1, ...last.p }),
    };
  },
});

// One owned activated session, live or ended. A missing, a foreign, and an
// only-initialized session are all `not_found`, as in `agents/app:get`.
export const get = internalQuery({
  args: { userId: v.string(), agentSessionId: v.string() },
  handler: async (ctx, args): Promise<AgentSession> => {
    const userId = parseUserId(ctx, args.userId);
    const agentSessionId = ctx.db.normalizeId("agentSessions", args.agentSessionId);
    if (agentSessionId === null) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid agentSessionId", "agentSessionId");
    }
    const session = await getOwned(ctx, "agentSessions", agentSessionId, userId);
    if (session === null || session.activatedAt === undefined) {
      throw appError(errorCodeSchema.enum.not_found, "Agent session not found");
    }
    return toAgentSession(session, await pendingCountForAgent(ctx, agentSessionId));
  },
});
