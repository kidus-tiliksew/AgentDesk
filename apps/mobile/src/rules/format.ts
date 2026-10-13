import type { AgentSession } from "@agentdesk/contract";
import type { NotificationRule } from "../../../../convex/notifications/rules";
import type { IconName } from "../ui/icon";

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

// Each action's icon and tile color, after the iOS system colors the
// prototype's rules list uses: red bell for push, orange page for the digest,
// grey crossed-out bell for mute.
export const ACTION_LOOK: Record<RuleAction, { icon: IconName; color: string }> = {
  push: { icon: "notifications", color: "#ff3b30" },
  digest: { icon: "document-text", color: "#ff9500" },
  mute: { icon: "notifications-off", color: "#8e8e93" },
};

export const ANY = "Any";

// The name for a session that neither agents/app:liveAgents nor
// agents/app:recentAgents returns: it ended more than seven days ago or was
// purged. The backend's push messages use the same name.
export const ENDED_AGENT = "Ended agent";

// What an event of each kind does when no rule matches it, push first, then
// digest, then mute (req-notification-rules REQ-4; DEFAULT_ACTIONS in
// convex/notifications/route.ts).
export const DEFAULT_ROUTING: { kind: RuleEventKind; action: RuleAction }[] = [
  { kind: "decision.created", action: "push" },
  { kind: "agent.stale", action: "push" },
  { kind: "decision.expired", action: "digest" },
  { kind: "agent.done", action: "digest" },
  { kind: "agent.status_changed", action: "mute" },
];

// How the backend picks among matching rules (req-notification-rules AC-3.2).
export const PRECEDENCE_EXPLANATION =
  "When several rules match an event, the most specific wins: the rule with the most match fields set, then the most recently saved.";

// The rule editor's hint under the sentence, and the priority caveat.
export const SUBTOPIC_HINT = "A topic also matches its subtopics.";
export const PRIORITY_HINT = "Only decision events carry a priority.";
export const NO_MATCH = "Set at least one of topic, agent, event, or priority.";

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

// Where a rule applies, the bold line of its row: its topic and agent, or
// Everything when it names neither.
export function ruleWhere(rule: NotificationRule, agents: AgentSession[]): string {
  const parts = [
    ...(rule.topic === null ? [] : [rule.topic]),
    ...(rule.agent_session_id === null ? [] : [agentLabel(rule.agent_session_id, agents)]),
  ];
  return parts.length === 0 ? "Everything" : parts.join(" · ");
}

// What a rule does, the second line of its row: "Urgent · Decision created →
// Push", or "Any event → Mute" when it names no event kind.
export function ruleWhat(rule: NotificationRule): string {
  const event = rule.event_kind === null ? "Any event" : eventKindLabel(rule.event_kind);
  const priority = rule.priority === null ? "" : `${priorityLabel(rule.priority)} · `;
  return `${priority}${event} → ${actionLabel(rule.action)}`;
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
