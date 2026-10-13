import { Pressable } from "react-native";
import { useTheme } from "../theme";
import { Icon, type IconName } from "../ui/icon";
import { AppText } from "../ui/text";

// A navigation header button: an accent glyph such as the rules list's +, or
// an accent word such as the rule editor's Cancel and Save. `label` is the
// accessible name, and the visible text when there is no icon. `emphasis`
// sets the word in semibold, as iOS does for a sheet's confirming action.
export function HeaderButton({
  label,
  icon,
  emphasis = false,
  disabled = false,
  onPress,
}: {
  label: string;
  icon?: IconName;
  emphasis?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      // Apple HIG Accessibility: a 44pt target, however short the word.
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        minWidth: 44,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      {icon === undefined ? (
        <AppText tone="accent" weight={emphasis ? "600" : "400"}>
          {label}
        </AppText>
      ) : (
        <Icon name={icon} size={26} color={theme.accent} />
      )}
    </Pressable>
  );
}
