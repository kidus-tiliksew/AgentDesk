import type { AgentSession, StatusState } from "@agentdesk/contract";
import { useRouter } from "expo-router";
import { Fragment } from "react";
import { Pressable, View } from "react-native";
import { makeStyles, radius, spacing, useTheme } from "./theme";
import { Icon } from "./ui/icon";
import { Pill } from "./ui/pill";
import { type DotTone, StatusDot } from "./ui/status-dot";
import { AppText } from "./ui/text";
import { formatElapsed } from "./use-screen-clock";

const STATE_LABELS: Record<StatusState, string> = {
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  done: "Done",
};

export function stateLabel(state: StatusState | null): string {
  return state === null ? "No status yet" : STATE_LABELS[state];
}

// The color of a status state's dot: green while working, accent while
// waiting, amber while blocked (it needs a look, as the decision screen shows
// it), grey otherwise.
export function stateTone(state: StatusState | null): DotTone {
  switch (state) {
    case "working":
      return "green";
    case "waiting":
      return "accent";
    case "blocked":
      return "amber";
    default:
      return "grey";
  }
}

// An agent's dot in the inbox. Stale wins, because a stale agent's state may
// no longer hold; then an agent with pending decisions is waiting on the user.
export function agentTone(agent: AgentSession): DotTone {
  if (agent.stale) {
    return "amber";
  }
  return agent.pending_decision_count > 0 ? "accent" : stateTone(agent.state);
}

// Time since the last status update, as a row shows it.
function elapsedLabel(agent: AgentSession, now: number): string {
  return agent.status_at === null ? "No update yet" : formatElapsed(agent.status_at, now);
}

const useStyles = makeStyles((theme) => ({
  group: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    marginHorizontal: spacing.screen,
    overflow: "hidden",
  },
  separator: { backgroundColor: theme.separator, height: 0.5, marginLeft: 37 },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  grow: { flex: 1, gap: 2 },
}));

const pendingLabel = (count: number) =>
  count === 1 ? "1 pending decision" : `${count} pending decisions`;

// What VoiceOver reads after an agent row's name: every field the row shows,
// since the dot's color is not read (Apple HIG Accessibility: never convey
// state by color alone).
function agentDescription(agent: AgentSession, now: number): string {
  const pending = agent.pending_decision_count;
  // req-mobile-app AC-2.2: the count is always read, zero included, though
  // the row draws it only when there is one.
  return [
    stateLabel(agent.state),
    agent.line,
    `Topic ${agent.topic}`,
    agent.stale ? "Stale" : null,
    pendingLabel(pending),
    agent.status_at === null ? "No update yet" : `Updated ${formatElapsed(agent.status_at, now)}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

// One live agent as a row: its state dot, its display name as the title, so
// the row keeps its name while status updates arrive, then its status line (or
// its state before it has a line), then "topic · state · 2m ago" with the
// stale marker, and a pending count on the right when there are pending
// decisions (req-mobile-app AC-2.2). Pressing it opens the agent screen.
function AgentRow({ agent, now }: { agent: AgentSession; now: number }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const state = stateLabel(agent.state);
  const pending = agent.pending_decision_count;
  const meta = [agent.topic, state, elapsedLabel(agent, now)].join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Agent: ${agent.display_name}`}
      accessibilityValue={{ text: agentDescription(agent, now) }}
      onPress={() => router.push({ pathname: "/agent/[id]", params: { id: agent.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <StatusDot tone={agentTone(agent)} />
      <View style={styles.grow}>
        <AppText weight="600" numberOfLines={2}>
          {agent.display_name}
        </AppText>
        <AppText variant="subhead" tone="secondary" numberOfLines={2}>
          {agent.line ?? state}
        </AppText>
        <AppText variant="footnote" tone="secondary">
          {meta}
          {agent.stale ? " · " : null}
          {agent.stale ? (
            <AppText variant="footnote" tone="amber" weight="600">
              Stale
            </AppText>
          ) : null}
        </AppText>
      </View>
      {pending > 0 ? (
        // The wrapper centers the pill in the row; a pill aligns to the start.
        <View>
          <Pill label={`${pending} pending`} tone="accent" />
        </View>
      ) : null}
      <Icon name="chevron-forward" size={17} color={theme.textTertiary} />
    </Pressable>
  );
}

// The live agents as a grouped list in the order given.
export function AgentList({ agents, now }: { agents: AgentSession[]; now: number }) {
  const styles = useStyles();
  return (
    <View style={styles.group}>
      {agents.map((agent, index) => (
        <Fragment key={agent.id}>
          {index === 0 ? null : <View style={styles.separator} />}
          <AgentRow agent={agent} now={now} />
        </Fragment>
      ))}
    </View>
  );
}
