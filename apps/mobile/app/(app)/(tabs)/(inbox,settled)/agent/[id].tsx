import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { AccessibilityInfo, Linking, View } from "react-native";
import type {
  AgentSessionDetail,
  StatusHistoryEntry,
} from "../../../../../../../convex/agents/app";
import { agents } from "../../../../../../../convex/agents/refs";
import { stateLabel, stateTone } from "../../../../../src/agent-card";
import { Button } from "../../../../../src/button";
import { DecisionCard } from "../../../../../src/decision-row";
import { QuickAnswerScope, useQuickAnswers } from "../../../../../src/inbox-undo";
import { Loading } from "../../../../../src/loading";
import { errorData, QueryErrorBoundary } from "../../../../../src/query-error-boundary";
import { makeStyles } from "../../../../../src/theme";
import { Card } from "../../../../../src/ui/card";
import { EmptyState } from "../../../../../src/ui/empty-state";
import { Pill } from "../../../../../src/ui/pill";
import { StackScreen } from "../../../../../src/ui/screen";
import { SectionHeader } from "../../../../../src/ui/section-header";
import { StatusDot } from "../../../../../src/ui/status-dot";
import { AppText } from "../../../../../src/ui/text";
import { formatElapsed, useScreenClock } from "../../../../../src/use-screen-clock";

// component-mobile-app §Screens: one agent session's status, its pending
// decisions, and its history newest first. Nothing on it sends a message or
// command to the agent (req-agent-status REQ-5); its decisions answer like the
// inbox's.

