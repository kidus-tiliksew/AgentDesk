import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Stack } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { identity } from "../../../../../convex/identity/refs";
import { Button } from "../../../src/button";
import { formatConnectionTime } from "../../../src/connections/format";
import { Loading } from "../../../src/loading";
import { QueryErrorBoundary } from "../../../src/query-error-boundary";
import { styles } from "../../../src/styles";

// component-mobile-app §Screens: the signed-in person's connected harness
// clients, each with its machine and times, and a revoke action
// (req-accounts-and-connections REQ-4). `identity/connections:listConnections`
// is reactive, so a revoked connection leaves the list when the backend
// commits the revocation; the screen never removes a row itself.

type Connection = FunctionReturnType<typeof identity.connections.listConnections>[number];
type Revoke = (args: { credentialId: Connection["credentialId"] }) => Promise<null>;

function connectionLabel(connection: Connection) {
  return connection.machineName === undefined
    ? connection.name
    : `${connection.name} on ${connection.machineName}`;
}

// The open confirmation in a row. It owns the revokeConnection hook, so the
// screen binds the mutation only while a person is confirming a revocation.
function RevokeConfirmation({
  connection,
  busy,
  onConfirm,
  onCancel,
}: {
  connection: Connection;
  busy: boolean;
  onConfirm: (revoke: Revoke) => void;
  onCancel: () => void;
}) {
  const revoke = useMutation(identity.connections.revokeConnection);
  return (
    <View style={styles.outcome}>
      <Text style={styles.line}>
        Revoke {connectionLabel(connection)}? Its next tool call will be refused.
      </Text>
      <Button label="Revoke connection" onPress={() => onConfirm(revoke)} disabled={busy} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onCancel}
      >
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function ConnectionRow({
  connection,
  confirming,
  busy,
  error,
  onRevoke,
  onConfirm,
  onCancel,
}: {
  connection: Connection;
  confirming: boolean;
  busy: boolean;
  error: string | null;
  onRevoke: () => void;
  onConfirm: (revoke: Revoke) => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{connection.name}</Text>
      <Text style={styles.meta}>{connection.machineName ?? "Machine unknown"}</Text>
      <Text style={styles.meta}>
        First connected {formatConnectionTime(connection.firstConnectedAt)}
      </Text>
      <Text style={styles.meta}>
        {connection.lastUsedAt === undefined
          ? "Never used"
          : `Last used ${formatConnectionTime(connection.lastUsedAt)}`}
      </Text>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      {confirming ? (
        <RevokeConfirmation
          connection={connection}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Revoke ${connectionLabel(connection)}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onRevoke}
        >
          <Text style={styles.link}>Revoke</Text>
        </Pressable>
      )}
    </View>
  );
}

function ConnectionList() {
  const connections = useQuery(identity.connections.listConnections, {});
  const [confirmingId, setConfirmingId] = useState<Connection["credentialId"] | null>(null);
  const [pendingId, setPendingId] = useState<Connection["credentialId"] | null>(null);
  const [failure, setFailure] = useState<{
    id: Connection["credentialId"];
    message: string;
  } | null>(null);
  // Set synchronously, so a second press before the re-render sends nothing.
  const pending = useRef(false);

  if (connections === undefined) {
    return <Loading label="Loading connections" />;
  }

  const confirm = async (connection: Connection, revoke: Revoke) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setPendingId(connection.credentialId);
    setFailure(null);
    try {
      await revoke({ credentialId: connection.credentialId });
      setConfirmingId(null);
    } catch {
      setFailure({
        id: connection.credentialId,
        message: `Could not revoke ${connection.name}. Try again.`,
      });
    } finally {
      pending.current = false;
      setPendingId(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {connections.length === 0 ? (
        <Text style={styles.empty}>No connected harnesses.</Text>
      ) : (
        <View style={styles.list}>
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.credentialId}
              connection={connection}
              confirming={confirmingId === connection.credentialId}
              busy={pendingId !== null}
              error={failure?.id === connection.credentialId ? failure.message : null}
              onRevoke={() => {
                setFailure(null);
                setConfirmingId(connection.credentialId);
              }}
              onConfirm={(revoke) => void confirm(connection, revoke)}
              onCancel={() => setConfirmingId(null)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

export default function ConnectionsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Connections" }} />
      <QueryErrorBoundary
        fallback={(_error, retry) => (
          <View style={styles.centered}>
            <Text style={styles.error}>Could not load your connections.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )}
      >
        <ConnectionList />
      </QueryErrorBoundary>
    </>
  );
}
