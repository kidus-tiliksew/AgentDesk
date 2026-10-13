import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Stack, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import { identity } from "../../../../../../convex/identity/refs";
import { Button } from "../../../../src/button";
import { confirmDestructive } from "../../../../src/confirm";
import {
  connectionSpokenSummary,
  connectionSummary,
  groupByMachine,
} from "../../../../src/connections/format";
import { haptic } from "../../../../src/haptics";
import { Loading } from "../../../../src/loading";
import { QueryErrorBoundary } from "../../../../src/query-error-boundary";
import { makeStyles, useTheme } from "../../../../src/theme";
import { EmptyState } from "../../../../src/ui/empty-state";
import { GroupedSection } from "../../../../src/ui/grouped";
import { Icon } from "../../../../src/ui/icon";
import { StackScreen } from "../../../../src/ui/screen";
import { SwipeRow } from "../../../../src/ui/swipe-row";
import { AppText } from "../../../../src/ui/text";
import { useScreenClock } from "../../../../src/use-screen-clock";

// component-mobile-app §Screens: the signed-in person's connected harness
// clients, grouped by machine, each with its first-connected and last-used
// times, and a revoke action behind a swipe or a touch and hold, then a
// confirmation (req-accounts-and-connections REQ-4).
// `identity/connections:listConnections` is reactive, so a revoked connection
// leaves the list when the backend commits the revocation; the screen never
// removes a row itself.

type Connection = FunctionReturnType<typeof identity.connections.listConnections>[number];

const FOOTER =
  "Swipe left or touch and hold to revoke. A revoked harness fails its next tool call.";

const useStyles = makeStyles(() => ({
  row: { gap: 2, paddingHorizontal: 16, paddingVertical: 11 },
  error: { paddingBottom: 12, paddingHorizontal: 16 },
  failed: { alignItems: "center", gap: 12, padding: 24 },
  add: { paddingHorizontal: 4 },
}));

function connectionLabel(connection: Connection) {
  return connection.machineName === undefined
    ? connection.name
    : `${connection.name} on ${connection.machineName}`;
}

// Apple HIG Gestures: a swipe is never the only way to an action, so a touch
// and hold on the row and VoiceOver's Revoke action open the same
// confirmation. VoiceOver reads the row as one element: the harness and its
// machine, then both times in whole words.
function ConnectionRow({
  connection,
  now,
  busy,
  revoking,
  error,
  onRevoke,
}: {
  connection: Connection;
  now: number;
  busy: boolean;
  revoking: boolean;
  error: string | null;
  onRevoke: () => void;
}) {
  const styles = useStyles();
  // While a revocation runs, a swipe or touch and hold opens nothing.
  const revoke = busy ? () => {} : onRevoke;
  return (
    <View>
      <SwipeRow actionLabel="Revoke" onAction={revoke}>
        <Pressable
          accessibilityLabel={connectionLabel(connection)}
          accessibilityValue={{ text: connectionSpokenSummary(connection, now) }}
          accessibilityHint="Touch and hold to revoke."
          accessibilityState={{ busy: revoking }}
          accessibilityActions={[{ name: "Revoke", label: "Revoke" }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "Revoke") {
              revoke();
            }
          }}
          onLongPress={revoke}
          style={styles.row}
        >
          <AppText weight="600">{connection.name}</AppText>
          <AppText variant="footnote" tone="secondary">
            {revoking ? "Revoking..." : connectionSummary(connection, now)}
          </AppText>
        </Pressable>
      </SwipeRow>
      {error === null ? null : (
        <AppText variant="footnote" tone="red" style={styles.error}>
          {error}
        </AppText>
      )}
    </View>
  );
}

function ConnectionList() {
  const router = useRouter();
  const connections = useQuery(identity.connections.listConnections, {});

  if (connections === undefined) {
    return <Loading label="Loading connections" />;
  }

  if (connections.length === 0) {
    return (
      <EmptyState
        icon="desktop-outline"
        title="No machines connected"
        body="Run the AgentDesk installer on a computer, then enter the code it shows to connect its harnesses."
      >
        <Button label="Add machine" onPress={() => router.push("/settings/add-machine")} />
      </EmptyState>
    );
  }

  return <ConnectionGroups connections={connections} />;
}

// The listed connections and their revocation. It owns the revokeConnection
// hook, so the screen binds the mutation only when there is something to
// revoke.
function ConnectionGroups({ connections }: { connections: Connection[] }) {
  const now = useScreenClock();
  const revokeConnection = useMutation(identity.connections.revokeConnection);
  const [pendingId, setPendingId] = useState<Connection["credentialId"] | null>(null);
  const [failure, setFailure] = useState<{
    id: Connection["credentialId"];
    message: string;
  } | null>(null);
  // Set synchronously, so a second confirmation before the re-render sends
  // nothing.
  const pending = useRef(false);

  const revoke = async (connection: Connection) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setPendingId(connection.credentialId);
    setFailure(null);
    try {
      await revokeConnection({ credentialId: connection.credentialId });
      // Apple HIG Playing haptics: confirm a significant action's outcome.
      // The row leaves with the query, so VoiceOver hears why it went.
      haptic.success();
      AccessibilityInfo.announceForAccessibility(`Revoked ${connectionLabel(connection)}`);
    } catch {
      const message = `Could not revoke ${connection.name}. Try again.`;
      setFailure({ id: connection.credentialId, message });
      haptic.error();
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      pending.current = false;
      setPendingId(null);
    }
  };

  const confirm = (connection: Connection) => {
    setFailure(null);
    confirmDestructive({
      title: `Revoke ${connectionLabel(connection)}?`,
      message: "Its next tool call will fail.",
      action: "Revoke",
      onConfirm: () => void revoke(connection),
    });
  };

  const groups = groupByMachine(connections);
  return (
    <>
      {groups.map((group, index) => (
        <GroupedSection
          // A machine named "Other" would collide with the unknown-machine
          // group's title, so a group is keyed by its first connection.
          key={group.connections[0]?.credentialId}
          title={group.machine}
          footer={index === groups.length - 1 ? FOOTER : undefined}
        >
          {group.connections.map((connection) => (
            <ConnectionRow
              key={connection.credentialId}
              connection={connection}
              now={now}
              busy={pendingId !== null}
              revoking={pendingId === connection.credentialId}
              error={failure?.id === connection.credentialId ? failure.message : null}
              onRevoke={() => confirm(connection)}
            />
          ))}
        </GroupedSection>
      ))}
    </>
  );
}

// The header's + opens Add machine. It sits outside the query boundary, so a
// person can add a machine while the list loads, is empty, or failed to load.
function AddMachineButton() {
  const router = useRouter();
  const theme = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add machine"
      hitSlop={8}
      onPress={() => router.push("/settings/add-machine")}
      style={styles.add}
    >
      <Icon name="add" size={28} color={theme.accent} />
    </Pressable>
  );
}

export default function ConnectionsScreen() {
  const styles = useStyles();
  return (
    <>
      <Stack.Screen options={{ title: "Connections", headerRight: () => <AddMachineButton /> }} />
      <StackScreen>
        <QueryErrorBoundary
          fallback={(_error, retry) => (
            <View style={styles.failed}>
              <AppText tone="red">Could not load your connections.</AppText>
              <Button label="Try again" onPress={retry} />
            </View>
          )}
        >
          <ConnectionList />
        </QueryErrorBoundary>
      </StackScreen>
    </>
  );
}
