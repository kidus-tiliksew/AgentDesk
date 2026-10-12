import { useQuery } from "convex/react";
import { Link, Stack, useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { agents } from "../../../../../convex/agents/refs";
import { notifications } from "../../../../../convex/notifications/refs";
import { Button } from "../../../src/button";
import { Loading } from "../../../src/loading";
import { QueryErrorBoundary } from "../../../src/query-error-boundary";
import {
  ANY,
  actionLabel,
  agentChoices,
  agentLabel,
  DEFAULTS_EXPLANATION,
  eventKindLabel,
  priorityLabel,
  ruleSummary,
} from "../../../src/rules/format";
import { styles } from "../../../src/styles";

// component-mobile-app §Screens, rules: the person's notification rules in
// the order `notifications/rules:list` returns them, latest save first
// (req-mobile-app REQ-5; req-notification-rules REQ-3). The query is
// reactive, so a rule saved or deleted on any client appears here without a
// refresh. The list binds no mutation; the editor owns save and remove.

function RuleList() {
  const router = useRouter();
  const rules = useQuery(notifications.rules.list, {});
  const live = useQuery(agents.app.liveAgents, {});
  const recent = useQuery(agents.app.recentAgents, {});

  if (rules === undefined || live === undefined || recent === undefined) {
    return <Loading label="Loading rules" />;
  }
  const known = agentChoices(live, recent);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {rules.length === 0 ? (
        <>
          <Text style={styles.empty}>No rules yet.</Text>
          <Text style={styles.line}>{DEFAULTS_EXPLANATION}</Text>
        </>
      ) : (
        <View style={styles.list}>
          {rules.map((rule) => (
            <Pressable
              key={rule.id}
              accessibilityRole="button"
              accessibilityLabel={`Rule: ${ruleSummary(rule, known)}`}
              onPress={() =>
                router.push({ pathname: "/settings/rule/[id]", params: { id: rule.id } })
              }
              style={styles.row}
            >
              <Text style={styles.rowTitle}>{actionLabel(rule.action)}</Text>
              <Text style={styles.meta}>Topic: {rule.topic ?? ANY}</Text>
              <Text style={styles.meta}>Agent: {agentLabel(rule.agent_session_id, known)}</Text>
              <Text style={styles.meta}>Event: {eventKindLabel(rule.event_kind)}</Text>
              <Text style={styles.meta}>Priority: {priorityLabel(rule.priority)}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

export default function RulesScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Rules" }} />
      {/* Outside the query boundary, so a person can add a rule while the
          list loads, is empty, or failed to load. */}
      <Link href="/settings/rule/new" style={styles.link}>
        New rule
      </Link>
      <QueryErrorBoundary
        fallback={(_error, retry) => (
          <View style={styles.centered}>
            <Text style={styles.error}>Could not load your rules.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )}
      >
        <RuleList />
      </QueryErrorBoundary>
    </>
  );
}
