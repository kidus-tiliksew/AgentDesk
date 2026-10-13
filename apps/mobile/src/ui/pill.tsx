import { View } from "react-native";
import { radius, type Theme, tint, useTheme } from "../theme";
import { Icon, type IconName } from "./icon";
import { AppText } from "./text";

export type PillTone = "neutral" | "accent" | "red" | "amber" | "green";

function colors(theme: Theme, tone: PillTone) {
  if (tone === "neutral") {
    return { fg: theme.pillNeutral, bg: theme.fill };
  }
  const fg = theme[tone];
  return { fg, bg: tint(fg, theme.pillAlpha) };
}

// A small rounded label: a deadline, a priority, a topic, a recommendation.
export function Pill({
  label,
  tone = "neutral",
  icon,
  accessibilityLabel,
}: {
  label: string;
  tone?: PillTone;
  icon?: IconName;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const { fg, bg } = colors(theme, tone);
  return (
    <View
      // A label makes the pill one element, so VoiceOver reads the label
      // (e.g. an exact deadline) instead of the short visible text.
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      style={{
        alignItems: "center",
        alignSelf: "flex-start",
        backgroundColor: bg,
        borderRadius: radius.pill,
        flexDirection: "row",
        gap: 3,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      {icon === undefined ? null : <Icon name={icon} size={12} color={fg} />}
      <AppText variant="caption" weight="600" style={{ color: fg }}>
        {label}
      </AppText>
    </View>
  );
}
