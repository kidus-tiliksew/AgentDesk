import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { identity } from "../../../convex/identity/refs";
import { Button } from "./button";
import { QueryErrorBoundary } from "./query-error-boundary";
import { useTheme } from "./theme";
import { EmptyState } from "./ui/empty-state";
import { SCREEN_BOTTOM_PADDING } from "./ui/screen";

// Centers its content in the part of the screen the large title and the tab
// bar leave visible, which the inbox screen's own SafeAreaProvider measures;
// the scroll view's bottom padding comes off too, so the content does not
// scroll.
function Centered({ children }: { children: ReactNode }) {
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const visible = frame.height - insets.top - insets.bottom - SCREEN_BOTTOM_PADDING;
  return <View style={{ justifyContent: "center", minHeight: visible }}>{children}</View>;
}

function Spinner() {
  const theme = useTheme();
  return <ActivityIndicator accessibilityLabel="Loading inbox" color={theme.textSecondary} />;
}

// The inbox until it knows what to show. The empty inbox keeps the same
// spinner while it reads the connections, so opening the app goes from the
// spinner straight to the inbox's content.
export function InboxLoading() {
  return (
    <Centered>
      <Spinner />
    </Centered>
  );
}

function CaughtUp() {
  return (
    <EmptyState
      icon="checkmark-done-circle-outline"
      title="All caught up"
      body="No decisions need you and no agents are working."
    />
  );
}

// With no connected machine, nothing can ever reach the inbox, so the empty
// inbox explains how to connect one instead.
function FirstMachine() {
  const router = useRouter();
  return (
    <EmptyState
      icon="terminal-outline"
      title="Connect your first machine"
      body="Run the AgentDesk installer on the computer where your agents run. It shows a code you approve here."
    >
      <Button label="Enter installer code" onPress={() => router.push("/settings/add-machine")} />
    </EmptyState>
  );
}

// Which empty state the connections list calls for. The connections screen
// reads the same reactive query, so connecting a machine switches the inbox
// to "All caught up" without user action.
function ConnectionAwareEmpty() {
  const connections = useQuery(identity.connections.listConnections, {});
  if (connections === undefined) {
    return <Spinner />;
  }
  return connections.length === 0 ? <FirstMachine /> : <CaughtUp />;
}

// The inbox with no pending decision and no live agent. The connections query
// only picks the empty state's copy, so its failure falls back to "All caught
// up" rather than failing the inbox.
export function InboxEmpty() {
  return (
    <Centered>
      <QueryErrorBoundary fallback={() => <CaughtUp />}>
        <ConnectionAwareEmpty />
      </QueryErrorBoundary>
    </Centered>
  );
}
