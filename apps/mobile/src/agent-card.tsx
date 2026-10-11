import type { AgentSession } from "@agentdesk/contract";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { styles } from "./styles";
import { formatElapsed } from "./use-screen-clock";

function pendingLabel(count: number) {
  return count === 1 ? "1 pending decision" : `${count} pending decisions`;
}

// An agent session's card: display name, topic, state, status line, time
// since the last status update, pending decision count, and a stale marker
// when the backend marks the session stale (req-mobile-app AC-2.2). A session
// that has not reported a status yet says so. `now` comes from the screen's
// clock. With `onPress` the card is a button; without it, it is read-only.
export function AgentCard({
  agent,
  now,
  onPress,
}: {
  agent: AgentSession;
  now: number;
  onPress?: () => void;
}) {
  const body = (
    <>
      <View style={styles.rowMeta}>
        <Text style={styles.rowTitle}>{agent.display_name}</Text>
        {agent.stale ? <Text style={styles.stale}>Stale</Text> : null}
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.meta}>{agent.topic}</Text>
        <Text style={styles.meta}>{agent.state ?? "No status yet"}</Text>
      </View>
      {agent.line === null ? null : <Text style={styles.line}>{agent.line}</Text>}
      <View style={styles.rowMeta}>
        <Text style={styles.meta}>
          {agent.status_at === null
            ? "No update yet"
            : `Updated ${formatElapsed(agent.status_at, now)}`}
        </Text>
        <Text style={styles.meta}>{pendingLabel(agent.pending_decision_count)}</Text>
      </View>
    </>
  );
  if (onPress === undefined) {
    return <View style={styles.row}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Agent: ${agent.display_name}`}
      onPress={onPress}
      style={styles.row}
    >
      {body}
    </Pressable>
  );
}

// The live agent cards in the order given, each opening its agent screen, or
// `empty` when there are none.
export function AgentList({
  agents,
  now,
  empty,
}: {
  agents: AgentSession[];
  now: number;
  empty: string;
}) {
  const router = useRouter();
  if (agents.length === 0) {
    return <Text style={styles.empty}>{empty}</Text>;
  }
  return (
    <View style={styles.list}>
      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          now={now}
          onPress={() => router.push({ pathname: "/agent/[id]", params: { id: agent.id } })}
        />
      ))}
    </View>
  );
}
