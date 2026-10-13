import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { type Href, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Fragment, type ReactNode, useEffect } from "react";
import { AccessibilityInfo, Pressable, useWindowDimensions, View } from "react-native";
import { decisions } from "../../../../../../../convex/decisions/refs";
import type {
  DigestDecision,
  DigestEvent,
} from "../../../../../../../convex/notifications/digests";
import { notifications } from "../../../../../../../convex/notifications/refs";
import { Button } from "../../../../../src/button";
import { DecisionCard } from "../../../../../src/decision-row";
import { QuickAnswerScope, STACK_FONT_SCALE, useQuickAnswers } from "../../../../../src/inbox-undo";
import { Loading } from "../../../../../src/loading";
import { isRecordId } from "../../../../../src/notification-route";
import { errorData, QueryErrorBoundary } from "../../../../../src/query-error-boundary";
import { actionLabel, ENDED_AGENT, EVENT_KINDS } from "../../../../../src/rules/format";
import { makeStyles, radius, spacing, type Theme, useTheme } from "../../../../../src/theme";
import { EmptyState } from "../../../../../src/ui/empty-state";
import { Icon, type IconName } from "../../../../../src/ui/icon";
import { StackScreen } from "../../../../../src/ui/screen";
import { SectionHeader } from "../../../../../src/ui/section-header";
import { AppText } from "../../../../../src/ui/text";
import { useScreenClock } from "../../../../../src/use-screen-clock";

// component-mobile-app §Screens, digest: one digest a digest push opened
// (req-mobile-app REQ-4; req-notification-rules AC-6.3). The screen reads
// `notifications/digests:get`: the decisions that were pending when the
// digest was sent, in the backend's order and in their current state, then
// the digest's events. Decisions still pending answer in place like the
// inbox's; the digest read lacks their input type and recommendation, so the
// screen takes those from `decisions/app:listPending`.

const EVENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(EVENT_KINDS.map((choice) => [choice.value, choice.label])),
  "decision.answered": "Decision answered",
  "decision.cancelled": "Decision cancelled",
};

const useStyles = makeStyles((theme) => ({
  heading: { gap: 2, paddingBottom: 12, paddingHorizontal: 20, paddingTop: 6 },
  stats: { flexDirection: "row", gap: 8, paddingHorizontal: spacing.screen },
  stackedStats: { flexDirection: "column" },
  // Sized by its text and padding, never a fixed height, so it grows with
  // Dynamic Type.
  stat: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    flex: 1,
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  stackedStat: { flex: 0 },
  cards: { gap: 10 },
  note: { paddingHorizontal: 20 },
  group: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    marginHorizontal: spacing.screen,
    overflow: "hidden",
  },
  separator: { backgroundColor: theme.separator, height: 0.5, marginLeft: 16 },
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
  failure: { alignItems: "center", gap: 14, paddingHorizontal: 28, paddingTop: 48 },
}));

// An instant from the query, in the device's locale and time zone.
function formatInstant(at: string): string {
  return new Date(at).toLocaleString();
}

