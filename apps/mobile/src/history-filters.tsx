import { normalizeTopic } from "@agentdesk/contract";
import { type ReactNode, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, TextInput, View } from "react-native";
import { Button } from "./button";
import { makeStyles, minTouchTarget, placeholderOnFill, radius, spacing, useTheme } from "./theme";
import { topicChips } from "./topic-chips";
import { Chip, ChipRow } from "./ui/chip";
import { Icon } from "./ui/icon";
import { SegmentedControl } from "./ui/segmented";
import { AppText } from "./ui/text";

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

export const INVALID_TOPIC =
  "A topic uses lowercase letters, digits, and . _ / - only, up to 100 characters.";

// Apple HIG Typography: the fields hold text that grows with Dynamic Type, so
// they set a minimum height and padding, never a fixed height.
const useStyles = makeStyles((theme) => ({
  filters: { gap: 10, paddingBottom: 4 },
  search: {
    alignItems: "center",
    backgroundColor: theme.fill,
    borderRadius: 11,
    flexDirection: "row",
    gap: 6,
    marginHorizontal: spacing.screen,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: { color: theme.text, flex: 1, fontSize: 16, paddingVertical: 0 },
  // On Android the text field itself fills the 48 dp bar, so a touch
  // anywhere on the bar focuses it (DEC-17(4)).
  searchAndroid: { minHeight: 48, paddingVertical: 0 },
  searchInputAndroid: { alignSelf: "stretch", minHeight: 48 },
  topicField: { gap: 6, marginHorizontal: spacing.screen },
  topicRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  topicInput: {
    backgroundColor: theme.card,
    borderRadius: radius.small,
    color: theme.text,
    flex: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  disabled: { opacity: 0.5 },
}));

// The controls a running deletion locks. The wrapper reports the disabled
// state to assistive technology and stops touches; the handlers refuse input
// as well, since a touch can land before the re-render.
function Lockable({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View
      accessibilityState={{ disabled }}
      pointerEvents={disabled ? "none" : "auto"}
      style={disabled ? styles.disabled : null}
    >
      {children}
    </View>
  );
}

// The native-looking search field: a magnifier, the text, and a clear button
// once there is text. The clear button's slop makes it a 44pt target (Apple
// HIG Buttons).
function SearchField({
  text,
  disabled,
  onChangeText,
}: {
  text: string;
  disabled: boolean;
  onChangeText: (text: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={[styles.search, Platform.OS === "android" && styles.searchAndroid]}>
      <Icon name="search" size={17} color={theme.textSecondary} />
      <TextInput
        accessibilityLabel="Search history"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={onChangeText}
        placeholder="Search titles, bodies, answers, notes"
        placeholderTextColor={placeholderOnFill(theme)}
        returnKeyType="search"
        selectionColor={theme.accent}
        style={[styles.searchInput, Platform.OS === "android" && styles.searchInputAndroid]}
        value={text}
      />
      {text === "" ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          accessibilityState={{ disabled }}
          disabled={disabled}
          // The 17 pt icon's hit region is the smallest touch target.
          hitSlop={Platform.OS === "android" ? 16 : 14}
          onPress={() => onChangeText("")}
        >
          <Icon name="close-circle" size={17} color={theme.textTertiary} />
        </Pressable>
      )}
    </View>
  );
}

type StateChoice = SettledState | "all";

const STATES: { value: StateChoice; label: string; accessibilityLabel: string }[] = [
  { value: "all", label: "All", accessibilityLabel: "All states" },
  { value: "answered", label: "Answered", accessibilityLabel: "State: Answered" },
  { value: "expired", label: "Expired", accessibilityLabel: "State: Expired" },
  { value: "cancelled", label: "Cancelled", accessibilityLabel: "State: Cancelled" },
];

// The field behind the "Other topic" chip, for a topic no loaded row carries:
// the chips only know the topics of the pages loaded so far, and the backend
// filters every page. The applied topic is normalized by the contract's rule.
function OtherTopicField({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (topic: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    if (disabled) {
      return;
    }
    const parsed = normalizeTopic(draft.trim());
    if (!parsed.success) {
      setError(INVALID_TOPIC);
      // VoiceOver speaks the rule when it appears under the field.
      AccessibilityInfo.announceForAccessibility(INVALID_TOPIC);
      return;
    }
    setError(null);
    onApply(parsed.data);
  };

  return (
    <View style={styles.topicField}>
      <View style={styles.topicRow}>
        <TextInput
          accessibilityLabel="Topic"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          editable={!disabled}
          onChangeText={(text) => {
            setDraft(text);
            setError(null);
          }}
          onSubmitEditing={apply}
          placeholder="acme/billing"
          placeholderTextColor={theme.textSecondary}
          returnKeyType="done"
          selectionColor={theme.accent}
          // As tall as the Apply button beside it, the smallest touch target.
          style={[styles.topicInput, { minHeight: minTouchTarget() }]}
          value={draft}
        />
        <Button
          label="Apply"
          accessibilityLabel="Apply topic"
          size="small"
          variant="tinted"
          onPress={apply}
          disabled={disabled || draft.trim() === ""}
        />
      </View>
      {error === null ? null : (
        <AppText variant="footnote" tone="red">
          {error}
        </AppText>
      )}
    </View>
  );
}

// "All topics", one chip per known topic and each of its parent prefixes (as
// the inbox derives them), and "Other topic" for any other topic or prefix.
// The backend matches the selected chip by the contract's `topicMatches`, so
// `acme` keeps `acme/billing` and drops `acmecorp`.
function TopicFilter({
  topics,
  selected,
  disabled,
  onApply,
  onSelect,
}: {
  topics: string[];
  selected: string | null;
  disabled: boolean;
  onApply: (topic: string) => void;
  onSelect: (topic: string | null) => void;
}) {
  const [other, setOther] = useState(false);
  const select = (topic: string | null) => {
    if (!disabled) {
      setOther(false);
      onSelect(topic);
    }
  };
  return (
    <>
      <Lockable disabled={disabled}>
        <ChipRow>
          <Chip label="All topics" selected={selected === null} onPress={() => select(null)} />
          {topicChips(topics).map((chip) => (
            <Chip
              key={chip}
              label={chip}
              accessibilityLabel={`Topic: ${chip}`}
              selected={selected === chip}
              onPress={() => select(chip)}
            />
          ))}
          <Chip
            label="Other topic…"
            accessibilityLabel="Other topic"
            selected={other}
            onPress={() => {
              if (!disabled) {
                setOther(!other);
              }
            }}
          />
        </ChipRow>
      </Lockable>
      {other ? (
        <OtherTopicField
          disabled={disabled}
          onApply={(topic) => {
            setOther(false);
            onApply(topic);
          }}
        />
      ) : null}
    </>
  );
}

export function HistoryFilters({
  text,
  onChangeText,
  state,
  onSelectState,
  topics,
  selectedTopic,
  onApplyTopic,
  onSelectTopic,
  disabled,
}: {
  text: string;
  onChangeText: (text: string) => void;
  state: SettledState | null;
  onSelectState: (state: SettledState | null) => void;
  topics: string[];
  selectedTopic: string | null;
  onApplyTopic: (topic: string) => void;
  onSelectTopic: (topic: string | null) => void;
  disabled: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.filters}>
      <SearchField text={text} disabled={disabled} onChangeText={onChangeText} />
      <Lockable disabled={disabled}>
        <SegmentedControl
          options={STATES}
          value={state ?? "all"}
          onChange={(choice) => {
            if (!disabled) {
              onSelectState(choice === "all" ? null : choice);
            }
          }}
        />
      </Lockable>
      <TopicFilter
        topics={topics}
        selected={selectedTopic}
        disabled={disabled}
        onApply={onApplyTopic}
        onSelect={onSelectTopic}
      />
    </View>
  );
}
