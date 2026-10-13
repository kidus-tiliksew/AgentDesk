import { useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { agents } from "../../../../../../convex/agents/refs";
import { notifications } from "../../../../../../convex/notifications/refs";
import { Button } from "../../../../src/button";
import { Loading } from "../../../../src/loading";
import { QueryErrorBoundary } from "../../../../src/query-error-boundary";
import { DefaultsCard } from "../../../../src/rules/defaults-card";
import { agentChoices, PRECEDENCE_EXPLANATION, ruleSummary } from "../../../../src/rules/format";
import { HeaderButton } from "../../../../src/rules/header-button";
import { RuleRow } from "../../../../src/rules/rule-row";
import { EmptyState } from "../../../../src/ui/empty-state";
import { GroupedSection } from "../../../../src/ui/grouped";
import { StackScreen } from "../../../../src/ui/screen";

// component-mobile-app §Screens, rules: the person's notification rules in
// the order `notifications/rules:list` returns them, latest save first
// (req-mobile-app REQ-5; req-notification-rules REQ-3), then what happens
// without a rule (REQ-4). Each row reads "where → what happens" with its
// action's icon (prototype frame "Rules"). The query is reactive, so a rule
// saved or deleted on any client appears here without a refresh. The list
// binds no mutation; the editor owns save and remove.

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
    <StackScreen>
      {rules.length === 0 ? (
        <EmptyState
          icon="options"
          title="No rules yet"
          body="Every notification follows the defaults below. Tap + to add a rule."
        />
      ) : (
        <GroupedSection title="Your rules" footer={PRECEDENCE_EXPLANATION}>
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              agents={known}
              accessibilityLabel={`Rule: ${ruleSummary(rule, known)}`}
              onPress={() =>
                router.push({ pathname: "/settings/rule/[id]", params: { id: rule.id } })
              }
            />
          ))}
        </GroupedSection>
      )}
      <DefaultsCard />
    </StackScreen>
  );
}

export default function RulesScreen() {
  const router = useRouter();
  return (
    <>
      {/* The + sits in the header, outside the query boundary, so a person
          can add a rule while the list loads, is empty, or failed to load. */}
      <Stack.Screen
        options={{
          title: "Rules",
          headerRight: () => (
            <HeaderButton
              icon="add"
              label="New rule"
              onPress={() => router.push("/settings/rule/new")}
            />
          ),
        }}
      />
      <QueryErrorBoundary
        fallback={(_error, retry) => (
          <StackScreen>
            <EmptyState icon="cloud-offline" title="Could not load your rules.">
              <Button label="Try again" onPress={retry} />
            </EmptyState>
          </StackScreen>
        )}
      >
        <RuleList />
      </QueryErrorBoundary>
    </>
  );
}
