import {
  type DecisionPage,
  type DecisionState,
  decisionStateSchema,
  errorCodeSchema,
  normalizeTopic,
} from "@agentdesk/contract";
import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { decodeCursorJson, encodeCursorJson } from "./cursor";
import { topicBounds } from "./history";
import { serialize } from "./model";

// component-decisions §Reads, `listForApi`: the public HTTP API's decision
// list (req-public-api-and-webhooks AC-2.1). The user's decisions, filtered by
// state and topic, newest first, in cursor pages. The read uses `by_user_state`
// with state equality when a state is given and `by_user` otherwise, both in
// descending order, so rows come newest created first. The topic rule is one
// post-index `.filter`, and native `.paginate` runs once, so the engine reads
// past excluded rows until it fills the page.

type ReaderCtx = Pick<QueryCtx, "db">;

export type ApiListFilters = {
  state: DecisionState | undefined;
  topic: string | undefined;
};

// The service cursor wraps Convex's native cursor with the filters it was
// issued for, so a cursor reused with other filters is `invalid` rather than a
// native cursor error.
const cursorSchema = z.object({
  v: z.literal(1),
  state: decisionStateSchema.nullable(),
  topic: z.string().nullable(),
  cursor: z.string(),
});

// Validates the raw list arguments the route passes through, naming the
// failing field.
export function parseApiListFilters(raw: { state?: unknown; topic?: unknown }): ApiListFilters {
  let state: DecisionState | undefined;
  if (raw.state !== undefined) {
    const parsed = decisionStateSchema.safeParse(raw.state);
    if (!parsed.success) {
      throw appError(
        errorCodeSchema.enum.invalid,
        "state must be pending, answered, expired, or cancelled",
        "state",
      );
    }
    state = parsed.data;
  }
  let topic: string | undefined;
  if (raw.topic !== undefined) {
    const parsed = typeof raw.topic === "string" ? normalizeTopic(raw.topic) : null;
    if (!parsed?.success) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid topic", "topic");
    }
    topic = parsed.data;
  }
  return { state, topic };
}

export async function listForApi(
  ctx: ReaderCtx,
  userId: Id<"users">,
  filters: ApiListFilters,
  cursor: string | undefined,
  limit: number,
): Promise<DecisionPage> {
  const { state, topic } = filters;
  const nativeCursor = cursor === undefined ? null : decodeCursor(cursor, filters);
  const source =
    state === undefined
      ? ctx.db
          .query("decisions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .order("desc")
      : ctx.db
          .query("decisions")
          .withIndex("by_user_state", (q) => q.eq("userId", userId).eq("state", state))
          .order("desc");
  const filtered =
    topic === undefined
      ? source
      : source.filter((q) => {
          const { lower, upper } = topicBounds(topic);
          return q.or(
            q.eq(q.field("topic"), topic),
            q.and(q.gte(q.field("topic"), lower), q.lt(q.field("topic"), upper)),
          );
        });
  const result = await filtered.paginate({ cursor: nativeCursor, numItems: limit });
  const items = [];
  for (const doc of result.page) {
    items.push(await serialize(ctx, doc));
  }
  return {
    items,
    next_cursor: result.isDone ? null : encodeCursor(result.continueCursor, filters),
  };
}

function encodeCursor(native: string, { state, topic }: ApiListFilters): string {
  return encodeCursorJson({ v: 1, state: state ?? null, topic: topic ?? null, cursor: native });
}

function decodeCursor(cursor: string, { state, topic }: ApiListFilters): string {
  const parsed = cursorSchema.safeParse(decodeCursorJson(cursor));
  if (
    !parsed.success ||
    parsed.data.state !== (state ?? null) ||
    parsed.data.topic !== (topic ?? null)
  ) {
    throw invalidCursor();
  }
  return parsed.data.cursor;
}

function invalidCursor() {
  return appError(
    errorCodeSchema.enum.invalid,
    "cursor is not a cursor of this list with these filters",
    "cursor",
  );
}
