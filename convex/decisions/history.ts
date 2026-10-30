import { errorCodeSchema, normalizeTopic } from "@agentdesk/contract";
import type {
  Expression,
  FilterBuilder,
  NamedTableInfo,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { type AppDecision, serializeForApp } from "./model";

// component-decisions §History: the settled-decision history that
// `decisions/app:searchHistory` serves (req-mobile-app AC-6.1). Both paths
// apply every eligibility predicate as a post-index filter and then call
// Convex's native `.paginate` once, so the engine skips excluded rows while it
// fills the requested page, and the native cursor continues the same query.

type ReaderCtx = Pick<QueryCtx, "db">;
type DecisionsInfo = NamedTableInfo<DataModel, "decisions">;

// The server bounds the requested page size.
export const HISTORY_PAGE_MIN = 1;
export const HISTORY_PAGE_MAX = 50;

export type SettledState = "answered" | "expired" | "cancelled";
const SETTLED_STATES: readonly SettledState[] = ["answered", "expired", "cancelled"];

// One history row: the decision in the app's read shape, with `cancelReason`
// when set, and the instant it left `pending`, which the `Decision` read
// shape does not carry.
export type HistoryItem = { decision: AppDecision; settled_at: string };

export type HistoryFilters = {
  // Trimmed search text; empty lists by settlement time.
  text: string;
  state: SettledState | undefined;
  topic: string | undefined;
};

// Clamps the requested page size to 1..50. A non-number count is 1.
export function clampPageSize(numItems: number): number {
  if (Number.isNaN(numItems)) {
    return HISTORY_PAGE_MIN;
  }
  return Math.min(HISTORY_PAGE_MAX, Math.max(HISTORY_PAGE_MIN, Math.floor(numItems)));
}

// Validates the client's filters. Absent or whitespace-only text is empty. A
// state other than a settled one is `invalid` naming `state`; a topic is
// normalized by the contract, and one that fails is `invalid` naming `topic`.
export function parseHistoryFilters(raw: {
  query?: string;
  state?: string;
  topic?: string;
}): HistoryFilters {
  let state: SettledState | undefined;
  if (raw.state !== undefined) {
    state = SETTLED_STATES.find((settled) => settled === raw.state);
    if (state === undefined) {
      throw appError(
        errorCodeSchema.enum.invalid,
        "state must be answered, expired, or cancelled",
        "state",
      );
    }
  }
  let topic: string | undefined;
  if (raw.topic !== undefined) {
    const parsed = normalizeTopic(raw.topic);
    if (!parsed.success) {
      throw appError(errorCodeSchema.enum.invalid, "Invalid topic", "topic");
    }
    topic = parsed.data;
  }
  return { text: raw.query?.trim() ?? "", state, topic };
}

// The contract's `topicMatches(topic, candidate)` as a lexical interval. A
// canonical topic uses only `[a-z0-9._/-]`, and `0` follows `/` in ASCII, so
// the topics under `topic` are exactly the strings in `[topic + "/",
// topic + "0")`.
export function topicBounds(topic: string): { lower: string; upper: string } {
  return { lower: `${topic}/`, upper: `${topic}0` };
}

// The interval predicate in plain code, for parity checks with the contract.
export function topicInBounds(topic: string, candidate: string): boolean {
  const { lower, upper } = topicBounds(topic);
  return candidate === topic || (candidate >= lower && candidate < upper);
}

// The post-index eligibility filter: a settled state (the requested one, or
// any but `pending`) and, when given, a topic match.
function eligible(
  q: FilterBuilder<DecisionsInfo>,
  { state, topic }: HistoryFilters,
): Expression<boolean> {
  const conditions: Expression<boolean>[] = [
    state === undefined ? q.neq(q.field("state"), "pending") : q.eq(q.field("state"), state),
  ];
  if (topic !== undefined) {
    const { lower, upper } = topicBounds(topic);
    conditions.push(
      q.or(
        q.eq(q.field("topic"), topic),
        q.and(q.gte(q.field("topic"), lower), q.lt(q.field("topic"), upper)),
      ),
    );
  }
  return q.and(...conditions);
}

// The settlement instant as ISO 8601. A settled row always has `settledAt`;
// one without it breaks the state machine's invariant and fails the read.
export function settledInstant(doc: Doc<"decisions">): string {
  if (doc.state === "pending" || doc.settledAt === undefined || !(doc.settledAt > 0)) {
    throw new Error(`Decision ${doc._id} is listed as settled without a settlement time`);
  }
  return new Date(doc.settledAt).toISOString();
}

// One page of the user's settled decisions. Nonempty text reads `search_text`
// filtered by `userId` and any state, in Convex relevance order. Empty text
// reads `by_user_settled` with `settledAt > 0`, newest settled first, ties in
// Convex's descending index order. The native result is returned with only
// its page rows mapped, so `continueCursor`, `isDone`, and any split
// metadata reach the client unchanged.
export async function historyPage(
  ctx: ReaderCtx,
  userId: Id<"users">,
  filters: HistoryFilters,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<HistoryItem>> {
  const { text, state } = filters;
  const source =
    text === ""
      ? ctx.db
          .query("decisions")
          .withIndex("by_user_settled", (q) => q.eq("userId", userId).gt("settledAt", 0))
          .order("desc")
      : ctx.db.query("decisions").withSearchIndex("search_text", (q) => {
          const search = q.search("searchText", text).eq("userId", userId);
          return state === undefined ? search : search.eq("state", state);
        });
  const result = await source
    .filter((q) => eligible(q, filters))
    .paginate({ ...paginationOpts, numItems: clampPageSize(paginationOpts.numItems) });
  const page: HistoryItem[] = [];
  for (const doc of result.page) {
    page.push({ decision: await serializeForApp(ctx, doc), settled_at: settledInstant(doc) });
  }
  return { ...result, page };
}
