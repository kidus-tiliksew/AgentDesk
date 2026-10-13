import { View } from "react-native";
import { type Theme, useTheme } from "../theme";

export type DotTone = "green" | "amber" | "accent" | "grey" | "red";

function dotColor(theme: Theme, tone: DotTone) {
  return tone === "accent" ? theme.accent : theme[tone];
}

// A small colored dot for an agent's state.
export function StatusDot({ tone }: { tone: DotTone }) {
  const theme = useTheme();
  return (
    <View
      style={{ backgroundColor: dotColor(theme, tone), borderRadius: 5, height: 10, width: 10 }}
    />
  );
}
