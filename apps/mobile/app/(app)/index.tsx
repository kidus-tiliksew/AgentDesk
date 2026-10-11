import { topicMatches } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { agents } from "../../../../convex/agents/refs";
import { decisions } from "../../../../convex/decisions/refs";
import { AgentList } from "../../src/agent-card";
import { Button } from "../../src/button";
import { DecisionList } from "../../src/decision-row";
import { QueryErrorBoundary } from "../../src/query-error-boundary";
import { styles } from "../../src/styles";
import { topicChips } from "../../src/topic-chips";
import { TopicFilter } from "../../src/topic-filter";
import { useScreenClock } from "../../src/use-screen-clock";

// component-mobile-app §Screens: the inbox. Pending decisions come first, then
// live agents (req-mobile-app REQ-2). Both lists are Convex reactive queries,
// so a creation, settlement, cancellation, or status change re-renders the
// screen without user action (AC-2.3). The screen keeps each query's order:
// `listPending` already sorts urgent first, then by deadline, then oldest
// (AC-2.1).
function Inbox() {
  const pending = useQuery(decisions.app.listPending, {});
  const live = useQuery(agents.app.liveAgents, {});
  const now = useScreenClock();
  const [selected, setSelected] = useState<string | null>(null);

  const loaded = pending !== undefined && live !== undefined;
  const chips = topicChips([
    ...(pending ?? []).map((decision) => decision.topic),
    ...(live ?? []).map((agent) => agent.topic),
  ]);
  // A selected topic that no longer appears in either list falls back to All
  // topics.
  if (loaded && selected !== null && !chips.includes(selected)) {
    setSelected(null);
  }
  const matches = (topic: string) => selected === null || topicMatches(selected, topic);
  const suffix = selected === null ? "." : ` in ${selected}.`;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <TopicFilter chips={chips} selected={selected} onSelect={setSelected} />
      <Text accessibilityRole="header" style={styles.heading}>
        Pending decisions
      </Text>
      {pending === undefined ? (
        <Text style={styles.empty}>Loading decisions</Text>
      ) : (
        <DecisionList
          decisions={pending.filter((decision) => matches(decision.topic))}
          empty={`No pending decisions${suffix}`}
        />
      )}
      <Text accessibilityRole="header" style={styles.heading}>
        Live agents
      </Text>
      {live === undefined ? (
        <Text style={styles.empty}>Loading agents</Text>
      ) : (
        <AgentList
          agents={live.filter((agent) => matches(agent.topic))}
          now={now}
          empty={`No live agents${suffix}`}
        />
      )}
    </ScrollView>
  );
}

export default function InboxScreen() {
  return (
    <QueryErrorBoundary
      fallback={(_error, retry) => (
        <View style={styles.centered}>
          <Text style={styles.error}>Could not load your inbox.</Text>
          <Button label="Try again" onPress={retry} />
        </View>
      )}
    >
      <Inbox />
    </QueryErrorBoundary>
  );
}
