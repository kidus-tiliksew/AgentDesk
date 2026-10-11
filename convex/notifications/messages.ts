import type { Answer } from "@agentdesk/contract";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getOwned } from "../lib/owned";
import type { PushMessage } from "./push";

// component-notifications §Push: the title, body, and category of each pushed
// event. Related rows are read at routing time within the event owner's
// account. A missing session does not stop a push.

const MINUTE_MS = 60_000;
// The agent name when the asking session no longer exists, as after the
// purge of an ended session.
const ENDED_AGENT = "Ended agent";

type ReaderCtx = Pick<QueryCtx, "db">;

// The card name (req-agent-status AC-2.1, AC-2.2).
function agentName(session: Doc<"agentSessions"> | null): string {
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

async function decisionCreated(ctx: ReaderCtx, event: Doc<"events">): Promise<PushMessage | null> {
  if (event.decisionId === undefined) {
    return null;
  }
  const decision = await getOwned(ctx, "decisions", event.decisionId, event.userId);
  if (decision === null) {
    return null;
  }
  const session = await loadSession(ctx, event);
  const message: PushMessage = {
    title: decision.title,
    body: [`${decision.topic} · ${agentName(session)}`, ...optionLines(decision)].join("\n"),
  };
  const categoryId = decisionCategory(decision);
  if (categoryId !== undefined) {
    message.categoryId = categoryId;
  }
  return message;
}

// Silence runs from the session's last activity to the moment the sweep
// marked it stale.
async function agentStale(ctx: ReaderCtx, event: Doc<"events">): Promise<PushMessage> {
  const session = await loadSession(ctx, event);
  const message: PushMessage = { title: `${agentName(session)} looks stuck` };
  if (session !== null) {
    const minutes = Math.max(
      0,
      Math.floor((event.occurredAt - session.lastActivityAt) / MINUTE_MS),
    );
    message.body = [session.line, `Silent for ${minutes} min`]
      .filter((part) => part !== undefined)
      .join("\n");
  }
  return message;
}

// The message for an event whose action is push, or null when the event's
// decision no longer exists and there is nothing to show. Under the default
// actions only `decision.created` and `agent.stale` are pushed; the other
// kinds' messages arrive with rules, the first slice that can push them.
export async function pushMessage(
  ctx: ReaderCtx,
  event: Doc<"events">,
): Promise<PushMessage | null> {
  switch (event.kind) {
    case "decision.created":
      return await decisionCreated(ctx, event);
    case "agent.stale":
      return await agentStale(ctx, event);
    default:
      throw new Error(`No push message for ${event.kind}`);
  }
}
