import { Pressable } from "react-native";
import { makeStyles, radius, tint, useTheme } from "../theme";
import { Icon, type IconName } from "../ui/icon";
import { AppText } from "../ui/text";

// The rule editor's controls (prototype frame "Rule editor"): the tappable
// parts of the rule's sentence, the option list one of them opens, and the
// three large action buttons.

const useStyles = makeStyles((theme) => ({
  token: {
    backgroundColor: tint(theme.accent, theme.scheme === "dark" ? 0.22 : 0.12),
    borderRadius: 9,
    paddingHorizontal: 9,
  },
  tokenOpen: { backgroundColor: tint(theme.accent, theme.scheme === "dark" ? 0.36 : 0.22) },
  tokenError: { backgroundColor: tint(theme.red, theme.scheme === "dark" ? 0.22 : 0.12) },
  sentenceText: { fontSize: 22, fontWeight: "600", lineHeight: 34 },
  option: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  // Apple HIG Typography: the buttons grow with Dynamic Type instead of
  // clipping their label, so they set a minimum height, not a height.
  action: {
    alignItems: "center",
    backgroundColor: theme.fill,
    borderRadius: radius.control,
    flex: 1,
    gap: 4,
    justifyContent: "center",
    minHeight: 74,
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  // One full-width button per line, with its glyph before its label.
  actionStacked: { flex: 0, flexDirection: "row", gap: 10, minHeight: 56 },
  actionSelected: { backgroundColor: theme.accentFill },
}));

// One word of the sentence outside a token.
export function SentenceWord({ children }: { children: string }) {
  const styles = useStyles();
  return <AppText style={styles.sentenceText}>{children}</AppText>;
}

// A tappable part of the sentence. It opens the option list for its field,
// and turns red while the field has an error.
export function SentenceToken({
  field,
  phrase,
  open,
  invalid,
  disabled,
  onPress,
}: {
  field: string;
  phrase: string;
  open: boolean;
  invalid: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${field}, ${phrase}`}
      accessibilityHint={`Changes the ${field.toLowerCase()} this rule matches`}
      accessibilityState={{ expanded: open, disabled }}
      disabled={disabled}
      // The token's line is 34pt tall; the slop makes the target 44pt
      // (Apple HIG Accessibility: hit targets).
      hitSlop={{ top: 5, bottom: 5 }}
      onPress={onPress}
      style={[styles.token, open && styles.tokenOpen, invalid && styles.tokenError]}
    >
      <AppText tone={invalid ? "red" : "accent"} style={styles.sentenceText}>
        {phrase}
      </AppText>
    </Pressable>
  );
}

// One choice in an open field's list, checked when it is the field's value.
// Its accessible name is "Field: Choice", e.g. "Event: Agent stale".
export function OptionRow({
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
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${group}: ${label}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.pressed]}
    >
      <AppText style={{ flex: 1 }}>{label}</AppText>
      {selected ? <Icon name="checkmark" size={20} color={theme.accent} /> : null}
    </Pressable>
  );
}

// One of the three large action buttons; the selected one is filled.
// `stacked` lays it out for a vertical list, at large text sizes.
export function ActionButton({
  label,
  icon,
  selected,
  disabled,
  stacked,
  onPress,
}: {
  label: string;
  icon: IconName;
  selected: boolean;
  disabled: boolean;
  stacked: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const color = selected ? theme.onAccent : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Action: ${label}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        stacked && styles.actionStacked,
        selected && styles.actionSelected,
        pressed && !disabled && { opacity: 0.75 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Icon name={icon} size={24} color={color} />
      <AppText weight="600" style={{ color }}>
        {label}
      </AppText>
    </Pressable>
  );
}
