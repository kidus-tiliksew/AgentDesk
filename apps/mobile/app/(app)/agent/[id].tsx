import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { agents } from "../../../../../convex/agents/refs";
import { AgentCard } from "../../../src/agent-card";
import { Button } from "../../../src/button";
import { DecisionList } from "../../../src/decision-row";
import { Loading } from "../../../src/loading";
import { errorData, QueryErrorBoundary } from "../../../src/query-error-boundary";
import { styles } from "../../../src/styles";
import { formatElapsed, useScreenClock } from "../../../src/use-screen-clock";

// component-mobile-app §Screens: one agent session's status, its history
// newest first, and its pending decisions. The screen is read-only: nothing
// on it sends a message or command to the agent (req-agent-status REQ-5).

function NotFound() {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: "Agent" }} />
      <Text style={styles.title}>Agent not found</Text>
      <Text style={styles.body}>This agent session does not exist or is not yours.</Text>
    </View>
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

function AgentDetail({ id }: { id: string }) {
  const detail = useQuery(agents.app.get, { agentSessionId: id });
  const now = useScreenClock();
  if (detail === undefined) {
    return <Loading label="Loading agent" />;
  }
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Stack.Screen options={{ title: detail.display_name }} />
      <AgentCard agent={detail} now={now} />
      {detail.link === null ? null : (
        <Text selectable style={styles.meta}>
          {detail.link}
        </Text>
      )}
      <Text accessibilityRole="header" style={styles.heading}>
        Pending decisions
      </Text>
      <DecisionList decisions={detail.pending_decisions} empty="No pending decisions." />
      <Text accessibilityRole="header" style={styles.heading}>
        History
      </Text>
      {detail.history.length === 0 ? (
        <Text style={styles.empty}>No earlier statuses.</Text>
      ) : (
        <View style={styles.list}>
          {detail.history.map((entry) => (
            // History rows have no id. Two rows with the same time and
            // contents would render the same, so their fields form the key.
            <View key={`${entry.at}|${entry.state}|${entry.line}|${entry.link}`} style={styles.row}>
              <View style={styles.rowMeta}>
                <Text style={styles.meta}>{entry.state}</Text>
                <Text style={styles.meta}>{formatElapsed(entry.at, now)}</Text>
              </View>
              <Text style={styles.line}>{entry.line}</Text>
              {entry.link === null ? null : (
                <Text selectable style={styles.meta}>
                  {entry.link}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
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
        isNotFound(error) ? (
          <NotFound />
        ) : (
          <View style={styles.centered}>
            <Stack.Screen options={{ title: "Agent" }} />
            <Text style={styles.error}>Could not load this agent.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )
      }
    >
      <AgentDetail id={id} />
    </QueryErrorBoundary>
  );
}
