import type { RuleAction, RuleEventKind, RulePriority } from "./format";

// component-mobile-app §Screens, rules: the words of the rule editor's
// sentence, "When [event] by [agent] in [topic] with [priority] priority,",
// and of its preview (prototype frame "Rule editor"). Each bracket is the
// lower-case reading of one match field; an unset field reads as "any".

const EVENT_PHRASES: Record<RuleEventKind, string> = {
  "decision.created": "a decision is created",
  "decision.expired": "a decision expires",
  "agent.stale": "an agent goes stale",
  "agent.status_changed": "an agent changes status",
  "agent.done": "an agent is done",
};

// What the preview calls the events a rule matches, by event kind.
const EVENT_SUBJECTS: Record<RuleEventKind, string> = {
  "decision.created": "New decisions",
  "decision.expired": "Expired decisions",
  "agent.stale": "Stale agent alerts",
  "agent.status_changed": "Agent status changes",
  "agent.done": "Agent done alerts",
};

const DECISION_KINDS: readonly RuleEventKind[] = ["decision.created", "decision.expired"];

const OUTCOMES: Record<RuleAction, string> = {
  push: "will push to this phone. Quiet hours still apply.",
  digest: "will wait for the daily digest.",
  mute: "will not notify you.",
};

export function eventPhrase(kind: RuleEventKind | null): string {
  return kind === null ? "any event" : EVENT_PHRASES[kind];
}

export function topicPhrase(topic: string): string {
  const trimmed = topic.trim();
  return trimmed === "" ? "any topic" : trimmed;
}

export function priorityPhrase(priority: RulePriority | null): string {
  return priority === null ? "any" : priority;
}

// The rule in plain words, or null while it matches nothing in particular. A
// priority on an agent event can never match, since only decision events
// carry one, and the preview says so.
export function rulePreview(rule: {
  topic: string;
  agent: string | null;
  eventKind: RuleEventKind | null;
  priority: RulePriority | null;
  action: RuleAction;
}): string | null {
  const topic = rule.topic.trim();
  if (topic === "" && rule.agent === null && rule.eventKind === null && rule.priority === null) {
    return null;
  }
  if (
    rule.priority !== null &&
    rule.eventKind !== null &&
    !DECISION_KINDS.includes(rule.eventKind)
  ) {
    return "This rule never matches: agent events carry no priority.";
  }
  let subject: string;
  if (rule.eventKind === null) {
    subject = rule.priority === null ? "Every event" : `Every ${rule.priority} decision event`;
  } else if (rule.priority === null) {
    subject = EVENT_SUBJECTS[rule.eventKind];
  } else {
    subject = EVENT_SUBJECTS[rule.eventKind].replace(/ decisions$/, ` ${rule.priority} decisions`);
  }
  const from = rule.agent === null ? "" : ` from ${rule.agent}`;
  const where = topic === "" ? "" : ` in ${topic} and its subtopics`;
  return `${subject}${from}${where} ${OUTCOMES[rule.action]}`;
}