// The digest's send time as its heading shows it: "Tuesday, 13 October ·
// 09:00" in the device's locale.
function formatSentAt(at: string): string {
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

function NotFound() {
  return (
    <StackScreen>
      <Stack.Screen options={{ title: "Digest" }} />
      <EmptyState
        icon="help-circle-outline"
        title="Digest not found"
        body="This digest does not exist or is not yours."
      />
    </StackScreen>
  );
}

// `notifications/digests:get` refuses a missing and a foreign digest alike as
// `not_found`, and a malformed id as `invalid` naming `digestId`. Both show
// the not-found state. Any other failure offers a retry.
function isNotFound(error: unknown) {
  const data = errorData(error);
  return (
    data !== null &&
    (data.code === errorCodeSchema.enum.not_found ||
      (data.code === errorCodeSchema.enum.invalid && data.field === "digestId"))
  );
}

function Note({ children }: { children: string }) {
  const styles = useStyles();
  return (
    <AppText variant="subhead" tone="secondary" style={styles.note}>
      {children}
    </AppText>
  );
}

// Rows on one rounded card with hairline separators.
function Group({ children }: { children: ReactNode[] }) {
  const styles = useStyles();
  return (
    <View style={styles.group}>
      {children.map((child, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
        <Fragment key={index}>
          {index === 0 ? null : <View style={styles.separator} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

function Stat({
  count,
  label,
  color,
  stacked,
}: {
  count: number;
  label: string;
  color: string;
  stacked: boolean;
}) {
  const styles = useStyles();
  return (
    <View
      accessible
      accessibilityLabel={`${count} ${label}`}
      style={[styles.stat, stacked && styles.stackedStat]}
    >
      <AppText variant="title2" style={{ color }}>
        {String(count)}
      </AppText>
      <AppText variant="footnote" tone="secondary">
        {label}
      </AppText>
    </View>
  );
}

// A settled decision's outcome: its label, icon, and color.
function outcome(
  decision: DigestDecision,
  theme: Theme,
): { label: string; icon: IconName; color: string } {
  switch (decision.state) {
    case "answered":
      return {
        label: decision.applied_by_default ? "Answered by default" : "Answered",
        icon: "checkmark-circle",
        // A default applied at the deadline is accent, as on the decision
        // screen and in History; an answer the person gave is green.
        color: decision.applied_by_default ? theme.accent : theme.green,
      };
    case "expired":
      return { label: "Expired", icon: "time-outline", color: theme.grey };
    case "cancelled":
      return { label: "Cancelled", icon: "close-circle-outline", color: theme.grey };
    default:
      return { label: "Pending", icon: "ellipse-outline", color: theme.accent };
  }
}

// One decision that settled after the digest was sent, with its outcome.
// Pressing it opens the decision screen and its recorded outcome.
function SettledRow({ decision }: { decision: DigestDecision }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const result = outcome(decision, theme);
  const meta = [
    decision.agent_name,
    decision.topic,
    ...(decision.priority === "urgent" ? ["Urgent"] : []),
  ].join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Decision: ${decision.title}, ${result.label}`}
      accessibilityValue={{ text: meta.replaceAll(" · ", ", ") }}
      onPress={() => router.push({ pathname: "/decision/[id]", params: { id: decision.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Icon name={result.icon} size={20} color={result.color} />
      <View style={styles.grow}>
        <AppText>{decision.title}</AppText>
        <AppText variant="footnote" tone="secondary">
          {meta}
        </AppText>
      </View>
      <AppText variant="subhead" tone="secondary">
        {result.label}
      </AppText>
    </Pressable>
  );
}

type EventTarget = { href: Href; name: string } | null;

// Where an event row leads: its decision when the read returned its title,
// otherwise its agent session when the session still exists, otherwise
// nowhere. The destination screen's query still checks the record.
function eventTarget(event: DigestEvent): EventTarget {
  if (event.decision_id !== null && event.decision_title !== null) {
    return {
      href: { pathname: "/decision/[id]", params: { id: event.decision_id } },
      name: event.decision_title,
    };
  }
  if (
    event.agent_session_id !== null &&
    event.agent_name !== null &&
    event.agent_name !== ENDED_AGENT
  ) {
    return {
      href: { pathname: "/agent/[id]", params: { id: event.agent_session_id } },
      name: event.agent_name,
    };
  }
  return null;
}

// What an event row says about a decision or agent it cannot open.
function unavailableLabels(event: DigestEvent): string[] {
  const labels: string[] = [];
  if (event.decision_id !== null && event.decision_title === null) {
    labels.push("Decision unavailable");
  }
  if (event.agent_session_id !== null && event.agent_name === ENDED_AGENT) {
    labels.push(ENDED_AGENT);
  }
  return labels;
}

// One event the digest holds: its kind, topic, time, and routed action, with
// the decision title or agent name the read supplied.
function DigestEventRow({ event }: { event: DigestEvent }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const kind = EVENT_LABELS[event.kind] ?? event.kind;
  const target = eventTarget(event);
  const details = (
    <View style={styles.grow}>
      <AppText weight="600">{kind}</AppText>
      {target === null ? null : <AppText variant="subhead">{target.name}</AppText>}
      {unavailableLabels(event).map((label) => (
        <AppText key={label} variant="footnote" tone="amber">
          {label}
        </AppText>
      ))}
      {event.topic === null ? null : (
        <AppText variant="footnote" tone="secondary">
          {event.topic}
        </AppText>
      )}
      <AppText variant="footnote" tone="secondary">
        {formatInstant(event.occurred_at)}
      </AppText>
      {event.action === null ? null : (
        <AppText variant="footnote" tone="secondary">
          {actionLabel(event.action)}
        </AppText>
      )}
    </View>
  );
  if (target === null) {
    return (
      <View accessibilityLabel={`Event: ${kind}`} style={styles.row}>
        {details}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Event: ${kind}, ${target.name}`}
      onPress={() => router.push(target.href)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {details}
      <Icon name="chevron-forward" size={17} color={theme.textTertiary} />
    </Pressable>
  );
}

function DigestDetail({ id }: { id: string }) {
  const styles = useStyles();
  const theme = useTheme();
  const { hidden } = useQuickAnswers();
  // Three tiles side by side leave too little width for large text, so they
  // stack (Apple HIG Typography: layouts adapt to Dynamic Type).
  const stacked = useWindowDimensions().fontScale > STACK_FONT_SCALE;
  const digest = useQuery(notifications.digests.get, { digestId: id });
  const pending = useQuery(decisions.app.listPending, {});
  const now = useScreenClock();
  if (digest === undefined) {
    return <Loading label="Loading digest" />;
  }
  const waiting = digest.pending_decisions.filter((decision) => decision.state === "pending");
  const settled = digest.pending_decisions.filter((decision) => decision.state !== "pending");
  const answered = settled.filter((decision) => decision.state === "answered").length;
  // A pending decision's full read, for its input type, options, and
  // recommendation.
  const full = new Map((pending ?? []).map((decision) => [decision.id, decision]));
  // A decision answered from its card leaves the list while Undo is offered.
  const cards = waiting.filter((decision) => !hidden.has(decision.id));

  return (
    <StackScreen>
      <Stack.Screen options={{ title: "Digest" }} />
      <View style={styles.heading}>
        <AppText variant="footnote" tone="secondary">
          {formatSentAt(digest.sent_at)}
        </AppText>
        <AppText accessibilityRole="header" variant="title2">
          While you were away
        </AppText>
      </View>
      <View style={[styles.stats, stacked && styles.stackedStats]}>
        <Stat
          count={waiting.length}
          label="Waiting on you"
          color={theme.accent}
          stacked={stacked}
        />
        <Stat count={answered} label="Answered" color={theme.green} stacked={stacked} />
        <Stat
          count={settled.length - answered}
          label="Closed"
          color={theme.textSecondary}
          stacked={stacked}
        />
      </View>
      <SectionHeader title="Waiting on you" />
      {waiting.length === 0 ? (
        <Note>
          {digest.pending_decisions.length === 0
            ? "No decisions were pending."
            : "Every decision in this digest has settled."}
        </Note>
      ) : (
        <View style={styles.cards}>
          {cards.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={full.get(decision.id) ?? decision}
              agentName={decision.agent_name}
              now={now}
              accessibilityLabel={`Decision: ${decision.title}, Pending`}
            />
          ))}
        </View>
      )}
      {settled.length === 0 ? null : (
        <>
          <SectionHeader title="Settled since" />
          <Group>
            {settled.map((decision) => (
              <SettledRow key={decision.id} decision={decision} />
            ))}
          </Group>
        </>
      )}
      <SectionHeader title="Events" />
      {digest.events.length === 0 ? (
        <Note>No events in this digest.</Note>
      ) : (
        <Group>
          {digest.events.map((event) => (
            <DigestEventRow key={event.id} event={event} />
          ))}
        </Group>
      )}
    </StackScreen>
  );
}

const LOAD_FAILURE = "Could not load this digest.";

// VoiceOver speaks the failure when it appears, since the screen it replaces
// was the focus.
function DigestFailure({ retry }: { retry: () => void }) {
  const styles = useStyles();
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(LOAD_FAILURE);
  }, []);
  return (
    <StackScreen>
      <Stack.Screen options={{ title: "Digest" }} />
      <View style={styles.failure}>
        <AppText tone="red">{LOAD_FAILURE}</AppText>
        <Button label="Try again" onPress={retry} />
      </View>
    </StackScreen>
  );
}

export default function DigestScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!isRecordId(id)) {
    return <NotFound />;
  }
  return (
    <QueryErrorBoundary
      key={id}
      fallback={(error, retry) =>
        isNotFound(error) ? <NotFound /> : <DigestFailure retry={retry} />
      }
    >
      <QuickAnswerScope>
        <DigestDetail id={id} />
      </QuickAnswerScope>
    </QueryErrorBoundary>
  );
}
