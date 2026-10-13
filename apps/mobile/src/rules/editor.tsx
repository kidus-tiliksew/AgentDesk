import type { AgentSession } from "@agentdesk/contract";
import { errorCodeSchema } from "@agentdesk/contract";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { Stack, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, TextInput, useWindowDimensions, View } from "react-native";
import { notifications } from "../../../../convex/notifications/refs";
import type { NotificationRule } from "../../../../convex/notifications/rules";
import { confirmDestructive, confirmDiscard } from "../confirm";
import { haptic } from "../haptics";
import { INVALID_TOPIC } from "../history-filters";
import { errorData } from "../query-error-boundary";
import { makeStyles, useTheme } from "../theme";
import { Card } from "../ui/card";
import { GroupedRow, GroupedSection } from "../ui/grouped";
import { Icon } from "../ui/icon";
import { StackScreen } from "../ui/screen";
import { AppText } from "../ui/text";
import { ActionButton, OptionRow, SentenceToken, SentenceWord } from "./editor-parts";
import {
  ACTION_LOOK,
  ACTIONS,
  agentChoiceLabel,
  ENDED_AGENT,
  EVENT_KINDS,
  NO_MATCH,
  PRIORITIES,
  PRIORITY_HINT,
  type RuleAction,
  type RuleEventKind,
  type RulePriority,
  SUBTOPIC_HINT,
} from "./format";
import { HeaderButton } from "./header-button";
import { eventPhrase, priorityPhrase, rulePreview, topicPhrase } from "./sentence";

// component-mobile-app §Screens, rules: the editor for one notification rule
// (req-mobile-app REQ-5; req-notification-rules REQ-3). It owns the
// `notifications/rules:save` and `remove` hooks, so the list binds neither.
// The backend normalizes the topic and checks every field; the editor only
// keeps Save disabled while no match field is set (AC-3.3).
//
// The rule reads as a sentence, "When [event] by [agent] in [topic] with
// [priority] priority,", where each bracket opens that field's choices below
// the sentence; then three action buttons and a plain-words preview
// (prototype frame "Rule editor"). The editor is a sheet (Apple HIG
// Sheets): the route puts Cancel on the left of its navigation bar and the
// editor puts Save on the right. Leaving with unsaved edits, by Cancel or a
// swipe, asks to discard them first.

type Draft = {
  topic: string;
  agentSessionId: string | null;
  eventKind: RuleEventKind | null;
  priority: RulePriority | null;
  action: RuleAction;
};

type Field = "topic" | "agent" | "eventKind" | "priority" | "action";

type Failure = { field: Field | null; message: string };

// The match fields the sentence's tokens open, in sentence order.
type MatchField = Exclude<Field, "action">;

// Each match field's name, as its choices and its error are labelled.
const GROUPS: Record<Field, string> = {
  eventKind: "Event",
  agent: "Agent",
  topic: "Topic",
  priority: "Priority",
  action: "Action",
};

const SENTENCE_HINT = "Tap a highlighted part of the sentence to change it.";
const DELETE_TITLE = "Delete this rule?";
const DELETE_MESSAGE = "Events it matched follow your other rules or the defaults.";

const useStyles = makeStyles((theme) => ({
  sentence: {
    alignItems: "center",
    columnGap: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    paddingTop: 12,
    rowGap: 4,
  },
  errors: { gap: 4, paddingHorizontal: 20, paddingTop: 8 },
  topicInput: {
    color: theme.text,
    fontSize: 17,
    minHeight: 46,
    paddingHorizontal: 16,
  },
  label: { paddingBottom: 7, paddingHorizontal: 32, paddingTop: 22 },
  actions: { flexDirection: "row", gap: 8, paddingHorizontal: 16 },
  actionsStacked: { flexDirection: "column" },
  preview: { flexDirection: "row", gap: 10, marginTop: 16 },
  previewText: { flex: 1, gap: 2 },
  footer: { paddingHorizontal: 32, paddingTop: 8 },
  formError: { paddingHorizontal: 20, paddingTop: 12 },
}));

const RULE_NOT_FOUND = "Notification rule not found";
const SESSION_NOT_FOUND = "Agent session not found";

const SAVE_FAILED = "Could not save the rule. Try again.";
const DELETE_FAILED = "Could not delete the rule. Try again.";

