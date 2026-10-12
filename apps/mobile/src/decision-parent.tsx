import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { decisions } from "../../../convex/decisions/refs";
import { errorData, QueryErrorBoundary } from "./query-error-boundary";
import { styles } from "./styles";

// A link that opens another decision's screen.
export function DecisionLink({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => router.push({ pathname: "/decision/[id]", params: { id } })}
    >
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

// The decision screen's parent line. Removing a decision keeps its id on
// each follow-up's `parent_id` (component-decisions §Removal), so the parent
// is read in its own error boundary. A removed parent reads as unavailable,
// and a lookup failure never hides the follow-up or its answer controls.

function Unavailable() {
  return <Text style={styles.meta}>Parent decision unavailable</Text>;
}

// `decisions/app:get` answers `not_found` for a removed, missing, or foreign
// decision, and `invalid` naming `decisionId` for a malformed id.
function isGone(error: unknown) {
  const data = errorData(error);
  return (
    data !== null &&
    (data.code === errorCodeSchema.enum.not_found ||
      (data.code === errorCodeSchema.enum.invalid && data.field === "decisionId"))
  );
}

function ParentLink({ id }: { id: string }) {
  const parent = useQuery(decisions.app.get, { decisionId: id });
  if (parent === undefined) {
    return <Text style={styles.meta}>Loading parent</Text>;
  }
  return <DecisionLink id={id} label="Parent decision" />;
}

export function DecisionParent({ parentId }: { parentId: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Parent</Text>
      <QueryErrorBoundary
        key={parentId}
        fallback={(error, retry) =>
          isGone(error) ? (
            <Unavailable />
          ) : (
            <View style={styles.rowMeta}>
              <Text style={styles.error}>Could not load the parent decision.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry parent"
                onPress={retry}
              >
                <Text style={styles.link}>Retry</Text>
              </Pressable>
            </View>
          )
        }
      >
        <ParentLink id={parentId} />
      </QueryErrorBoundary>
    </View>
  );
}
