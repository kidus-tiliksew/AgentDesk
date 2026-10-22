import type { Answer } from "@agentdesk/contract";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getOwned } from "../lib/owned";
import type { PushMessage } from "./push";

// component-notifications §Push: the title, body, category, and interruption
// level of each pushed event. Every event title is the agent name. Related
// rows are read at routing time within the event owner's account. A missing
// session does not stop a push.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// The agent name when the asking session no longer exists, as after the
// purge of an ended session.
const ENDED_AGENT = "Ended agent";

type ReaderCtx = Pick<QueryCtx, "db">;

// The card name (req-agent-status AC-2.1, AC-2.2). The digest read
// (convex/notifications/digests.ts) shows the same name.
export function agentName(session: Doc<"agentSessions"> | null): string {
  if (session === null) {
    return ENDED_AGENT;
  }
  return session.displayName ?? `${session.clientName} · ${session.topic ?? ""}`;
}

function loadSession(ctx: ReaderCtx, event: Doc<"events">) {
  return event.agentSessionId === undefined
    ? null
    : getOwned(ctx, "agentSessions", event.agentSessionId, event.userId);
}

function recommendedIds(recommendation: Answer | undefined): string[] {
  switch (recommendation?.kind) {
    case "option":
      return [recommendation.option_id];
    case "options":
      return recommendation.option_ids;
    default:
      return [];
  }
}

// One numbered line per option in source order, the recommended ones marked.
function optionLines(decision: Doc<"decisions">): string[] {
  const recommended = new Set(recommendedIds(decision.recommendation));
  return (decision.options ?? []).map(
    (option, index) =>
      `${index + 1}. ${option.label}${recommended.has(option.id) ? " (recommended)" : ""}`,
  );
}

// The notification category whose actions answer the decision in place. The
// app registers these categories; a category the device has not registered
// shows as a plain notification that opens the app.
export function decisionCategory(decision: Doc<"decisions">): string | undefined {
  if (decision.inputType === "approve_reject") {
    return "decision-approve-reject";
  }
  const count = decision.options?.length;
  if (decision.inputType === "single_choice" && (count === 2 || count === 3)) {
    return `decision-choice-${count}`;
  }
  return undefined;
}

// The time from the event to the decision's deadline, as "25 min" or "2 h".
// Under an hour it counts whole minutes rounded up, so any time left shows at
// least "1 min"; from an hour on it counts whole hours rounded down. A deadline
// at or before the event shows "0 min". It is counted from the event's
// `occurredAt`, never the send time, so a held or retried push reads the same.
export function durationText(ms: number): string {
  if (ms <= 0) {
    return "0 min";
  }
  if (ms < HOUR_MS) {
    return `${Math.ceil(ms / MINUTE_MS)} min`;
  }
  return `${Math.floor(ms / HOUR_MS)} h`;
}

// Choice types list the recommendation in their option lines; the other two
// input types state it on a line of its own.
function recommendationLine(decision: Doc<"decisions">): string | undefined {
  if (decision.recommendation === undefined) {
    return undefined;
  }
  if (decision.inputType !== "approve_reject" && decision.inputType !== "free_text") {
    return undefined;
  }
  return `Recommended: ${answerText(decision, decision.recommendation)}`;
}

// A decision that will apply its default: the default answer and the time
// left from the event to the deadline. A decision with only one of the two
// fields has no such line.
function defaultLine(decision: Doc<"decisions">, event: Doc<"events">): string | undefined {
  if (decision.deadline === undefined || decision.default === undefined) {
    return undefined;
  }
  const remaining = durationText(decision.deadline - event.occurredAt);
  return `Defaults to ${answerText(decision, decision.default)} in ${remaining}`;
}

// The title is the asking agent; the body leads with the full question, then
// the options or recommendation, then the default. An urgent decision is
// presented as time-sensitive, so iOS can show it through Focus.
async function decisionCreated(ctx: ReaderCtx, event: Doc<"events">): Promise<PushMessage | null> {
  if (event.decisionId === undefined) {
    return null;
  }
  const decision = await getOwned(ctx, "decisions", event.decisionId, event.userId);
  if (decision === null) {
    return null;
  }
  const session = await loadSession(ctx, event);
  const lines = [
    decision.title,
    ...optionLines(decision),
    recommendationLine(decision),
    defaultLine(decision, event),
  ].filter((line) => line !== undefined);
  const message: PushMessage = { title: agentName(session), body: lines.join("\n") };
  const categoryId = decisionCategory(decision);
  if (categoryId !== undefined) {
    message.categoryId = categoryId;
  }
  if (decision.priority === "urgent") {
    message.interruptionLevel = "time-sensitive";
  }
  return message;
}

// Silence runs from the session's last activity to the moment the sweep
// marked it stale. A missing or foreign session has no known silence.
async function agentStale(ctx: ReaderCtx, event: Doc<"events">): Promise<PushMessage> {
  const session = await loadSession(ctx, event);
  if (session === null) {
    return { title: agentName(session), body: "Looks stuck" };
  }
  const minutes = Math.max(0, Math.floor((event.occurredAt - session.lastActivityAt) / MINUTE_MS));
  return {
    title: agentName(session),
    body: [`Looks stuck · silent for ${minutes} min`, session.line]
      .filter((part) => part !== undefined)
      .join("\n"),
  };
}

// The applied answer as the person reads it: option labels in answer order,
// falling back to the option id for an option the decision no longer lists.
export function answerText(decision: Doc<"decisions">, answer: Answer): string {
  const label = (optionId: string) =>
    decision.options?.find((option) => option.id === optionId)?.label ?? optionId;
  switch (answer.kind) {
    case "approve":
      return "Approve";
    case "reject":
      return "Reject";
    case "option":
      return label(answer.option_id);
    case "options":
      return answer.option_ids.map(label).join(", ");
    case "text":
      return answer.text;
  }
}

// A decision whose deadline passed, titled with the asking agent. The body is
// "Decided by default: <title>" then the applied answer when the default was
// applied and stored as the answer, otherwise "Expired: <title>".
async function decisionExpired(ctx: ReaderCtx, event: Doc<"events">): Promise<PushMessage | null> {
  if (event.decisionId === undefined) {
    return null;
  }
  const decision = await getOwned(ctx, "decisions", event.decisionId, event.userId);
  if (decision === null) {
    return null;
  }
  const title = agentName(await loadSession(ctx, event));
  if (decision.answer === undefined) {
    return { title, body: `Expired: ${decision.title}` };
  }
  return {
    title,
    body: `Decided by default: ${decision.title}\n${answerText(decision, decision.answer)}`,
  };
}

// `agent.status_changed` and `agent.done`: the card name, then the session's
// current status line when it has one.
async function agentStatus(ctx: ReaderCtx, event: Doc<"events">): Promise<PushMessage> {
  const session = await loadSession(ctx, event);
  const message: PushMessage = { title: agentName(session) };
  if (session?.line !== undefined) {
    message.body = session.line;
  }
  return message;
}

// The message for an event whose action is push, or null when the event's
// decision no longer exists and there is nothing to show.
export async function pushMessage(
  ctx: ReaderCtx,
  event: Doc<"events">,
): Promise<PushMessage | null> {
  switch (event.kind) {
    case "decision.created":
      return await decisionCreated(ctx, event);
    case "decision.expired":
      return await decisionExpired(ctx, event);
    case "agent.stale":
      return await agentStale(ctx, event);
    case "agent.status_changed":
    case "agent.done":
      return await agentStatus(ctx, event);
    default:
      throw new Error(`No push message for ${event.kind}`);
  }
}