// A new rule pushes until the person picks another action.
const NEW_DRAFT: Draft = {
  topic: "",
  agentSessionId: null,
  eventKind: null,
  priority: null,
  action: "push",
};

function draftOf(rule: NotificationRule): Draft {
  return {
    topic: rule.topic ?? "",
    agentSessionId: rule.agent_session_id,
    eventKind: rule.event_kind,
    priority: rule.priority,
    action: rule.action,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.topic.trim() === b.topic.trim() &&
    a.agentSessionId === b.agentSessionId &&
    a.eventKind === b.eventKind &&
    a.priority === b.priority &&
    a.action === b.action
  );
}

function hasMatch(draft: Draft): boolean {
  return (
    draft.topic.trim() !== "" ||
    draft.agentSessionId !== null ||
    draft.eventKind !== null ||
    draft.priority !== null
  );
}

// The `save` arguments for a draft. An unset match field is omitted, which
// clears it on an existing rule (component-notifications §Rules).
function saveArgs(ruleId: string | null, draft: Draft) {
  const topic = draft.topic.trim();
  return {
    ...(ruleId === null ? {} : { ruleId }),
    ...(topic === "" ? {} : { topic }),
    ...(draft.agentSessionId === null ? {} : { agentSessionId: draft.agentSessionId }),
    ...(draft.eventKind === null ? {} : { eventKind: draft.eventKind }),
    ...(draft.priority === null ? {} : { priority: draft.priority }),
    action: draft.action,
  };
}

function errorMessage(error: unknown): string | null {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    typeof error.data.message === "string"
  ) {
    return error.data.message;
  }
  return null;
}

// A refused save on the field it names, or on the form.
function saveFailure(error: unknown): Failure {
  const data = errorData(error);
  if (data?.code === errorCodeSchema.enum.invalid) {
    switch (data.field) {
      case "topic":
        return { field: "topic", message: INVALID_TOPIC };
      case "agentSessionId":
        return { field: "agent", message: "Choose another agent." };
      case "eventKind":
        return { field: "eventKind", message: "Choose another event kind." };
      case "priority":
        return { field: "priority", message: "Choose another priority." };
      case "action":
        return { field: "action", message: "Choose another action." };
      case undefined:
        return { field: null, message: "Set at least one match field." };
      default:
        return { field: null, message: "The rule was refused. Check the fields and try again." };
    }
  }
  if (data?.code === errorCodeSchema.enum.not_found) {
    if (errorMessage(error) === SESSION_NOT_FOUND) {
      return { field: "agent", message: "This agent no longer exists. Choose another agent." };
    }
    if (errorMessage(error) === RULE_NOT_FOUND) {
      return { field: null, message: "This rule was deleted elsewhere." };
    }
  }
  return { field: null, message: SAVE_FAILED };
}

