import { Pressable } from "react-native";
import { makeStyles, minTouchTarget, radius, tint, useTheme } from "./theme";
import { Icon, type IconName } from "./ui/icon";
import { AppText, toneColor } from "./ui/text";

export type ButtonVariant = "primary" | "secondary" | "tinted" | "destructive" | "plain";

const useStyles = makeStyles((theme) => ({
  base: {
    alignItems: "center",
    borderRadius: radius.control,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 16,
  },
  // A hit region of at least the smallest touch target, small buttons too:
  // 44 pt on iOS, 48 dp on Android.
  small: { borderRadius: radius.small, paddingHorizontal: 12 },
  primary: { backgroundColor: theme.accentFill },
  secondary: { backgroundColor: theme.fill },
  tinted: { backgroundColor: tint(theme.accentFill, theme.scheme === "dark" ? 0.3 : 0.12) },
  destructive: { backgroundColor: tint(theme.red, theme.pillAlpha) },
  plain: { backgroundColor: "transparent" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  grow: { flex: 1 },
}));

const labelTone = {
  primary: "onAccent",
  secondary: "primary",
  tinted: "accent",
  destructive: "red",
  plain: "accent",
} as const;

// A button. `primary` is the filled main action; the other variants are
// quieter. While `disabled` is set the press does nothing, which is how
// screens refuse a second submission while a request runs.
export function Button({
  label,
  onPress,
  disabled = false,
  variant = "primary",
  size = "regular",
  icon,
  grow = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: "regular" | "small";
  icon?: IconName;
  grow?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const tone = labelTone[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === "small" && [styles.small, { minHeight: minTouchTarget() }],
        styles[variant],
        grow && styles.grow,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      {icon === undefined ? null : <Icon name={icon} size={17} color={toneColor(theme, tone)} />}
      <AppText variant={size === "small" ? "subhead" : "headline"} weight="600" tone={tone}>
        {label}
      </AppText>
    </Pressable>
  );
}
