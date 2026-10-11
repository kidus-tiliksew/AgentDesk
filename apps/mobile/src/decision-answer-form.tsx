import {
  type Answer,
  type AnswerSubmission,
  answerSubmissionSchema,
  type Decision,
  validateAnswer,
} from "@agentdesk/contract";
import { type ReactNode, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "./button";
import { styles } from "./styles";

// The contract's limits (packages/contract/src/answers.ts): an answer text of
// at most 4,000 characters and a note of at most 2,000
// (req-decision-requests AC-2.5).
export const TEXT_LIMIT = 4000;
export const NOTE_LIMIT = 2000;

type Choice = "approve" | "reject";

// The answer being composed. `mode` matters only for single_choice_or_text,
// where the user answers with one option or with text, never both
// (req-decision-requests AC-2.4).
type Draft = {
  choice: Choice | null;
  optionId: string | null;
  optionIds: string[];
  text: string;
  mode: "option" | "text";
  note: string;
};

// The first draft for a decision, from its recommendation: the recommended
// value is preselected, and the user may change it before submitting
// (req-mobile-app AC-3.3).
function initialDraft(recommendation: Answer | null): Draft {
  const draft: Draft = {
    choice: null,
    optionId: null,
    optionIds: [],
    text: "",
    mode: "option",
    note: "",
  };
  switch (recommendation?.kind) {
    case "approve":
    case "reject":
      return { ...draft, choice: recommendation.kind };
    case "option":
      return { ...draft, optionId: recommendation.option_id };
    case "options":
      return { ...draft, optionIds: [...recommendation.option_ids] };
    case "text":
      return { ...draft, text: recommendation.text, mode: "text" };
    default:
      return draft;
  }
}

// The answer the draft stands for, unvalidated. A missing selection is null,
// which the contract's validateAnswer refuses.
function candidate(decision: Decision, draft: Draft): unknown {
  switch (decision.input_type) {
    case "approve_reject":
      return draft.choice === null ? null : { kind: draft.choice };
    case "single_choice":
      return draft.optionId === null ? null : { kind: "option", option_id: draft.optionId };
    case "multiple_choice":
      // In the decision's option order, whatever order they were picked in.
      return {
        kind: "options",
        option_ids: (decision.options ?? [])
          .map((option) => option.id)
          .filter((id) => draft.optionIds.includes(id)),
      };
    case "free_text":
      return { kind: "text", text: draft.text };
    case "single_choice_or_text":
      if (draft.mode === "text") {
        return { kind: "text", text: draft.text };
      }
      return draft.optionId === null ? null : { kind: "option", option_id: draft.optionId };
  }
}

const FIELD_LABELS: Record<string, string> = {
  option_id: "Option",
  option_ids: "Options",
  text: "Text",
  note: "Note",
};

function issueMessage(issue: { path: PropertyKey[]; message: string }, fallback: string) {
  const field = issue.path.find((part) => typeof part === "string" && part in FIELD_LABELS);
  const label = typeof field === "string" ? FIELD_LABELS[field] : fallback;
  return `${label}: ${issue.message}`;
}

// Validates the draft with the contract before anything is sent: the answer
// against the decision's input type and options with validateAnswer, and the
// note with answerSubmissionSchema. On failure it returns the contract's
// messages and no submission.
function validate(
  decision: Decision,
  draft: Draft,
): { submission: AnswerSubmission } | { errors: string[] } {
  const answer = validateAnswer(
    decision.input_type,
    decision.options ?? undefined,
    candidate(decision, draft),
  );
  const errors = answer.success
    ? []
    : answer.error.issues.map((issue) => issueMessage(issue, "Answer"));
  const submission = answerSubmissionSchema.safeParse({
    answer: answer.success ? answer.data : { kind: "approve" },
    note: draft.note === "" ? undefined : draft.note,
  });
  if (!submission.success) {
    errors.push(
      ...submission.error.issues
        .filter((issue) => issue.path[0] === "note")
        .map((issue) => issueMessage(issue, "Note")),
    );
  }
  if (errors.length > 0 || !submission.success) {
    return { errors };
  }
  return { submission: submission.data };
}

// One selectable answer. Selection is the accessibility `checked` state and
// the filled style; the recommendation is a separate "Recommended" label and
// hint, so changing the selection never hides it.
function ChoiceControl({
  role,
  label,
  selected,
  recommended,
  disabled,
  onPress,
}: {
  role: "radio" | "checkbox";
  label: string;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={recommended ? "Recommended by the agent" : undefined}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <Text style={selected ? styles.choiceTextSelected : styles.choiceText}>{label}</Text>
      {recommended ? <Text style={styles.recommended}>Recommended</Text> : null}
    </Pressable>
  );
}

function LimitedInput({
  label,
  placeholder,
  value,
  limit,
  editable,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  limit: number;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <TextInput
        accessibilityLabel={label}
        editable={editable}
        maxLength={limit}
        multiline
        onChangeText={onChange}
        placeholder={placeholder}
        style={[styles.input, styles.textArea]}
        value={value}
      />
      <Text style={value.length > limit ? styles.error : styles.counter}>
        {`${value.length}/${limit}`}
      </Text>
    </View>
  );
}

// The answer controls for a pending decision: one control per input type,
// an optional note, and one Submit action (req-mobile-app REQ-3). The parent
// mounts it once per decision id, so the draft survives reactive updates to
// the same decision and never carries over to another one. While
// `submitting` is set every control is disabled.
export function AnswerForm({
  decision,
  submitting,
  failure,
  onSubmit,
}: {
  decision: Decision;
  submitting: boolean;
  failure: string | null;
  onSubmit: (submission: AnswerSubmission) => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(decision.recommendation));
  const [errors, setErrors] = useState<string[]>([]);
  const { recommendation } = decision;
  const options = decision.options ?? [];

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
  };
  const isRecommendedOption = (id: string) =>
    (recommendation?.kind === "option" && recommendation.option_id === id) ||
    (recommendation?.kind === "options" && recommendation.option_ids.includes(id));

  const submit = () => {
    if (submitting) {
      return;
    }
    const result = validate(decision, draft);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    onSubmit(result.submission);
  };

  const textInput = (
    <LimitedInput
      label="Answer text"
      placeholder="Your answer"
      value={draft.text}
      limit={TEXT_LIMIT}
      editable={!submitting}
      onChange={(text) => edit({ text })}
    />
  );

  let controls: ReactNode;
  switch (decision.input_type) {
    case "approve_reject":
      controls = (["approve", "reject"] as const).map((choice) => (
        <ChoiceControl
          key={choice}
          role="radio"
          label={choice === "approve" ? "Approve" : "Reject"}
          selected={draft.choice === choice}
          recommended={recommendation?.kind === choice}
          disabled={submitting}
          onPress={() => edit({ choice })}
        />
      ));
      break;
    case "single_choice":
      controls = options.map((option) => (
        <ChoiceControl
          key={option.id}
          role="radio"
          label={option.label}
          selected={draft.optionId === option.id}
          recommended={isRecommendedOption(option.id)}
          disabled={submitting}
          onPress={() => edit({ optionId: option.id })}
        />
      ));
      break;
    case "multiple_choice":
      controls = options.map((option) => (
        <ChoiceControl
          key={option.id}
          role="checkbox"
          label={option.label}
          selected={draft.optionIds.includes(option.id)}
          recommended={isRecommendedOption(option.id)}
          disabled={submitting}
          onPress={() =>
            edit({
              optionIds: draft.optionIds.includes(option.id)
                ? draft.optionIds.filter((id) => id !== option.id)
                : [...draft.optionIds, option.id],
            })
          }
        />
      ));
      break;
    case "free_text":
      controls = (
        <>
          {recommendation?.kind === "text" ? (
            <Text style={styles.recommended}>Recommended answer prefilled</Text>
          ) : null}
          {textInput}
        </>
      );
      break;
    case "single_choice_or_text":
      // Picking an option clears the text and choosing Other answer clears
      // the option, so a submission never carries both.
      controls = (
        <>
          {options.map((option) => (
            <ChoiceControl
              key={option.id}
              role="radio"
              label={option.label}
              selected={draft.mode === "option" && draft.optionId === option.id}
              recommended={isRecommendedOption(option.id)}
              disabled={submitting}
              onPress={() => edit({ mode: "option", optionId: option.id, text: "" })}
            />
          ))}
          <ChoiceControl
            role="radio"
            label="Other answer"
            selected={draft.mode === "text"}
            recommended={recommendation?.kind === "text"}
            disabled={submitting}
            onPress={() => edit({ mode: "text", optionId: null })}
          />
          {draft.mode === "text" ? textInput : null}
        </>
      );
      break;
  }

  return (
    <View style={styles.list}>
      <Text accessibilityRole="header" style={styles.heading}>
        Your answer
      </Text>
      {controls}
      <LimitedInput
        label="Note"
        placeholder="Optional note"
        value={draft.note}
        limit={NOTE_LIMIT}
        editable={!submitting}
        onChange={(note) => edit({ note })}
      />
      {errors.map((message) => (
        <Text key={message} style={styles.error}>
          {message}
        </Text>
      ))}
      {failure === null ? null : <Text style={styles.error}>{failure}</Text>}
      <Button
        label={submitting ? "Submitting" : "Submit answer"}
        disabled={submitting}
        onPress={submit}
      />
    </View>
  );
}
