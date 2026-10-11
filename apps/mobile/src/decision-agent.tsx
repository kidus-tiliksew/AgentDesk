import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { agents } from "../../../convex/agents/refs";
import { errorData, QueryErrorBoundary } from "./query-error-boundary";
import { styles } from "./styles";

// The decision screen's agent line. It reads the asking session in its own
// error boundary, so an agent lookup failure never hides the decision or its
// answer controls (req-decision-requests REQ-7).

function Ended() {
  return <Text style={styles.meta}>Agent session ended</Text>;
}

// `agents/purge:run` deletes ended sessions after 7 days, and the decision
// keeps the dangling id, so `agents/app:get` answers `not_found`. A malformed
// id is `invalid` naming `agentSessionId`. Both read as an ended agent
// (component-agent-presence §Sweep).
function isGone(error: unknown) {
  const data = errorData(error);
  return (
    data !== null &&
    (data.code === errorCodeSchema.enum.not_found ||
      (data.code === errorCodeSchema.enum.invalid && data.field === "agentSessionId"))
  );
}

function AgentLink({ id }: { id: string }) {
  const router = useRouter();
  const session = useQuery(agents.app.get, { agentSessionId: id });
  if (session === undefined) {
    return <Text style={styles.meta}>Loading agent</Text>;
  }
  const name = session.ended_at === null ? session.display_name : `${session.display_name} (ended)`;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Agent: ${name}`}
      onPress={() => router.push({ pathname: "/agent/[id]", params: { id } })}
    >
      <Text style={styles.link}>{name}</Text>
    </Pressable>
  );
}

export function DecisionAgent({ agentSessionId }: { agentSessionId: string | null }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Agent</Text>
      {agentSessionId === null ? (
        <Ended />
      ) : (
        <QueryErrorBoundary
          key={agentSessionId}
          fallback={(error, retry) =>
            isGone(error) ? (
              <Ended />
            ) : (
              <View style={styles.rowMeta}>
                <Text style={styles.error}>Could not load the agent.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry agent"
                  onPress={retry}
                >
                  <Text style={styles.link}>Retry</Text>
                </Pressable>
              </View>
            )
          }
        >
          <AgentLink id={agentSessionId} />
        </QueryErrorBoundary>
      )}
    </View>
  );
}
