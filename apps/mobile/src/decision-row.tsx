import type { Decision } from "@agentdesk/contract";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { styles } from "./styles";

export function formatDeadline(deadline: string | null): string {
  return deadline === null ? "No deadline" : `Due ${new Date(deadline).toLocaleString()}`;
}

// One pending decision: title, topic, priority, and deadline. Pressing it
// opens the decision screen. The row offers no answer; the decision screen
// owns answering.
export function DecisionRow({ decision }: { decision: Decision }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Decision: ${decision.title}`}
      onPress={() => router.push({ pathname: "/decision/[id]", params: { id: decision.id } })}
      style={styles.row}
    >
      <Text style={styles.rowTitle}>{decision.title}</Text>
      <View style={styles.rowMeta}>
        <Text style={styles.meta}>{decision.topic}</Text>
        <Text style={decision.priority === "urgent" ? styles.urgent : styles.meta}>
          {decision.priority === "urgent" ? "Urgent" : "Normal"}
        </Text>
        <Text style={styles.meta}>{formatDeadline(decision.deadline)}</Text>
      </View>
    </Pressable>
  );
}

// A list of decision rows in the order given, or `empty` when there are none.
export function DecisionList({ decisions, empty }: { decisions: Decision[]; empty: string }) {
  if (decisions.length === 0) {
    return <Text style={styles.empty}>{empty}</Text>;
  }
  return (
    <View style={styles.list}>
      {decisions.map((decision) => (
        <DecisionRow key={decision.id} decision={decision} />
      ))}
    </View>
  );
}
