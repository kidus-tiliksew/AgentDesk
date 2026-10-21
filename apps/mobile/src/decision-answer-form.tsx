import {
  type Answer,
  type AnswerSubmission,
  type Decision,
  validateAnswer,
  validateAnswerSubmission,
} from "@agentdesk/contract";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Button } from "./button";
import { formatAnswer } from "./decision-outcome";
import { linkHitSlop, makeStyles, placeholderOnFill, radius, spacing, useTheme } from "./theme";
import { Dock } from "./ui/dock";
import { Icon } from "./ui/icon";
import { Pill } from "./ui/pill";
import { AppText } from "./ui/text";

// The contract's limits (packages/contract/src/answers.ts): an answer text of
// at most 4,000 characters and a note of at most 2,000
// (req-decision-requests AC-2.5).
export const TEXT_LIMIT = 4000;
export const NOTE_LIMIT = 2000;

type Choice = "approve" | "reject";

// The answer being composed. Approve or reject is not part of it: each is
// its own button that sends at once. `mode` matters only for
// single_choice_or_text, where the user answers with one option or with
// text, never both (req-decision-requests AC-2.4).
type Draft = {
  optionId: string | null;
  optionIds: string[];
  text: string;
  mode: "option" | "text";
  note: string;
};

// The first draft for a decision, from its recommendation: the recommended
// value is preselected, and the user may change it before submitting
// (req-mobile-app AC-3.3). An approve or reject recommendation is the
// highlighted button instead.
function initialDraft(recommendation: Answer | null): Draft {
  const draft: Draft = { optionId: null, optionIds: [], text: "", mode: "option", note: "" };
  switch (recommendation?.kind) {
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
function candidate(decision: Decision, draft: Draft, choice: Choice | null): unknown {
  switch (decision.input_type) {
    case "approve_reject":
      return choice === null ? null : { kind: choice };
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

// What the person still has to do before "Send answer" can send, or null
// once the draft forms an answer. Only the active mode of
// single_choice_or_text counts. Text that is only whitespace is an answer,
// because the contract accepts it. Approve and Reject always form an answer.
function missingAnswer(decision: Decision, draft: Draft): string | null {
  switch (decision.input_type) {
    case "approve_reject":
      return null;
    case "single_choice":
      return draft.optionId === null ? "Choose an option." : null;
    case "multiple_choice":
      return (decision.options ?? []).some((option) => draft.optionIds.includes(option.id))
        ? null
        : "Choose at least one option.";
    case "free_text":
      return draft.text === "" ? "Enter an answer." : null;
    case "single_choice_or_text":
      if (draft.mode === "text") {
        return draft.text === "" ? "Enter an answer." : null;
      }
      return draft.optionId === null ? "Choose an option." : null;
  }
}

// Validates the draft with the contract before anything is sent: the answer
// against the decision's input type and options with validateAnswer, and the
// note with validateAnswerSubmission. On failure it returns the contract's
// messages, each naming its own subject, and no submission.
function validate(
  decision: Decision,
  draft: Draft,
  choice: Choice | null,
): { submission: AnswerSubmission } | { errors: string[] } {
  const answer = validateAnswer(
    decision.input_type,
    decision.options ?? undefined,
    candidate(decision, draft, choice),
  );
  const errors = answer.success ? [] : answer.error.issues.map((issue) => issue.message);
  const submission = validateAnswerSubmission({
    answer: answer.success ? answer.data : { kind: "approve" },
    note: draft.note === "" ? undefined : draft.note,
  });
  if (!submission.success) {
    errors.push(
      ...submission.error.issues
        .filter((issue) => issue.path[0] === "note")
        .map((issue) => issue.message),
    );
  }
  if (errors.length > 0 || !submission.success) {
    // Two issues can share a message, such as two unknown options.
    return { errors: [...new Set(errors)] };
  }
  return { submission: submission.data };
}

// Apple HIG Typography: past this text size the two answer buttons and the
// dock's recommendation line stack vertically instead of truncating.
const STACK_FONT_SCALE = 1.35;

const useStyles = makeStyles((theme) => ({
  flex: { flex: 1 },
  body: { backgroundColor: theme.background, flex: 1 },
  bodyContent: { paddingBottom: 24, paddingTop: 4 },
  controls: { gap: 8, paddingTop: 6 },
  option: {
    alignItems: "center",
    backgroundColor: theme.card,
    borderColor: "transparent",
    borderRadius: radius.card - 2,
    borderWidth: 2,
    flexDirection: "row",
    gap: 12,
    marginHorizontal: spacing.screen,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  optionSelected: { borderColor: theme.accent },
  optionText: { flex: 1, gap: 6 },
  radio: {
    alignItems: "center",
    borderColor: theme.textSecondary,
    borderRadius: 11,
    borderWidth: 2,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  checkbox: { borderRadius: 6 },
  indicatorOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  radioDot: { backgroundColor: theme.onAccent, borderRadius: 4, height: 8, width: 8 },
  inputWrap: { gap: 4, marginHorizontal: spacing.screen },
  inputWrapDocked: { marginHorizontal: 0 },
  input: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    color: theme.text,
    fontSize: 17,
    minHeight: 110,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
  noteInput: { backgroundColor: theme.fill, minHeight: 72 },
  counter: { alignSelf: "flex-end" },
  prefilled: { marginHorizontal: spacing.screen },
  dockLine: { alignItems: "center", flexDirection: "row", gap: 12 },
  dockLineStacked: { alignItems: "stretch", flexDirection: "column", gap: 4 },
  recommendation: {
    alignItems: "center",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
    gap: 5,
  },
  addNote: { alignSelf: "flex-start" },
  buttons: { flexDirection: "row", gap: 8 },
  buttonsStacked: { flexDirection: "column" },
  pressed: { opacity: 0.7 },
}));

// One selectable answer as a large row. Selection is the accessibility
// `checked` state, the filled indicator, and the accent border; the
// recommendation is a separate "Recommended" pill, so changing the selection
// never hides it (req-mobile-app AC-3.3). Apple HIG VoiceOver: the row is one
// element whose value carries "Recommended" after its checked state, so the
// marker is read whether or not hints are on.
function OptionRow({
  role,
  label,
  selected,
  recommended,
  disabled,
  muted = false,
  onPress,
}: {
  role: "radio" | "checkbox";
  label: string;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityValue={recommended ? { text: "Recommended" } : undefined}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        pressed && styles.pressed,
      ]}
    >
      <View
        style={[
          styles.radio,
          role === "checkbox" && styles.checkbox,
          selected && styles.indicatorOn,
        ]}
      >
        {selected ? (
          role === "radio" ? (
            <View style={styles.radioDot} />
          ) : (
            <Icon name="checkmark" size={15} color={theme.onAccent} />
          )
        ) : null}
      </View>
      <View style={styles.optionText}>
        <AppText weight="600" tone={muted && !selected ? "secondary" : "primary"}>
          {label}
        </AppText>
        {recommended ? <Pill label="Recommended" icon="sparkles" tone="accent" /> : null}
      </View>
    </Pressable>
  );
}

function LimitedInput({
  label,
  placeholder,
  value,
  limit,
  editable,
  compact = false,
  onChange,
  onFocus,
  onBlur,
}: {
  label: string;
  placeholder: string;
  value: string;
  limit: number;
  editable: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={[styles.inputWrap, compact && styles.inputWrapDocked]}>
      <TextInput
        accessibilityLabel={label}
        editable={editable}
        maxLength={limit}
        multiline
        onBlur={onBlur}
        onChangeText={onChange}
        onFocus={onFocus}
        placeholder={placeholder}
        // Apple HIG Accessibility: text, a placeholder and the counter
        // included, meets 4.5:1, which the tertiary color does not. The
        // note field is filled.
        placeholderTextColor={compact ? placeholderOnFill(theme) : theme.textSecondary}
        style={[styles.input, compact && styles.noteInput]}
        value={value}
      />
      <AppText
        variant="caption"
        tone={value.length > limit ? "red" : "secondary"}
        style={styles.counter}
      >
        {`${value.length}/${limit}`}
      </AppText>
    </View>
  );
}

// The answer controls for a pending decision, laid out as the screen: the
// decision (`children`) and any option rows or text field scroll, and a dock
// pinned to the bottom holds the recommendation, an optional note behind
// "Add note", and the send action (prototype "Decision: approve / reject"
// and "Decision: multiple choice"; req-mobile-app REQ-3). Approve and Reject
// are two buttons that each send at once; the recommended one is filled and
// marked with sparkles. Every other type sends with "Send answer". The dock
// sits below the scrolling body rather than over it, so at any text size the
// body's last line scrolls clear of the dock.
//
// The parent mounts it once per decision id, so the draft survives reactive
// updates to the same decision and never carries over to another one. While
// `submitting` is set every control is disabled. "Send answer" is also
// disabled until the draft forms an answer, with a hint above it saying what
// to do.
export function AnswerForm({
  decision,
  submitting,
  failure,
  onSubmit,
  children,
}: {
  decision: Decision;
  submitting: boolean;
  failure: string | null;
  onSubmit: (submission: AnswerSubmission) => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const stacked = useWindowDimensions().fontScale > STACK_FONT_SCALE;
  const scroll = useRef<ScrollView>(null);
  // Whether the answer text field has focus. The keyboard avoider shrinks
  // the body once the keyboard is up, which can leave the field under the
  // dock; the field is the body's last control, so the body scrolls to its
  // end (Apple HIG Entering data: keep the field being edited visible).
  const textFocused = useRef(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      if (textFocused.current) {
        scroll.current?.scrollToEnd();
      }
    });
    return () => shown.remove();
  }, []);
  const [draft, setDraft] = useState(() => initialDraft(decision.recommendation));
  const [errors, setErrors] = useState<string[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  // The approve or reject button last pressed, which reads "Sending" while
  // its request runs.
  const [sent, setSent] = useState<Choice | null>(null);
  const { recommendation } = decision;
  const options = decision.options ?? [];

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
  };
  const isRecommendedOption = (id: string) =>
    (recommendation?.kind === "option" && recommendation.option_id === id) ||
    (recommendation?.kind === "options" && recommendation.option_ids.includes(id));

  const missing = missingAnswer(decision, draft);

  const submit = (choice: Choice | null) => {
    if (submitting || (choice === null && missing !== null)) {
      return;
    }
    const result = validate(decision, draft, choice);
    if ("errors" in result) {
      setErrors(result.errors);
      // Apple HIG VoiceOver: errors that appear are announced.
      AccessibilityInfo.announceForAccessibility(result.errors.join(" "));
      return;
    }
    setSent(choice);
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
      onFocus={() => {
        textFocused.current = true;
        scroll.current?.scrollToEnd();
      }}
      onBlur={() => {
        textFocused.current = false;
      }}
    />
  );

  let controls: ReactNode = null;
  switch (decision.input_type) {
    case "approve_reject":
      break;
    case "single_choice":
      controls = options.map((option) => (
        <OptionRow
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
        <OptionRow
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
            <View style={styles.prefilled}>
              <Pill label="Recommended answer prefilled" icon="sparkles" tone="accent" />
            </View>
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
            <OptionRow
              key={option.id}
              role="radio"
              label={option.label}
              selected={draft.mode === "option" && draft.optionId === option.id}
              recommended={isRecommendedOption(option.id)}
              disabled={submitting}
              onPress={() => edit({ mode: "option", optionId: option.id, text: "" })}
            />
          ))}
          <OptionRow
            role="radio"
            label="Other answer"
            muted
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

  // Approve and Reject: one filled primary button, the recommended one with
  // sparkles, or Approve when there is no recommendation; the other is
  // secondary. Reject is an answer, not a destructive action, so it is never
  // red (Apple HIG Buttons: destructive style is for actions that destroy
  // data). Side by side they read Reject, Approve; stacked at large text
  // sizes the primary one comes first.
  const prominent: Choice = recommendation?.kind === "reject" ? "reject" : "approve";
  const choiceButton = (choice: Choice) => {
    const recommended = recommendation?.kind === choice;
    const label = choice === "approve" ? "Approve" : "Reject";
    return (
      <Button
        key={choice}
        label={submitting && sent === choice ? "Sending" : label}
        accessibilityHint={recommended ? "Recommended by the agent" : undefined}
        icon={recommended ? "sparkles" : undefined}
        variant={choice === prominent ? "primary" : "secondary"}
        disabled={submitting}
        grow={!stacked}
        onPress={() => submit(choice)}
      />
    );
  };
  const choiceOrder: Choice[] = stacked
    ? [prominent, prominent === "approve" ? "reject" : "approve"]
    : ["reject", "approve"];

  // Padding on both platforms keeps the dock above the keyboard. Android
  // draws edge to edge (DEC-17(2)), so the window no longer resizes for the
  // keyboard and the view has to make the room itself.
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      style={styles.flex}
    >
      <ScrollView
        ref={scroll}
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {children}
        {controls === null ? null : <View style={styles.controls}>{controls}</View>}
      </ScrollView>
      <Dock>
        <View style={[styles.dockLine, stacked && styles.dockLineStacked]}>
          <View style={styles.recommendation}>
            <Icon name="sparkles" size={15} color={theme.textSecondary} />
            {recommendation === null ? (
              <AppText variant="footnote" tone="secondary">
                No recommendation
              </AppText>
            ) : (
              <AppText
                variant="footnote"
                tone="secondary"
                numberOfLines={stacked ? 3 : 1}
                style={styles.flex}
              >
                {"Recommended: "}
                <AppText variant="footnote" weight="600">
                  {formatAnswer(recommendation, decision.options)}
                </AppText>
              </AppText>
            )}
          </View>
          {noteOpen ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add note"
              disabled={submitting}
              hitSlop={linkHitSlop()}
              onPress={() => setNoteOpen(true)}
              style={stacked ? styles.addNote : undefined}
            >
              <AppText variant="subhead" tone="accent">
                Add note
              </AppText>
            </Pressable>
          )}
        </View>
        {noteOpen ? (
          <LimitedInput
            label="Note"
            placeholder="Optional note"
            value={draft.note}
            limit={NOTE_LIMIT}
            editable={!submitting}
            compact
            onChange={(note) => edit({ note })}
          />
        ) : null}
        {errors.map((message) => (
          <AppText key={message} variant="footnote" tone="red">
            {message}
          </AppText>
        ))}
        {failure === null ? null : (
          <AppText variant="footnote" tone="red">
            {failure}
          </AppText>
        )}
        {decision.input_type === "approve_reject" ? (
          <View style={[styles.buttons, stacked && styles.buttonsStacked]}>
            {choiceOrder.map(choiceButton)}
          </View>
        ) : (
          <>
            {missing === null ? null : (
              <AppText variant="footnote" tone="secondary">
                {missing}
              </AppText>
            )}
            <Button
              label={submitting ? "Sending" : "Send answer"}
              accessibilityHint={missing ?? undefined}
              disabled={submitting || missing !== null}
              onPress={() => submit(null)}
            />
          </>
        )}
      </Dock>
    </KeyboardAvoidingView>
  );
}
