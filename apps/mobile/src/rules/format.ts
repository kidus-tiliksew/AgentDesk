import type { AgentSession } from "@agentdesk/contract";
import type { NotificationRule } from "../../../../convex/notifications/rules";

// component-mobile-app §Screens, rules: the labels the rules list and editor
// show for a rule's match fields and action (req-notification-rules REQ-2,
// REQ-3). An unset match field reads as Any.

export type RuleEventKind = NonNullable<NotificationRule["event_kind"]>;
export type RulePriority = NonNullable<NotificationRule["priority"]>;
export type RuleAction = NotificationRule["action"];

// The five notifiable event kinds in the requirement's order.
export const EVENT_KINDS: { value: RuleEventKind; label: string }[] = [
  { value: "decision.created", label: "Decision created" },
  { value: "decision.expired", label: "Decision expired" },
  { value: "agent.stale", label: "Agent stale" },
  { value: "agent.status_changed", label: "Agent status changed" },
  { value: "agent.done", label: "Agent done" },
];

export const PRIORITIES: { value: RulePriority; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "urgent", label: "Urgent" },
];

export const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: "push", label: "Push" },
  { value: "digest", label: "Digest" },
  { value: "mute", label: "Mute" },
];

export const ANY = "Any";

// The name for a session that neither agents/app:liveAgents nor
// agents/app:recentAgents returns: it ended more than seven days ago or was
// purged. The backend's push messages use the same name.
export const ENDED_AGENT = "Ended agent";

// What a rule matches when no rule is set (req-notification-rules REQ-4).
export const DEFAULTS_EXPLANATION =
  "Without a rule, decision created and agent stale events push, decision expired and agent done events go to the daily digest, and agent status changes are muted.";

// How the backend picks among matching rules (req-notification-rules AC-3.2).
export const PRECEDENCE_EXPLANATION =
  "When several rules match an event, the rule with the most match fields set wins. Among rules with as many fields set, the most recently saved rule wins.";

export function eventKindLabel(kind: RuleEventKind | null): string {
  return EVENT_KINDS.find((choice) => choice.value === kind)?.label ?? ANY;
}

export function priorityLabel(priority: RulePriority | null): string {
  return PRIORITIES.find((choice) => choice.value === priority)?.label ?? ANY;
}

export function actionLabel(action: RuleAction): string {
  return ACTIONS.find((choice) => choice.value === action)?.label ?? action;
}

// A live agent by its card name; an ended recent agent with "(ended)".
export function agentChoiceLabel(agent: AgentSession): string {
  return agent.ended_at === null ? agent.display_name : `${agent.display_name} (ended)`;
}

// Live agents first in their query's order, then recent agents in theirs,
// each id once.
export function agentChoices(live: AgentSession[], recent: AgentSession[]): AgentSession[] {
  const seen = new Set<string>();
  const result: AgentSession[] = [];
  for (const agent of [...live, ...recent]) {
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      result.push(agent);
    }
  }
  return result;
}

// The agent a rule names: Any when unset, the agent's choice label when the
// person's live or recent agents include it, and Ended agent otherwise.
export function agentLabel(agentSessionId: string | null, agents: AgentSession[]): string {
  if (agentSessionId === null) {
    return ANY;
  }
  const agent = agents.find((candidate) => candidate.id === agentSessionId);
  return agent === undefined ? ENDED_AGENT : agentChoiceLabel(agent);
}

// The row's one-line description, also its accessibility label.
export function ruleSummary(rule: NotificationRule, agents: AgentSession[]): string {
  return [
    `Topic ${rule.topic ?? ANY}`,
    `Agent ${agentLabel(rule.agent_session_id, agents)}`,
    `Event ${eventKindLabel(rule.event_kind)}`,
    `Priority ${priorityLabel(rule.priority)}`,
    `Action ${actionLabel(rule.action)}`,
  ].join(", ");
}
