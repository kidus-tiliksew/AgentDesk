import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { type Href, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { DigestDecision, DigestEvent } from "../../../../../convex/notifications/digests";
import { notifications } from "../../../../../convex/notifications/refs";
import { Button } from "../../../src/button";
import { formatDeadline } from "../../../src/decision-row";
import { Loading } from "../../../src/loading";
import { isRecordId } from "../../../src/notification-route";
import { errorData, QueryErrorBoundary } from "../../../src/query-error-boundary";
import { actionLabel, ENDED_AGENT, EVENT_KINDS } from "../../../src/rules/format";
import { styles } from "../../../src/styles";

// component-mobile-app §Screens, digest: one digest a digest push opened
// (req-mobile-app REQ-4; req-notification-rules AC-6.3). The screen reads
// `notifications/digests:get` and lists the decisions that were pending when
// the digest was sent, in the backend's order and in their current state,
// before the digest's events. It binds no mutation.

const STATE_LABELS: Record<DigestDecision["state"], string> = {
  pending: "Pending",
  answered: "Answered",
  expired: "Expired",
  cancelled: "Cancelled",
};

const EVENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(EVENT_KINDS.map((choice) => [choice.value, choice.label])),
  "decision.answered": "Decision answered",
  "decision.cancelled": "Decision cancelled",
};

// An instant from the query, in the device's locale and time zone.
function formatInstant(at: string): string {
  return new Date(at).toLocaleString();
}

function NotFound() {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: "Digest" }} />
      <Text style={styles.title}>Digest not found</Text>
      <Text style={styles.body}>This digest does not exist or is not yours.</Text>
    </View>
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

// One decision that was pending when the digest was sent, with its current
// state. Pressing it opens the decision screen.
function DigestDecisionRow({ decision }: { decision: DigestDecision }) {
  const router = useRouter();
  const state =
    decision.state === "answered" && decision.applied_by_default
      ? "Answered by default"
      : STATE_LABELS[decision.state];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Decision: ${decision.title}, ${state}`}
      onPress={() => router.push({ pathname: "/decision/[id]", params: { id: decision.id } })}
      style={styles.row}
    >
      <Text style={styles.rowTitle}>{decision.title}</Text>
      <View style={styles.rowMeta}>
        <Text style={decision.state === "pending" ? styles.meta : styles.stale}>{state}</Text>
        <Text style={styles.meta}>{decision.topic}</Text>
        <Text style={decision.priority === "urgent" ? styles.urgent : styles.meta}>
          {decision.priority === "urgent" ? "Urgent" : "Normal"}
        </Text>
        {decision.state === "pending" ? (
          <Text style={styles.meta}>{formatDeadline(decision.deadline)}</Text>
        ) : null}
        <Text style={styles.meta}>{decision.agent_name}</Text>
      </View>
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
  const router = useRouter();
  const kind = EVENT_LABELS[event.kind] ?? event.kind;
  const target = eventTarget(event);
  const details = (
    <>
      <Text style={styles.rowTitle}>{kind}</Text>
      {target === null ? null : <Text style={styles.line}>{target.name}</Text>}
      {unavailableLabels(event).map((label) => (
        <Text key={label} style={styles.meta}>
          {label}
        </Text>
      ))}
      <View style={styles.rowMeta}>
        {event.topic === null ? null : <Text style={styles.meta}>{event.topic}</Text>}
        <Text style={styles.meta}>{formatInstant(event.occurred_at)}</Text>
        {event.action === null ? null : (
          <Text style={styles.meta}>{actionLabel(event.action)}</Text>
        )}
      </View>
    </>
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
      style={styles.row}
    >
      {details}
    </Pressable>
  );
}

function DigestDetail({ id }: { id: string }) {
  const digest = useQuery(notifications.digests.get, { digestId: id });
  if (digest === undefined) {
    return <Loading label="Loading digest" />;
  }
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Stack.Screen options={{ title: "Digest" }} />
      <Text style={styles.meta}>Sent {formatInstant(digest.sent_at)}</Text>
      <Text accessibilityRole="header" style={styles.heading}>
        Pending decisions
      </Text>
      {digest.pending_decisions.length === 0 ? (
        <Text style={styles.empty}>No decisions were pending.</Text>
      ) : (
        <View style={styles.list}>
          {digest.pending_decisions.map((decision) => (
            <DigestDecisionRow key={decision.id} decision={decision} />
          ))}
        </View>
      )}
      <Text accessibilityRole="header" style={styles.heading}>
        Events
      </Text>
      {digest.events.length === 0 ? (
        <Text style={styles.empty}>No events in this digest.</Text>
      ) : (
        <View style={styles.list}>
          {digest.events.map((event) => (
            <DigestEventRow key={event.id} event={event} />
          ))}
        </View>
      )}
    </ScrollView>
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
        isNotFound(error) ? (
          <NotFound />
        ) : (
          <View style={styles.centered}>
            <Stack.Screen options={{ title: "Digest" }} />
            <Text style={styles.error}>Could not load this digest.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )
      }
    >
      <DigestDetail id={id} />
    </QueryErrorBoundary>
  );
}
