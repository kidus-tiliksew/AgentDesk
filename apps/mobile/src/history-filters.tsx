import { normalizeTopic } from "@agentdesk/contract";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Button } from "./button";
import { styles } from "./styles";
import { topicChips } from "./topic-chips";
import { TopicFilter } from "./topic-filter";

// component-mobile-app §Screens, history: the search field and the state and
// topic filters (req-mobile-app AC-6.1). The screen owns the values; this
// module draws the controls and debounces the search text.

export type SettledState = "answered" | "expired" | "cancelled";

// Typing settles for this long before the text reaches the backend search, so
// each keystroke does not start a new query.
export const SEARCH_DEBOUNCE_MS = 300;

// `value` once it has stopped changing for `delay` milliseconds. A newer value
// and unmounting cancel the pending timer.
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const STATES: { value: SettledState | null; label: string; accessibilityLabel: string }[] = [
  { value: null, label: "All states", accessibilityLabel: "All states" },
  { value: "answered", label: "Answered", accessibilityLabel: "State: Answered" },
  { value: "expired", label: "Expired", accessibilityLabel: "State: Expired" },
  { value: "cancelled", label: "Cancelled", accessibilityLabel: "State: Cancelled" },
];

function StateFilter({
  selected,
  disabled,
  onSelect,
}: {
  selected: SettledState | null;
  disabled: boolean;
  onSelect: (state: SettledState | null) => void;
}) {
  return (
    <ScrollView horizontal contentContainerStyle={styles.chips}>
      {STATES.map((choice) => {
        const isSelected = selected === choice.value;
        return (
          <Pressable
            key={choice.label}
            accessibilityRole="button"
            accessibilityLabel={choice.accessibilityLabel}
            accessibilityState={{ selected: isSelected, disabled }}
            disabled={disabled}
            onPress={() => onSelect(choice.value)}
            style={[styles.chip, isSelected && styles.chipSelected]}
          >
            <Text style={isSelected ? styles.chipTextSelected : styles.chipText}>
              {choice.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export const INVALID_TOPIC =
  "A topic uses lowercase letters, digits, and . _ / - only, up to 100 characters.";

// The topic filter. History has no loaded topic list that covers every page,
// so the person types a topic and applies it. The chips are that topic and
// each of its slash-delimited parent prefixes, and "All topics" clears the
// filter. The backend matches the selected chip by the contract's
// `topicMatches`, so `acme` keeps `acme/billing` and drops `acmecorp`.
function TopicField({
  entered,
  selected,
  disabled,
  onApply,
  onSelect,
}: {
  entered: string | null;
  selected: string | null;
  disabled: boolean;
  onApply: (topic: string) => void;
  onSelect: (topic: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const parsed = normalizeTopic(draft.trim());
    if (!parsed.success) {
      setError(INVALID_TOPIC);
      return;
    }
    setError(null);
    onApply(parsed.data);
  };

  return (
    <View style={styles.list}>
      <View style={styles.filterRow}>
        <TextInput
          accessibilityLabel="Topic"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          onChangeText={(text) => {
            setDraft(text);
            setError(null);
          }}
          onSubmitEditing={apply}
          placeholder="acme/billing"
          returnKeyType="done"
          style={[styles.input, styles.filterInput]}
          value={draft}
        />
        <Button label="Apply topic" onPress={apply} disabled={disabled || draft.trim() === ""} />
      </View>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      <TopicFilter
        chips={entered === null ? [] : topicChips([entered])}
        selected={selected}
        onSelect={(topic) => {
          if (!disabled) {
            onSelect(topic);
          }
        }}
      />
    </View>
  );
}

export function HistoryFilters({
  text,
  onChangeText,
  state,
  onSelectState,
  enteredTopic,
  selectedTopic,
  onApplyTopic,
  onSelectTopic,
  disabled,
}: {
  text: string;
  onChangeText: (text: string) => void;
  state: SettledState | null;
  onSelectState: (state: SettledState | null) => void;
  enteredTopic: string | null;
  selectedTopic: string | null;
  onApplyTopic: (topic: string) => void;
  onSelectTopic: (topic: string | null) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.filters}>
      <TextInput
        accessibilityLabel="Search history"
        autoCapitalize="none"
        editable={!disabled}
        onChangeText={onChangeText}
        placeholder="Search titles, bodies, answers, and notes"
        returnKeyType="search"
        style={styles.input}
        value={text}
      />
      <StateFilter selected={state} disabled={disabled} onSelect={onSelectState} />
      <TopicField
        entered={enteredTopic}
        selected={selectedTopic}
        disabled={disabled}
        onApply={onApplyTopic}
        onSelect={onSelectTopic}
      />
    </View>
  );
}
