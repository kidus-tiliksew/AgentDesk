import type { AgentSession } from "@agentdesk/contract";
import { errorCodeSchema } from "@agentdesk/contract";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { notifications } from "../../../../convex/notifications/refs";
import type { NotificationRule } from "../../../../convex/notifications/rules";
import { Button } from "../button";
import { INVALID_TOPIC } from "../history-filters";
import { errorData } from "../query-error-boundary";
import { styles } from "../styles";
import {
  ACTIONS,
  agentChoiceLabel,
  ENDED_AGENT,
  EVENT_KINDS,
  PRECEDENCE_EXPLANATION,
  PRIORITIES,
  type RuleAction,
  type RuleEventKind,
  type RulePriority,
} from "./format";

// component-mobile-app §Screens, rules: the editor for one notification rule
// (req-mobile-app REQ-5; req-notification-rules REQ-3). It owns the
// `notifications/rules:save` and `remove` hooks, so the list binds neither.
// The backend normalizes the topic and checks every field; the editor only
// keeps Save disabled while no match field is set (AC-3.3).

type Draft = {
  topic: string;
  agentSessionId: string | null;
  eventKind: RuleEventKind | null;
  priority: RulePriority | null;
  action: RuleAction;
};

type Field = "topic" | "agent" | "eventKind" | "priority" | "action";

type Failure = { field: Field | null; message: string };

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

function Choice({
  group,
  label,
  selected,
  disabled,
  onPress,
}: {
  group: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${group}: ${label}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function ChoiceGroup<T>({
  group,
  choices,
  value,
  disabled,
  error,
  onSelect,
}: {
  group: string;
  choices: { value: T; label: string }[];
  value: T;
  disabled: boolean;
  error: string | null;
  onSelect: (value: T) => void;
}) {
  return (
    <View style={styles.field} testID={`field-${group}`}>
      <Text style={styles.fieldLabel}>{group}</Text>
      <View style={styles.rowMeta}>
        {choices.map((choice) => (
          <Choice
            key={`${group}:${choice.label}:${String(choice.value)}`}
            group={group}
            label={choice.label}
            selected={choice.value === value}
            disabled={disabled}
            onPress={() => onSelect(choice.value)}
          />
        ))}
      </View>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </View>
  );
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
  const save = useMutation(notifications.rules.save);
  const remove = useMutation(notifications.rules.remove);
  const [draft, setDraft] = useState<Draft>(() => (rule === null ? NEW_DRAFT : draftOf(rule)));
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
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
  const disabled = pending !== null;
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

  const leave = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/settings/rules");
    }
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
        leave();
      }
    } catch (error) {
      if (mounted.current) {
        setFailure(saveFailure(error));
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(null);
      }
    }
  };

  const confirmDelete = async () => {
    if (busy.current || ruleId === null) {
      return;
    }
    busy.current = true;
    setPending("delete");
    setFailure(null);
    try {
      await remove({ ruleId });
      if (mounted.current) {
        leave();
      }
    } catch (error) {
      if (mounted.current) {
        // A rule deleted elsewhere is gone, which is what Delete asked for.
        if (errorData(error)?.code === errorCodeSchema.enum.not_found) {
          leave();
        } else {
          setFailure({ field: null, message: DELETE_FAILED });
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

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.line}>{PRECEDENCE_EXPLANATION}</Text>
      <View style={styles.field} testID="field-Topic">
        <Text style={styles.fieldLabel}>Topic</Text>
        <TextInput
          accessibilityLabel="Topic"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          onChangeText={(topic) => edit("topic", { topic })}
          placeholder="Any topic, or a topic such as acme/billing"
          style={styles.input}
          value={draft.topic}
        />
        <Text style={styles.meta}>A topic also matches its subtopics.</Text>
        {fieldError("topic") === null ? null : (
          <Text style={styles.error}>{fieldError("topic")}</Text>
        )}
      </View>
      <ChoiceGroup
        group="Agent"
        choices={agentOptions}
        value={draft.agentSessionId}
        disabled={disabled}
        error={fieldError("agent")}
        onSelect={(agentSessionId) => edit("agent", { agentSessionId })}
      />
      <ChoiceGroup
        group="Event"
        choices={[{ value: null, label: "Any event" }, ...EVENT_KINDS]}
        value={draft.eventKind}
        disabled={disabled}
        error={fieldError("eventKind")}
        onSelect={(eventKind) => edit("eventKind", { eventKind })}
      />
      <ChoiceGroup
        group="Priority"
        choices={[{ value: null, label: "Any priority" }, ...PRIORITIES]}
        value={draft.priority}
        disabled={disabled}
        error={fieldError("priority")}
        onSelect={(priority) => edit("priority", { priority })}
      />
      <Text style={styles.meta}>Only decision events carry a priority.</Text>
      <ChoiceGroup
        group="Action"
        choices={ACTIONS}
        value={draft.action}
        disabled={disabled}
        error={fieldError("action")}
        onSelect={(action) => edit("action", { action })}
      />
      {hasMatch(draft) ? null : (
        <Text style={styles.meta}>Set at least one of topic, agent, event, or priority.</Text>
      )}
      {formError === null ? null : <Text style={styles.error}>{formError}</Text>}
      <Button
        label={pending === "save" ? "Saving..." : "Save rule"}
        onPress={() => void submit()}
        disabled={disabled || !hasMatch(draft)}
      />
      {ruleId === null ? null : confirming ? (
        <View style={styles.outcome}>
          <Text style={styles.line}>
            Delete this rule? Events it matched follow your other rules or the defaults.
          </Text>
          <Button
            label={pending === "delete" ? "Deleting..." : "Delete rule"}
            onPress={() => void confirmDelete()}
            disabled={disabled}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => {
              if (busy.current) {
                return;
              }
              setFailure(null);
              setConfirming(false);
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => {
            if (busy.current) {
              return;
            }
            setFailure(null);
            setConfirming(true);
          }}
        >
          <Text style={styles.error}>Delete</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}