// `rule` is null for a new rule. `agents` are the person's live and recent
// agents. The draft is set once from `rule` when the editor mounts, so a
// reactive change to the rule or the agents never overwrites an edit; the
// route gives each rule its own editor instance.
export function RuleEditor({
  rule,
  agents,
}: {
  rule: NotificationRule | null;
  agents: AgentSession[];
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const save = useMutation(notifications.rules.save);
  const remove = useMutation(notifications.rules.remove);
  const [initial] = useState<Draft>(() => (rule === null ? NEW_DRAFT : draftOf(rule)));
  const [draft, setDraft] = useState<Draft>(initial);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Set when a save or a deletion succeeds; the editor then closes.
  const [finished, setFinished] = useState(false);
  // The match field whose choices show under the sentence, one at a time.
  const [open, setOpen] = useState<MatchField | null>(null);
  const styles = useStyles();
  const theme = useTheme();
  // Apple HIG Typography: at the largest text sizes the three action
  // buttons stack, so each label keeps its full width.
  const stacked = useWindowDimensions().fontScale > 1.35;
  // Set synchronously, so a second press of Save or Delete before the
  // re-render sends nothing.
  const busy = useRef(false);
  // A call that settles after the editor unmounts changes nothing.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ruleId = rule === null ? null : rule.id;
  const disabled = pending !== null || finished;
  const fieldError = (field: Field) => (failure?.field === field ? failure.message : null);
  const formError = failure !== null && failure.field === null ? failure.message : null;

  // An edited field drops its own error and any form error.
  const edit = (field: Field, patch: Partial<Draft>) => {
    if (busy.current) {
      return;
    }
    setDraft((current) => ({ ...current, ...patch }));
    setFailure((current) => (current === null || current.field === field ? null : current));
  };

  // Apple HIG Modality: Cancel, the back gesture, and a swipe down on the
  // sheet ask before throwing away an edit. An unchanged draft leaves without
  // asking, and so does a running or finished save or deletion.
  usePreventRemove(pending === null && !finished && !sameDraft(draft, initial), ({ data }) =>
    confirmDiscard(() => navigation.dispatch(data.action)),
  );

  // Back to the rules list once a save or a deletion succeeds, after the
  // render that stops holding the editor: a pop when the list is under the
  // editor, and a replace when the editor was opened directly over the
  // Settings list.
  useEffect(() => {
    if (finished) {
      router.dismissTo("/settings/rules");
    }
  }, [finished, router]);

  // A failure shows on screen and VoiceOver reads it out, since it appears
  // away from the focused Save or Delete (Apple HIG Accessibility).
  const fail = (next: Failure) => {
    setFailure(next);
    haptic.error();
    AccessibilityInfo.announceForAccessibility(next.message);
  };

  const finish = () => {
    haptic.success();
    setFinished(true);
  };

  const submit = async () => {
    if (busy.current || !hasMatch(draft)) {
      return;
    }
    busy.current = true;
    setPending("save");
    setFailure(null);
    try {
      await save(saveArgs(ruleId, draft));
      if (mounted.current) {
        finish();
      }
    } catch (error) {
      if (mounted.current) {
        fail(saveFailure(error));
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(null);
      }
    }
  };

  const deleteRule = async () => {
    if (busy.current || ruleId === null) {
      return;
    }
    busy.current = true;
    setPending("delete");
    setFailure(null);
    try {
      await remove({ ruleId });
      if (mounted.current) {
        finish();
      }
    } catch (error) {
      if (mounted.current) {
        // A rule deleted elsewhere is gone, which is what Delete asked for.
        if (errorData(error)?.code === errorCodeSchema.enum.not_found) {
          finish();
        } else {
          fail({ field: null, message: DELETE_FAILED });
        }
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(null);
      }
    }
  };

  // Any agent, the live and recent agents, and the rule's own agent when
  // neither list has it any more, so an edit keeps that match.
  const agentOptions: { value: string | null; label: string }[] = [
    { value: null, label: "Any agent" },
    ...agents.map((agent) => ({ value: agent.id, label: agentChoiceLabel(agent) })),
  ];
  const ruleAgent = rule?.agent_session_id ?? null;
  if (ruleAgent !== null && !agents.some((agent) => agent.id === ruleAgent)) {
    agentOptions.push({ value: ruleAgent, label: ENDED_AGENT });
  }
  const agentName =
    draft.agentSessionId === null
      ? null
      : (agentOptions.find((option) => option.value === draft.agentSessionId)?.label ??
        ENDED_AGENT);

  const toggle = (field: MatchField) => setOpen((current) => (current === field ? null : field));

  // A choice sets its field and closes the list, as an action sheet would.
  function choices<T>(
    field: MatchField,
    options: { value: T; label: string }[],
    value: T,
    patch: (value: T) => Partial<Draft>,
  ) {
    return options.map((option) => (
      <OptionRow
        key={`${field}:${option.label}:${String(option.value)}`}
        group={GROUPS[field]}
        label={option.label}
        selected={option.value === value}
        disabled={disabled}
        onPress={() => {
          edit(field, patch(option.value));
          setOpen(null);
        }}
      />
    ));
  }

  const token = (field: MatchField, phrase: string) => (
    <SentenceToken
      field={GROUPS[field]}
      phrase={phrase}
      open={open === field}
      invalid={fieldError(field) !== null}
      disabled={disabled}
      onPress={() => toggle(field)}
    />
  );

  // Each field's error sits under the sentence, so it shows whichever list
  // is open.
  const errorLine = (field: Field) => {
    const message = fieldError(field);
    return message === null ? null : (
      <View key={field} testID={`field-${GROUPS[field]}`}>
        <AppText variant="footnote" tone="red">
          {message}
        </AppText>
      </View>
    );
  };

  const preview = rulePreview({
    topic: draft.topic,
    agent: agentName,
    eventKind: draft.eventKind,
    priority: draft.priority,
    action: draft.action,
  });

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              label={pending === "save" ? "Saving..." : "Save"}
              emphasis
              disabled={disabled || !hasMatch(draft)}
              onPress={() => void submit()}
            />
          ),
        }}
      />
      <StackScreen>
        <View style={styles.sentence}>
          <SentenceWord>When</SentenceWord>
          {token("eventKind", eventPhrase(draft.eventKind))}
          <SentenceWord>by</SentenceWord>
          {token("agent", agentName ?? "any agent")}
          <SentenceWord>in</SentenceWord>
          {token("topic", topicPhrase(draft.topic))}
          <SentenceWord>with</SentenceWord>
          {token("priority", priorityPhrase(draft.priority))}
          <SentenceWord>priority,</SentenceWord>
        </View>
        <View style={styles.errors}>
          {(["eventKind", "agent", "topic", "priority"] as const).map(errorLine)}
        </View>

        {open === "eventKind" ? (
          <GroupedSection title="Event">
            {choices(
              "eventKind",
              [{ value: null, label: "Any event" }, ...EVENT_KINDS],
              draft.eventKind,
              (eventKind) => ({ eventKind }),
            )}
          </GroupedSection>
        ) : null}
        {open === "agent" ? (
          <GroupedSection title="Agent">
            {choices("agent", agentOptions, draft.agentSessionId, (agentSessionId) => ({
              agentSessionId,
            }))}
          </GroupedSection>
        ) : null}
        {open === "topic" ? (
          <GroupedSection title="Topic" footer={SUBTOPIC_HINT}>
            <TextInput
              accessibilityLabel="Topic"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!disabled}
              onChangeText={(topic) => edit("topic", { topic })}
              onSubmitEditing={() => setOpen(null)}
              placeholder="Any topic, or a topic such as acme/billing"
              placeholderTextColor={theme.textSecondary}
              returnKeyType="done"
              style={styles.topicInput}
              value={draft.topic}
            />
          </GroupedSection>
        ) : null}
        {open === "priority" ? (
          <GroupedSection title="Priority" footer={PRIORITY_HINT}>
            {choices(
              "priority",
              [{ value: null, label: "Any priority" }, ...PRIORITIES],
              draft.priority,
              (priority) => ({ priority }),
            )}
          </GroupedSection>
        ) : null}

        <AppText
          accessibilityRole="header"
          variant="footnote"
          tone="secondary"
          style={[styles.label, { textTransform: "uppercase" }]}
        >
          Then
        </AppText>
        <View style={[styles.actions, stacked && styles.actionsStacked]}>
          {ACTIONS.map((choice) => (
            <ActionButton
              key={choice.value}
              label={choice.label}
              icon={ACTION_LOOK[choice.value].icon}
              selected={draft.action === choice.value}
              disabled={disabled}
              stacked={stacked}
              onPress={() => edit("action", { action: choice.value })}
            />
          ))}
        </View>
        <View style={styles.errors}>{errorLine("action")}</View>

        <Card style={styles.preview}>
          <Icon name="sparkles" size={22} color={theme.accent} />
          <View style={styles.previewText}>
            <AppText weight="600">Preview</AppText>
            <AppText variant="subhead" tone={preview === null ? "amber" : "secondary"}>
              {preview ?? NO_MATCH}
            </AppText>
          </View>
        </Card>
        {formError === null ? null : (
          <AppText tone="red" style={styles.formError}>
            {formError}
          </AppText>
        )}
        <AppText variant="footnote" tone="secondary" style={styles.footer}>
          {`${SENTENCE_HINT} ${SUBTOPIC_HINT}`}
        </AppText>

        {/* Apple HIG Action sheets: Delete asks with the system sheet, whose
            red "Delete Rule" and separate Cancel keep a stray tap from
            deleting. A failed deletion shows its error; the row asks again. */}
        {ruleId === null ? null : (
          <GroupedSection>
            <GroupedRow
              title={pending === "delete" ? "Deleting..." : "Delete rule"}
              tone="destructive"
              disabled={disabled}
              onPress={() => {
                if (busy.current) {
                  return;
                }
                confirmDestructive({
                  title: DELETE_TITLE,
                  message: DELETE_MESSAGE,
                  action: "Delete Rule",
                  onConfirm: () => void deleteRule(),
                });
              }}
            />
          </GroupedSection>
        )}
      </StackScreen>
    </>
  );
}
