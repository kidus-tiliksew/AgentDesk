import {
  type Answer,
  type AnsweredVia,
  type Decision,
  type DecisionInput,
  errorCodeSchema,
  validateAnswer,
  validateDecisionInput,
} from "@agentdesk/contract";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { decisionEvent, emit } from "../notifications/events";
import { decisions } from "./refs";

// component-decisions: the decision state machine, owned reads, and the
// Decision read shape. The service routes, the expiry job, and the dev answer
// helper call these inside their own mutation.

type ReaderCtx = Pick<QueryCtx, "db">;
type WriterCtx = Pick<MutationCtx, "db" | "scheduler">;

// A retried `ask` with the same key returns the first decision when that
// decision is younger than this (req-agent-tools AC-2.2).
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;
// `check` reads at most this many ids per call (req-agent-tools AC-4.1, AC-4.2).
export const CHECK_LIMIT = 50;
// req-decision-requests AC-2.5.
const NOTE_MAX = 2000;
// The surfaces a person answers through. `default` is recorded only by expiry.
const ANSWER_SURFACES: readonly AnsweredVia[] = ["app", "notification", "api"];

// Converts a client-supplied id string to a table id, or throws `invalid`
// naming the field, so a malformed id is a 400 rather than a generic error.
export function parseId<Table extends "users" | "agentSessions" | "decisions">(
  ctx: ReaderCtx,
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
  throw appError(errorCodeSchema.enum.not_found, "Decision not found");
}

function invalidFrom(issue: { message: string; path: PropertyKey[] } | undefined, prefix?: string) {
  const path = [...(prefix === undefined ? [] : [prefix]), ...(issue?.path ?? []).map(String)];
  return appError(
    errorCodeSchema.enum.invalid,
    issue?.message ?? "Invalid input",
    path.join(".") || undefined,
  );
}

function instant(at: number | undefined): string | null {
  return at === undefined ? null : new Date(at).toISOString();
}

