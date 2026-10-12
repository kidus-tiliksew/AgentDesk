import type { Answer, Decision, Option } from "@agentdesk/contract";
import { Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { DecisionAgent } from "./decision-agent";
import { DecisionLink, DecisionParent } from "./decision-parent";
import { formatDeadline } from "./decision-row";
import { styles } from "./styles";

// An option's label, or its id when the decision has no such option.
function optionLabel(options: readonly Option[] | null, id: string) {
  return options?.find((option) => option.id === id)?.label ?? id;
}

// An answer as the user reads it: Approve or Reject, option labels, or the
// text itself.
export function formatAnswer(answer: Answer, options: readonly Option[] | null): string {
  switch (answer.kind) {
    case "approve":
      return "Approve";
    case "reject":
      return "Reject";
    case "option":
      return optionLabel(options, answer.option_id);
    case "options":
      return answer.option_ids.map((id) => optionLabel(options, id)).join(", ");
    case "text":
      return answer.text;
  }
}

// Time left until `deadline` from `now`, in the two largest whole units. The
// label only presents the device clock: the backend alone expires a decision
// and applies its default (req-decision-requests REQ-5).
export function formatCountdown(deadline: string, now: number): string {
  const seconds = Math.floor((Date.parse(deadline) - now) / 1000);
  if (seconds <= 0) {
    return "Deadline passed";
  }
  if (seconds < 60) {
    return `${seconds}s left`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s left`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m left`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.line}>{value}</Text>
    </View>
  );
}

// Everything the decision screen shows above the answer controls: title,
// body as Markdown, recommendation, deadline with a live countdown while
// pending, default, priority, topic, agent, and parent and follow-up links
// (req-mobile-app AC-3.1; req-decision-requests AC-3.2, AC-6.2). A removed
// parent reads as unavailable (src/decision-parent.tsx).
export function DecisionDetail({ decision, now }: { decision: Decision; now: number }) {
  const { options } = decision;
  return (
    <View style={styles.list}>
      <Text accessibilityRole="header" style={styles.decisionTitle}>
        {decision.title}
      </Text>
      {decision.body === null ? null : <Markdown>{decision.body}</Markdown>}
      <Field
        label="Recommendation"
        value={
          decision.recommendation === null
            ? "No recommendation"
            : formatAnswer(decision.recommendation, options)
        }
      />
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Deadline</Text>
        <Text style={styles.line}>{formatDeadline(decision.deadline)}</Text>
        {decision.deadline !== null && decision.state === "pending" ? (
          <Text style={styles.countdown}>{formatCountdown(decision.deadline, now)}</Text>
        ) : null}
      </View>
      <Field
        label="Default"
        value={decision.default === null ? "No default" : formatAnswer(decision.default, options)}
      />
      <Field label="Priority" value={decision.priority === "urgent" ? "Urgent" : "Normal"} />
      <Field label="Topic" value={decision.topic} />
      <DecisionAgent agentSessionId={decision.agent_session_id} />
      {decision.parent_id === null ? null : <DecisionParent parentId={decision.parent_id} />}
      {decision.follow_up_ids.length === 0 ? null : (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Follow-ups</Text>
          {decision.follow_up_ids.map((id, index) => (
            <DecisionLink key={id} id={id} label={`Follow-up decision ${index + 1}`} />
          ))}
        </View>
      )}
    </View>
  );
}

function outcomeHeading(decision: Decision) {
  switch (decision.state) {
    case "answered":
      return "Answered";
    case "expired":
      return "Expired";
    default:
      return "Cancelled";
  }
}

// A settled decision's recorded outcome, read-only: answered, expired with
// its default applied, expired without an answer, or cancelled with no
// answer (req-decision-requests REQ-4, AC-4.3, AC-5.1, AC-5.2).
export function SettledOutcome({ decision }: { decision: Decision }) {
  const { answer } = decision;
  return (
    <View accessibilityLabel="Recorded outcome" style={styles.outcome}>
      <Text accessibilityRole="header" style={styles.heading}>
        {outcomeHeading(decision)}
      </Text>
      {answer === null ? (
        <Text style={styles.line}>
          {decision.state === "expired" ? "Expired without an answer" : "No answer was recorded."}
        </Text>
      ) : (
        <Field
          label={decision.applied_by_default ? "Default applied" : "Answer"}
          value={formatAnswer(answer, decision.options)}
        />
      )}
      {decision.note === null ? null : <Field label="Note" value={decision.note} />}
      {decision.answered_at === null ? null : (
        <Text style={styles.meta}>
          {`Answered ${new Date(decision.answered_at).toLocaleString()}`}
        </Text>
      )}
      {decision.answered_via === null ? null : (
        <Text style={styles.meta}>{`Via ${decision.answered_via}`}</Text>
      )}
    </View>
  );
}
