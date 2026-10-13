import { Text, type TextProps } from "react-native";
import { type Theme, useTheme } from "../theme";

// The type scale, after iOS's text styles.
const variants = {
  largeTitle: { fontSize: 34, fontWeight: "700", letterSpacing: 0.3 },
  title1: { fontSize: 28, fontWeight: "700" },
  title2: { fontSize: 24, fontWeight: "700" },
  title3: { fontSize: 20, fontWeight: "600" },
  headline: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 17 },
  callout: { fontSize: 16 },
  subhead: { fontSize: 15 },
  footnote: { fontSize: 13 },
  caption: { fontSize: 12 },
} as const;

export type TextVariant = keyof typeof variants;
export type TextTone =
  | "primary"
  | "secondary"
  | "tertiary"
  | "accent"
  | "onAccent"
  | "red"
  | "amber"
  | "green"
  | "grey";

export function toneColor(theme: Theme, tone: TextTone): string {
  switch (tone) {
    case "primary":
      return theme.text;
    case "secondary":
      return theme.textSecondary;
    case "tertiary":
      return theme.textTertiary;
    case "accent":
      return theme.accent;
    case "onAccent":
      return theme.onAccent;
    default:
      return theme[tone];
  }
}

// Text in the app's type scale and colors. Every visible string uses it, so
// both color schemes stay legible.
export function AppText({
  variant = "body",
  tone = "primary",
  weight,
  style,
  ...props
}: TextProps & { variant?: TextVariant; tone?: TextTone; weight?: "400" | "500" | "600" | "700" }) {
  const theme = useTheme();
  return (
    <Text
      {...props}
      style={[
        variants[variant],
        { color: toneColor(theme, tone) },
        weight === undefined ? null : { fontWeight: weight },
        style,
      ]}
    />
  );
}