// The contract's Decision read shape (component-contract §Read shapes):
// absent values are null and instants are ISO 8601 strings, so the gateway
// passes the result through unchanged.
export function toDecision(doc: Doc<"decisions">, followUpIds: Id<"decisions">[]): Decision {
  return {
    id: doc._id,
    topic: doc.topic,
    title: doc.title,
    body: doc.body ?? null,
    input_type: doc.inputType,
    options: doc.options ?? null,
    recommendation: doc.recommendation ?? null,
    priority: doc.priority,
    deadline: instant(doc.deadline),
    default: doc.default ?? null,
    state: doc.state,
    answer: doc.answer ?? null,
    note: doc.note ?? null,
    answered_at: instant(doc.answeredAt),
    answered_via: doc.answeredVia ?? null,
    applied_by_default: doc.appliedByDefault ?? false,
    parent_id: doc.parentId ?? null,
    follow_up_ids: followUpIds,
    agent_session_id: doc.agentSessionId,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

// The owned decisions that name `doc` as their parent, oldest first
// (req-decision-requests AC-6.2).
async function followUpIdsOf(ctx: ReaderCtx, doc: Doc<"decisions">): Promise<Id<"decisions">[]> {
  const followUps = await ctx.db
    .query("decisions")
    .withIndex("by_parent", (q) => q.eq("parentId", doc._id))
    .collect();
  return followUps.filter((f) => f.userId === doc.userId).map((f) => f._id);
}

export async function serialize(ctx: ReaderCtx, doc: Doc<"decisions">): Promise<Decision> {
  return toDecision(doc, await followUpIdsOf(ctx, doc));
}

// Loads an owned decision. A missing decision and another user's decision
// are both `not_found` (req-accounts-and-connections AC-1.1; req-agent-tools
// AC-7.1).
export async function loadOwned(
  ctx: ReaderCtx,
  userId: Id<"users">,
  decisionId: Id<"decisions">,
): Promise<Doc<"decisions">> {
  const doc = await getOwned(ctx, "decisions", decisionId, userId);
  if (doc === null) {
    notFound();
  }
  return doc;
}

// `get`: one owned decision with its follow-ups (req-decision-requests
// AC-6.2, AC-7.2). The asking session need not exist.
export async function getDecision(
  ctx: ReaderCtx,
  userId: Id<"users">,
  decisionId: Id<"decisions">,
): Promise<Decision> {
  return await serialize(ctx, await loadOwned(ctx, userId, decisionId));
}

// `check`: parses and loads up to 50 owned decisions in request order,
// keeping duplicates. More than 50 ids is `invalid` naming `decisionIds`; a
// malformed id is `invalid` naming its element; one missing or foreign id
// fails the whole call with `not_found` and returns no partial result
// (req-agent-tools AC-4.1, AC-4.2, AC-7.1).
export async function loadCheck(
  ctx: ReaderCtx,
  userId: Id<"users">,
  rawIds: readonly string[],
): Promise<Doc<"decisions">[]> {
  if (rawIds.length > CHECK_LIMIT) {
    throw appError(
      errorCodeSchema.enum.invalid,
      `At most ${CHECK_LIMIT} decision ids per call`,
      "decisionIds",
    );
  }
  const ids = rawIds.map((raw, index) => parseId(ctx, "decisions", raw, `decisionIds.${index}`));
  const docs: Doc<"decisions">[] = [];
  for (const id of ids) {
    docs.push(await loadOwned(ctx, userId, id));
  }
  return docs;
}

// Validates an `ask` input with the contract at `now`. A failure is
// `invalid` naming the first failing field (req-decision-requests AC-1.1,
// AC-1.2, AC-2.1, AC-3.1, AC-5.3).
export function validateCreate(raw: unknown, now: number): DecisionInput {
  const parsed = validateDecisionInput(raw, now);
  if (!parsed.success) {
    throw invalidFrom(parsed.error.issues[0]);
  }
  return parsed.data;
}

function labelsOf(doc: Pick<Doc<"decisions">, "options">, ids: readonly string[]): string[] {
  return ids.flatMap((id) => doc.options?.find((option) => option.id === id)?.label ?? []);
}

// The answer's searchable words: its text or the labels of the options it
// selects. Approve and reject add none.
function answerWords(doc: Pick<Doc<"decisions">, "options">, answer: Answer): string[] {
  switch (answer.kind) {
    case "text":
      return [answer.text];
    case "option":
      return labelsOf(doc, [answer.option_id]);
    case "options":
      return labelsOf(doc, answer.option_ids);
    default:
      return [];
  }
}

function joinSearch(parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join("\n");
}

// `create` after validation: returns the earlier decision for a retried
// idempotency key, else inserts a pending decision and schedules its expiry
// (component-decisions §State machine).
export async function insertDecision(
  ctx: WriterCtx,
  userId: Id<"users">,
  agentSessionId: Id<"agentSessions">,
  input: DecisionInput,
  now: number,
): Promise<Decision> {
  // A missing parent and another user's parent are rejected alike
  // (req-decision-requests AC-6.1).
  let parentId: Id<"decisions"> | undefined;
  if (input.parent_id !== undefined) {
    const id = ctx.db.normalizeId("decisions", input.parent_id);
    const parent = id === null ? null : await getOwned(ctx, "decisions", id, userId);
    if (parent === null) {
      throw appError(errorCodeSchema.enum.invalid, "parent_id names no decision", "parent_id");
    }
    parentId = parent._id;
  }

  // req-agent-tools AC-2.2: a key reused within the window returns the
  // decision the first call created, in its current state, whichever session
  // retries it.
  if (input.idempotency_key !== undefined) {
    const key = input.idempotency_key;
    const earlier = await ctx.db
      .query("decisions")
      .withIndex("by_user_idem", (q) =>
        q
          .eq("userId", userId)
          .eq("idempotencyKey", key)
          .gt("_creationTime", now - IDEMPOTENCY_WINDOW_MS),
      )
      .order("desc")
      .first();
    if (earlier !== null) {
      return await serialize(ctx, earlier);
    }
  }

  const deadline = input.deadline === undefined ? undefined : Date.parse(input.deadline);
  const decisionId = await ctx.db.insert("decisions", {
    userId,
    agentSessionId,
    topic: input.topic,
    title: input.title,
    body: input.body,
    inputType: input.input_type,
    options: input.options,
    recommendation: input.recommendation,
    // req-decision-requests AC-1.3: the contract defaults priority to normal.
    priority: input.priority,
    deadline,
    default: input.default,
    state: "pending",
    parentId,
    idempotencyKey: input.idempotency_key,
    searchText: joinSearch([
      input.title,
      input.body,
      ...(input.options ?? []).map((option) => option.label),
    ]),
  });
  if (deadline !== undefined) {
    // req-decision-requests AC-5.1, AC-5.2: the job settles the decision
    // within seconds of the deadline.
    const expiryJobId = await ctx.scheduler.runAt(deadline, decisions.expire.run, {
      decisionId,
    });
    await ctx.db.patch("decisions", decisionId, { expiryJobId });
  }
  await emit(
    ctx,
    decisionEvent(
      "decision.created",
      { _id: decisionId, userId, agentSessionId, topic: input.topic, priority: input.priority },
      now,
    ),
  );
  const doc = await ctx.db.get("decisions", decisionId);
  if (doc === null) {
    throw new Error("Inserted decision is missing");
  }
  return toDecision(doc, []);
}

// A settled decision refuses every act. The error carries the stored decision
// for in-process callers; the service-route envelope keeps only `code`,
// `message`, and `field` (req-decision-requests AC-4.1).
async function refuseSettled(ctx: ReaderCtx, doc: Doc<"decisions">): Promise<never> {
  throw new ConvexError({
    code: errorCodeSchema.enum.conflict,
    message: `Decision is already ${doc.state}`,
    decision: await serialize(ctx, doc),
  });
}

async function settle(
  ctx: WriterCtx,
  doc: Doc<"decisions">,
  patch: Partial<Doc<"decisions">>,
): Promise<Decision> {
  await ctx.db.patch("decisions", doc._id, patch);
  return await serialize(ctx, { ...doc, ...patch });
}

async function cancelExpiry(ctx: WriterCtx, doc: Doc<"decisions">): Promise<void> {
  if (doc.expiryJobId !== undefined) {
    await ctx.scheduler.cancel(doc.expiryJobId);
  }
}

// `answer`: re-reads the row in the caller's mutation, so of two concurrent
// answers the first wins and the second sees a settled row
// (req-decision-requests AC-4.2). An invalid answer, note, or surface leaves
// the decision pending (AC-2.2). Records the answer, note, time, and surface
// (AC-4.3) and cancels the expiry job, so a default never replaces it (AC-5.4).
export async function answerDecision(
  ctx: WriterCtx,
  doc: Doc<"decisions">,
  rawAnswer: unknown,
  note: string | undefined,
  answeredVia: string,
  now: number,
): Promise<Decision> {
  if (doc.state !== "pending") {
    return await refuseSettled(ctx, doc);
  }
  const answer = validateAnswer(doc.inputType, doc.options, rawAnswer);
  if (!answer.success) {
    throw invalidFrom(answer.error.issues[0], "answer");
  }
  if (note !== undefined && note.length > NOTE_MAX) {
    throw appError(
      errorCodeSchema.enum.invalid,
      `note is longer than ${NOTE_MAX} characters`,
      "note",
    );
  }
  const via = ANSWER_SURFACES.find((surface) => surface === answeredVia);
  if (via === undefined) {
    throw appError(errorCodeSchema.enum.invalid, "Invalid answeredVia", "answeredVia");
  }
  await cancelExpiry(ctx, doc);
  const settled = await settle(ctx, doc, {
    state: "answered",
    answer: answer.data,
    note,
    answeredAt: now,
    answeredVia: via,
    appliedByDefault: false,
    settledAt: now,
    searchText: joinSearch([doc.searchText, ...answerWords(doc, answer.data), note]),
  });
  await emit(ctx, decisionEvent("decision.answered", doc, now));
  return settled;
}

// `cancel`: a cancelled decision carries no answer (req-decision-requests
// AC-4.4).
export async function cancelDecision(
  ctx: WriterCtx,
  doc: Doc<"decisions">,
  now: number,
): Promise<Decision> {
  if (doc.state !== "pending") {
    return await refuseSettled(ctx, doc);
  }
  await cancelExpiry(ctx, doc);
  const settled = await settle(ctx, doc, { state: "cancelled", settledAt: now });
  await emit(ctx, decisionEvent("decision.cancelled", doc, now));
  return settled;
}

// Expiry: with a default, the default becomes the answer, applied by default
// (req-decision-requests AC-5.1); without one, the decision expires with no
// answer (AC-5.2). A settled decision is refused, so a late job never
// replaces an answer (AC-5.4). A pending decision with no deadline, or one
// whose deadline is still ahead, is left unchanged, so expiry happens only at
// the stored deadline (REQ-5).
export async function expireDecision(
  ctx: WriterCtx,
  doc: Doc<"decisions">,
  now: number,
): Promise<Decision> {
  if (doc.state !== "pending") {
    return await refuseSettled(ctx, doc);
  }
  if (doc.deadline === undefined || now < doc.deadline) {
    return await serialize(ctx, doc);
  }
  const patch: Partial<Doc<"decisions">> = { state: "expired", settledAt: now };
  if (doc.default !== undefined) {
    patch.answer = doc.default;
    patch.answeredAt = now;
    patch.answeredVia = "default";
    patch.appliedByDefault = true;
    patch.searchText = joinSearch([doc.searchText, ...answerWords(doc, doc.default)]);
  }
  const settled = await settle(ctx, doc, patch);
  await emit(ctx, decisionEvent("decision.expired", doc, now));
  return settled;
}
