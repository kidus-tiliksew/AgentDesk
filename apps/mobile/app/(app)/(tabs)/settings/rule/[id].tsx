import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { agents } from "../../../../../../../convex/agents/refs";
import { notifications } from "../../../../../../../convex/notifications/refs";
import type { NotificationRule } from "../../../../../../../convex/notifications/rules";
import { Button } from "../../../../../src/button";
import { Loading } from "../../../../../src/loading";
import { QueryErrorBoundary } from "../../../../../src/query-error-boundary";
import { RuleEditor } from "../../../../../src/rules/editor";
import { agentChoices } from "../../../../../src/rules/format";
import { HeaderButton } from "../../../../../src/rules/header-button";
import { EmptyState } from "../../../../../src/ui/empty-state";
import { StackScreen } from "../../../../../src/ui/screen";

// component-mobile-app §Screens, rules: `settings/rule/new` creates a rule and
// `settings/rule/[id]` edits one. The literal `new` is checked before the id,
// so it never reaches a lookup. An existing rule comes from
// `notifications/rules:list`, which has every rule of the person; the backend
// has no single-rule read.

const NEW_RULE = "new";

// Convex document ids are short URL-safe strings.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function NotFound() {
  const router = useRouter();
  return (
    <StackScreen>
      <EmptyState
        icon="options"
        title="Rule not found"
        body="This rule does not exist or was deleted."
      >
        <Button
          label="Back to rules"
          variant="tinted"
          onPress={() => router.navigate("/settings/rules")}
        />
      </EmptyState>
    </StackScreen>
  );
}

// The editor for `id`, once the rule and the agent choices have loaded. The
// first rule the list returns for `id` stays the editor's rule, so a later
// save or deletion of it, here or on another client, never unmounts the
// editor or resets its draft while the person is on it.
function RuleLoader({ id }: { id: string }) {
  const isNew = id === NEW_RULE;
  const rules = useQuery(notifications.rules.list, isNew ? "skip" : {});
  const live = useQuery(agents.app.liveAgents, {});
  const recent = useQuery(agents.app.recentAgents, {});
  const [captured, setCaptured] = useState<NotificationRule | null>(null);

  const found = rules?.find((rule) => rule.id === id) ?? null;
  if (captured === null && found !== null) {
    setCaptured(found);
  }
  const rule = captured ?? found;

  if ((!isNew && rules === undefined) || live === undefined || recent === undefined) {
    return <Loading label="Loading rule" />;
  }
  if (!isNew && rule === null) {
    return <NotFound />;
  }
  return <RuleEditor rule={isNew ? null : rule} agents={agentChoices(live, recent)} />;
}

// The route is a sheet (settings/_layout.tsx). Cancel sits on its leading
// side in every state, loading and failed included, so the sheet always has
// a visible way out (Apple HIG Sheets). Leaving goes back to the rules list:
// a pop when the list is under the sheet, and a replace when the sheet was
// opened directly over the Settings list. The editor asks before an edit is
// discarded.
export default function RuleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const valid = id === NEW_RULE || ID_PATTERN.test(id);
  return (
    <>
      <Stack.Screen
        options={{
          title: id === NEW_RULE ? "New rule" : "Edit rule",
          headerLeft: () => (
            <HeaderButton label="Cancel" onPress={() => router.dismissTo("/settings/rules")} />
          ),
        }}
      />
      {valid ? (
        <QueryErrorBoundary
          key={id}
          fallback={(_error, retry) => (
            <StackScreen>
              <EmptyState icon="cloud-offline" title="Could not load the rule.">
                <Button label="Try again" onPress={retry} />
              </EmptyState>
            </StackScreen>
          )}
        >
          <RuleLoader id={id} />
        </QueryErrorBoundary>
      ) : (
        <NotFound />
      )}
    </>
  );
}
