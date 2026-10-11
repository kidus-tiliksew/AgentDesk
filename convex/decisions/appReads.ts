import type { Decision } from "@agentdesk/contract";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { serialize } from "./model";

// component-decisions §Reads: the pending decision lists the app reads. The
// inbox (`listPending`) and the agent screen (`agents/app:get`) share one
// order, so a decision sits in the same place on both.

type ReaderCtx = Pick<QueryCtx, "db">;

// Urgent before normal, then deadline ascending with no deadline last, then
// oldest first (req-mobile-app AC-2.1). The id breaks any remaining tie, so
// the order is total.
export function comparePending(a: Doc<"decisions">, b: Doc<"decisions">): number {
  if (a.priority !== b.priority) {
    return a.priority === "urgent" ? -1 : 1;
  }
  if (a.deadline !== b.deadline) {
    if (a.deadline === undefined) return 1;
    if (b.deadline === undefined) return -1;
    return a.deadline - b.deadline;
  }
  if (a._creationTime !== b._creationTime) {
    return a._creationTime - b._creationTime;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

async function serializeSorted(ctx: ReaderCtx, docs: Doc<"decisions">[]): Promise<Decision[]> {
  const sorted = [...docs].sort(comparePending);
  const result: Decision[] = [];
  for (const doc of sorted) {
    result.push(await serialize(ctx, doc));
  }
  return result;
}

// The user's pending decisions in inbox order.
export async function pendingForUser(ctx: ReaderCtx, userId: Id<"users">): Promise<Decision[]> {
  const docs = await ctx.db
    .query("decisions")
    .withIndex("by_user_state", (q) => q.eq("userId", userId).eq("state", "pending"))
    .collect();
  return await serializeSorted(ctx, docs);
}

// One session's pending decisions owned by `userId`, in inbox order.
export async function pendingForAgent(
  ctx: ReaderCtx,
  userId: Id<"users">,
  agentSessionId: Id<"agentSessions">,
): Promise<Decision[]> {
  const docs = await ctx.db
    .query("decisions")
    .withIndex("by_agent_state", (q) =>
      q.eq("agentSessionId", agentSessionId).eq("state", "pending"),
    )
    .collect();
  return await serializeSorted(
    ctx,
    docs.filter((doc) => doc.userId === userId),
  );
}
