import type { Decision } from "@agentdesk/contract";
import { View } from "react-native";
import { DecisionAgent } from "./decision-agent";
import { DecisionBody } from "./decision-markdown";
import { formatAnswer, formatWhen } from "./decision-outcome";
import { DecisionFollowUps, DecisionParent } from "./decision-parent";
import { makeStyles } from "./theme";
import { Pill } from "./ui/pill";
import { AppText } from "./ui/text";

// The history list and the notification actions read answers through here.
export { formatAnswer };

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

// How long ago the agent asked, for the context line.
function formatAge(createdAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// Under five minutes left the countdown turns red like an urgent one
// (prototype "Decision: approve / reject").
const SOON_MS = 5 * 60_000;

const useStyles = makeStyles(() => ({
  context: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  title: { paddingBottom: 10, paddingHorizontal: 20, paddingTop: 8 },
  pills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingBottom: 14,
    paddingHorizontal: 20,
  },
  thread: { gap: 4, paddingTop: 4 },
}));

function DeadlinePill({ decision, now }: { decision: Decision; now: number }) {
  const { deadline } = decision;
  if (deadline === null) {
    return decision.state === "pending" ? <Pill label="No deadline" icon="time-outline" /> : null;
  }
  const absolute = new Date(deadline).toLocaleString();
  if (decision.state !== "pending") {
    return (
      <Pill
        label={`Deadline ${formatWhen(deadline, now)}`}
        accessibilityLabel={`Deadline ${absolute}`}
      />
    );
  }
  const soon = Date.parse(deadline) - now < SOON_MS;
  const countdown = formatCountdown(deadline, now);
  // Apple HIG VoiceOver: the pill reads the exact due time with the
  // countdown, since the visible text is only the time left.
  return (
    <Pill
      label={countdown}
      icon="time-outline"
      tone={soon || decision.priority === "urgent" ? "red" : "neutral"}
      accessibilityLabel={
        Date.parse(deadline) <= now
          ? `Deadline passed, ${absolute}`
          : `Deadline ${absolute}, ${countdown}`
      }
    />
  );
}

// Everything the decision screen shows above the answer controls: the agent
// and age, the title, one wrap of pills (deadline with a live countdown while
// pending, priority, default, topic, and once settled the recommendation),
// the body as Markdown, and the parent and follow-up links
// (req-mobile-app AC-3.1; req-decision-requests AC-3.2, AC-6.2). While
// pending, the recommendation sits on the answer controls instead
// (src/decision-answer-form.tsx). A settled decision reads in the
// secondary color under its outcome banner.
export function DecisionDetail({ decision, now }: { decision: Decision; now: number }) {
  const styles = useStyles();
  const { options } = decision;
  const settled = decision.state !== "pending";
  return (
    <View>
      <View style={styles.context}>
        <DecisionAgent agentSessionId={decision.agent_session_id} />
        <AppText variant="footnote" tone="secondary">
          {`· ${formatAge(decision.created_at, now)}`}
        </AppText>
      </View>
      <AppText accessibilityRole="header" variant="title2" weight="700" style={styles.title}>
        {decision.title}
      </AppText>
      <View style={styles.pills}>
        {settled && decision.recommendation !== null ? (
          <Pill
            label={`Recommended: ${formatAnswer(decision.recommendation, options)}`}
            icon="sparkles"
          />
        ) : null}
        <DeadlinePill decision={decision} now={now} />
        {decision.priority === "urgent" ? <Pill label="Urgent" icon="flash" tone="red" /> : null}
        {decision.default === null ? (
          settled ? null : (
            <Pill label="No default" />
          )
        ) : (
          <Pill label={`Default: ${formatAnswer(decision.default, options)}`} />
        )}
        <Pill label={decision.topic} icon="pricetag-outline" />
      </View>
      {decision.body === null ? null : <DecisionBody body={decision.body} muted={settled} />}
      {decision.parent_id === null && decision.follow_up_ids.length === 0 ? null : (
        <View style={styles.thread}>
          {decision.parent_id === null ? null : <DecisionParent parentId={decision.parent_id} />}
          {decision.follow_up_ids.length === 0 ? null : (
            <DecisionFollowUps ids={decision.follow_up_ids} />
          )}
        </View>
      )}
    </View>
  );
}