const useStyles = makeStyles((theme) => ({
  statusCard: { marginTop: 6 },
  stateRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  grow: { flex: 1 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  link: { gap: 6, marginTop: 8 },
  cards: { gap: 10 },
  note: { paddingHorizontal: 20 },
  timeline: { paddingLeft: 26, paddingRight: 16 },
  entry: { flexDirection: "row", gap: 14, paddingBottom: 16 },
  rail: { alignItems: "center", paddingTop: 5, width: 10 },
  connector: { backgroundColor: theme.separator, flex: 1, marginTop: 4, width: 2 },
  entryBody: { flex: 1, gap: 2 },
  failure: { alignItems: "center", gap: 14, paddingHorizontal: 28, paddingTop: 48 },
}));

function Note({ children }: { children: string }) {
  const styles = useStyles();
  return (
    <AppText variant="subhead" tone="secondary" style={styles.note}>
      {children}
    </AppText>
  );
}

function NotFound() {
  return (
    <StackScreen>
      <Stack.Screen options={{ title: "Agent" }} />
      <EmptyState
        icon="help-circle-outline"
        title="Agent not found"
        body="This agent session does not exist or is not yours."
      />
    </StackScreen>
  );
}

// `agents/app:get` refuses a missing and a foreign session alike as
// `not_found`, and a malformed id as `invalid` naming `agentSessionId`. Both
// show the not-found state. Any other failure offers a retry.
function isNotFound(error: unknown) {
  const data = errorData(error);
  return (
    data !== null &&
    (data.code === errorCodeSchema.enum.not_found ||
      (data.code === errorCodeSchema.enum.invalid && data.field === "agentSessionId"))
  );
}

// The agent's link as a button that opens it, with the address below it in
// selectable text for copying.
function AgentLink({ url }: { url: string }) {
  const styles = useStyles();
  return (
    <View style={styles.link}>
      <Button
        label="Open link"
        accessibilityLabel={`Open ${url}`}
        variant="tinted"
        size="small"
        icon="open-outline"
        onPress={() => {
          void Linking.openURL(url);
        }}
      />
      <AppText selectable variant="footnote" tone="secondary" numberOfLines={2}>
        {url}
      </AppText>
    </View>
  );
}

// The session's current status: dot, state, and time since the update, the
// status line, its topic, the stale marker, its pending count, and its link
// (req-mobile-app AC-2.2). The dot's color repeats the state and the Stale
// pill, both written out, so no state is carried by color alone.
function StatusCard({ detail, now }: { detail: AgentSessionDetail; now: number }) {
  const styles = useStyles();
  const pending = detail.pending_decision_count;
  return (
    <Card style={styles.statusCard}>
      <View style={styles.stateRow}>
        <StatusDot tone={detail.stale ? "amber" : stateTone(detail.state)} />
        <AppText weight="600" style={styles.grow}>
          {stateLabel(detail.state)}
        </AppText>
        <AppText variant="footnote" tone="secondary">
          {detail.status_at === null ? "No update yet" : formatElapsed(detail.status_at, now)}
        </AppText>
      </View>
      {detail.line === null ? null : (
        <AppText variant="title3" weight="500">
          {detail.line}
        </AppText>
      )}
      <AppText variant="footnote" tone="secondary">
        {`${detail.display_name} · ${detail.topic}`}
      </AppText>
      <View style={styles.pills}>
        {detail.stale ? <Pill label="Stale" tone="amber" icon="alert-circle" /> : null}
        <Pill
          label={pending === 1 ? "1 pending decision" : `${pending} pending decisions`}
          tone={pending > 0 ? "accent" : "neutral"}
        />
      </View>
      {detail.link === null ? null : <AgentLink url={detail.link} />}
    </Card>
  );
}

// One earlier status on the timeline: a dot on a rail that joins it to the
// next entry, the state, the line, how long ago, and the link.
function TimelineEntry({
  entry,
  last,
  now,
}: {
  entry: StatusHistoryEntry;
  last: boolean;
  now: number;
}) {
  const styles = useStyles();
  return (
    <View style={styles.entry}>
      <View style={styles.rail}>
        <StatusDot tone={stateTone(entry.state)} />
        {last ? null : <View style={styles.connector} />}
      </View>
      <View style={styles.entryBody}>
        <AppText weight="600">{stateLabel(entry.state)}</AppText>
        <AppText variant="subhead">{entry.line}</AppText>
        <AppText variant="footnote" tone="secondary">
          {formatElapsed(entry.at, now)}
        </AppText>
        {entry.link === null ? null : (
          <AppText selectable variant="footnote" tone="accent">
            {entry.link}
          </AppText>
        )}
      </View>
    </View>
  );
}

function AgentDetail({ id }: { id: string }) {
  const styles = useStyles();
  const { hidden } = useQuickAnswers();
  const detail = useQuery(agents.app.get, { agentSessionId: id });
  const now = useScreenClock();
  if (detail === undefined) {
    return <Loading label="Loading agent" />;
  }
  // A decision answered from its card leaves the list while Undo is offered.
  const waiting = detail.pending_decisions.filter((decision) => !hidden.has(decision.id));
  return (
    <StackScreen>
      <Stack.Screen options={{ title: detail.display_name }} />
      <StatusCard detail={detail} now={now} />
      <SectionHeader
        title="Waiting on you"
        detail={waiting.length === 0 ? undefined : String(waiting.length)}
      />
      {waiting.length === 0 ? (
        <Note>No pending decisions.</Note>
      ) : (
        <View style={styles.cards}>
          {waiting.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              agentName={detail.display_name}
              now={now}
            />
          ))}
        </View>
      )}
      <SectionHeader title="Timeline" />
      {detail.history.length === 0 ? (
        <Note>No earlier statuses.</Note>
      ) : (
        <View style={styles.timeline}>
          {detail.history.map((entry, index) => (
            // History rows have no id. Two rows with the same time and
            // contents would render the same, so their fields form the key.
            <TimelineEntry
              key={`${entry.at}|${entry.state}|${entry.line}|${entry.link}`}
              entry={entry}
              last={index === detail.history.length - 1}
              now={now}
            />
          ))}
        </View>
      )}
    </StackScreen>
  );
}

const LOAD_FAILURE = "Could not load this agent.";

// VoiceOver speaks the failure when it appears, since the screen it replaces
// was the focus.
function AgentFailure({ retry }: { retry: () => void }) {
  const styles = useStyles();
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(LOAD_FAILURE);
  }, []);
  return (
    <StackScreen>
      <Stack.Screen options={{ title: "Agent" }} />
      <View style={styles.failure}>
        <AppText tone="red">{LOAD_FAILURE}</AppText>
        <Button label="Try again" onPress={retry} />
      </View>
    </StackScreen>
  );
}

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (typeof id !== "string" || id === "") {
    return <NotFound />;
  }
  return (
    <QueryErrorBoundary
      key={id}
      fallback={(error, retry) =>
        isNotFound(error) ? <NotFound /> : <AgentFailure retry={retry} />
      }
    >
      <QuickAnswerScope>
        <AgentDetail id={id} />
      </QuickAnswerScope>
    </QueryErrorBoundary>
  );
}
