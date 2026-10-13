import { type AgentSession, errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { agents } from "../../../convex/agents/refs";
import { stateLabel } from "./agent-card";
import { errorData, QueryErrorBoundary } from "./query-error-boundary";
import { makeStyles } from "./theme";
import { type DotTone, StatusDot } from "./ui/status-dot";
import { AppText, type TextTone } from "./ui/text";

// The agent at the start of the decision screen's context line: a status dot,
// the asking session's name, and its state in words, e.g. "Claude Code ·
// Blocked · 3m ago" (prototype "Decision: approve / reject"). It
// reads the session in its own error boundary, so an agent lookup failure
// never hides the decision or its answer controls (req-decision-requests
// REQ-7).

const useStyles = makeStyles(() => ({
  row: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: 8 },
}));

// Apple HIG Accessibility: color is never the only carrier of state, so the
// dot's state is also written after the name. The dot uses the shared status
// colors: grey for an ended session (its name says "ended") and one with no
// status yet, amber for a stale or blocked one (both need a look; red stays
// for urgent and destructive, DEC-9(3)), and otherwise the agent's state.
// Blocked and stale are written in amber as well.
function agentState(session: AgentSession): {
  dot: DotTone;
  label: string | null;
  tone: TextTone;
} {
  if (session.ended_at !== null) {
    return { dot: "grey", label: null, tone: "secondary" };
  }
  if (session.stale) {
    return { dot: "amber", label: "Stale", tone: "amber" };
  }
  switch (session.state) {
    case null:
      return { dot: "grey", label: null, tone: "secondary" };
    case "working":
      return { dot: "green", label: stateLabel(session.state), tone: "secondary" };
    case "waiting":
      return { dot: "accent", label: stateLabel(session.state), tone: "secondary" };
    case "blocked":
      return { dot: "amber", label: stateLabel(session.state), tone: "amber" };
    case "done":
      return { dot: "grey", label: stateLabel(session.state), tone: "secondary" };
  }
}

// Apple HIG Buttons: a text link keeps a 44 pt hit region.
const LINK_HIT_SLOP = { top: 16, bottom: 16, left: 8, right: 8 };

function Line({ tone, children }: { tone: DotTone; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <StatusDot tone={tone} />
      {children}
    </View>
  );
}

function Ended() {
  return (
    <Line tone="grey">
      <AppText variant="footnote" tone="secondary">
        Agent session ended
      </AppText>
    </Line>
  );
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
    return (
      <Line tone="grey">
        <AppText variant="footnote" tone="secondary">
          Loading agent
        </AppText>
      </Line>
    );
  }
  const name = session.ended_at === null ? session.display_name : `${session.display_name} (ended)`;
  const state = agentState(session);
  return (
    <Line tone={state.dot}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Agent: ${name}`}
        hitSlop={LINK_HIT_SLOP}
        onPress={() => router.push({ pathname: "/agent/[id]", params: { id } })}
      >
        <AppText variant="footnote" tone="accent" weight="600" numberOfLines={1}>
          {name}
        </AppText>
      </Pressable>
      {state.label === null ? null : (
        <AppText
          variant="footnote"
          tone={state.tone}
          weight={state.tone === "secondary" ? undefined : "600"}
        >
          {`· ${state.label}`}
        </AppText>
      )}
    </Line>
  );
}

export function DecisionAgent({ agentSessionId }: { agentSessionId: string | null }) {
  if (agentSessionId === null) {
    return <Ended />;
  }
  return (
    <QueryErrorBoundary
      key={agentSessionId}
      fallback={(error, retry) =>
        isGone(error) ? (
          <Ended />
        ) : (
          <Line tone="red">
            <AppText variant="footnote" tone="red">
              Could not load the agent.
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry agent"
              hitSlop={LINK_HIT_SLOP}
              onPress={retry}
            >
              <AppText variant="footnote" tone="accent" weight="600">
                Retry
              </AppText>
            </Pressable>
          </Line>
        )
      }
    >
      <AgentLink id={agentSessionId} />
    </QueryErrorBoundary>
  );
}
