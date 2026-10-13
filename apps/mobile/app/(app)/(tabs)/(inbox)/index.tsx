import { topicMatches } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { agents } from "../../../../../../convex/agents/refs";
import { decisions } from "../../../../../../convex/decisions/refs";
import { AgentList } from "../../../../src/agent-card";
import { Button } from "../../../../src/button";
import { DecisionCard } from "../../../../src/decision-row";
import { InboxEmpty, InboxLoading } from "../../../../src/inbox-empty";
import { QuickAnswerScope, useQuickAnswers } from "../../../../src/inbox-undo";
import { QueryErrorBoundary } from "../../../../src/query-error-boundary";
import { makeStyles } from "../../../../src/theme";
import { topicChips } from "../../../../src/topic-chips";
import { TopicFilter } from "../../../../src/topic-filter";
import { LargeTitleScreen } from "../../../../src/ui/screen";
import { SectionHeader } from "../../../../src/ui/section-header";
import { AppText } from "../../../../src/ui/text";
import { useScreenClock } from "../../../../src/use-screen-clock";

// The inbox shows this many decisions before "Show N more", so the agents
// stay in reach on a busy day.
const FIRST_DECISIONS = 3;

const useStyles = makeStyles(() => ({
  cards: { gap: 10 },
  note: { paddingHorizontal: 20 },
  more: { alignSelf: "flex-start", marginHorizontal: 4 },
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

// component-mobile-app §Screens: the inbox. Pending decisions come first as
// cards under "Needs you", then live agents as rows (req-mobile-app REQ-2).
// Both lists are Convex reactive queries, so a creation, settlement,
// cancellation, or status change re-renders the screen without user action
// (AC-2.3). The screen keeps each query's order: `listPending` already sorts
// urgent first, then by deadline, then oldest (AC-2.1). A decision answered
// from its card leaves the list at once, while its Undo is offered.
function Inbox() {
  const styles = useStyles();
  const { hidden: answered } = useQuickAnswers();
  const pending = useQuery(decisions.app.listPending, {});
  const live = useQuery(agents.app.liveAgents, {});
  const now = useScreenClock();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // The inbox waits for both lists, so it never shows one section's empty
  // note while the other is still loading.
  if (pending === undefined || live === undefined) {
    return <InboxLoading />;
  }
  const topics = new Set([
    ...pending.map((decision) => decision.topic),
    ...live.map((agent) => agent.topic),
  ]);
  // With one topic a filter could only show the same items, so the chips
  // appear from two topics on.
  const chips = topics.size > 1 ? topicChips(topics) : [];
  // A selected topic that no longer appears in either list falls back to All
  // topics.
  if (selected !== null && !chips.includes(selected)) {
    setSelected(null);
  }
  if (pending.length === 0 && live.length === 0) {
    return <InboxEmpty />;
  }
  // The topic filter applies to both sections with the rule notification
  // rules use (AC-2.4).
  const matches = (topic: string) => selected === null || topicMatches(selected, topic);
  const suffix = selected === null ? "." : ` in ${selected}.`;
  const shownDecisions = pending.filter(
    (decision) => matches(decision.topic) && !answered.has(decision.id),
  );
  const shownAgents = live.filter((agent) => matches(agent.topic));
  // A decision names its agent when that agent is live.
  const agentNames = new Map(live.map((agent) => [agent.id, agent.display_name]));
  const hidden = expanded ? 0 : shownDecisions.length - FIRST_DECISIONS;

  return (
    <>
      {chips.length > 0 ? (
        <TopicFilter chips={chips} selected={selected} onSelect={setSelected} />
      ) : null}
      <SectionHeader title="Needs you" detail={String(shownDecisions.length)} />
      {shownDecisions.length === 0 ? (
        <Note>{`No pending decisions${suffix}`}</Note>
      ) : (
        <View style={styles.cards}>
          {shownDecisions.slice(0, hidden > 0 ? FIRST_DECISIONS : undefined).map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              agentName={
                decision.agent_session_id === null
                  ? null
                  : (agentNames.get(decision.agent_session_id) ?? null)
              }
              now={now}
            />
          ))}
          {hidden > 0 ? (
            <View style={styles.more}>
              <Button
                label={`Show ${hidden} more`}
                variant="plain"
                size="small"
                onPress={() => setExpanded(true)}
              />
            </View>
          ) : null}
        </View>
      )}
      <SectionHeader title="Agents" detail={`${shownAgents.length} live`} />
      {shownAgents.length === 0 ? (
        <Note>{`No live agents${suffix}`}</Note>
      ) : (
        <AgentList agents={shownAgents} now={now} />
      )}
    </>
  );
}

const LOAD_FAILURE = "Could not load your inbox.";

// VoiceOver speaks the failure when it appears, since the lists it replaces
// were the focus.
function InboxFailure({ retry }: { retry: () => void }) {
  const styles = useStyles();
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(LOAD_FAILURE);
  }, []);
  return (
    <View style={styles.failure}>
      <AppText tone="red">{LOAD_FAILURE}</AppText>
      <Button label="Try again" onPress={retry} />
    </View>
  );
}

// The SafeAreaProvider measures the screen's own view, so its insets cover the
// large title header and the tab bar; the empty inbox centers between them.
export default function InboxScreen() {
  return (
    <QuickAnswerScope>
      <SafeAreaProvider>
        <LargeTitleScreen title="Inbox">
          <QueryErrorBoundary fallback={(_error, retry) => <InboxFailure retry={retry} />}>
            <Inbox />
          </QueryErrorBoundary>
        </LargeTitleScreen>
      </SafeAreaProvider>
    </QuickAnswerScope>
  );
}
