import { useMemo, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  type ColorSchemeName,
  Platform,
  StyleSheet,
  useColorScheme,
} from "react-native";

// The app's colors, in light and dark, each with an Increase Contrast variant
// (Apple HIG Accessibility: text meets 4.5:1, and a higher-contrast scheme
// applies when the person turns on Increase Contrast). The accent is Indigo
// Ink: `accentFill` is the fill behind white text, and `accent` is the color
// of links, icons, and selected controls. Status colors are shared by every
// screen: red for urgent and destructive, amber for stale, green for answered
// and live, grey for expired and cancelled. Every text color here, including
// on its own pill tint (`pillAlpha`), measures at least 4.5:1 against the
// background and card; `redFill` is the red behind white text.
export type Theme = {
  scheme: "light" | "dark";
  contrast: "normal" | "high";
  background: string;
  card: string;
  cardRaised: string;
  fill: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  pillNeutral: string;
  separator: string;
  accent: string;
  accentFill: string;
  onAccent: string;
  red: string;
  redFill: string;
  amber: string;
  green: string;
  grey: string;
  tabBar: string;
  pillAlpha: number;
};

const light: Theme = {
  scheme: "light",
  contrast: "normal",
  background: "#f2f2f7",
  card: "#ffffff",
  cardRaised: "#ffffff",
  fill: "rgba(142, 142, 147, 0.16)",
  text: "#000000",
  textSecondary: "#6c6c72",
  textTertiary: "#a1a1a6",
  pillNeutral: "#5d5d63",
  separator: "rgba(60, 60, 67, 0.18)",
  accent: "#4f46e5",
  accentFill: "#4f46e5",
  onAccent: "#ffffff",
  red: "#b3241b",
  redFill: "#b3241b",
  amber: "#8f5400",
  green: "#12703a",
  grey: "#8e8e93",
  tabBar: "#f9f9f9",
  pillAlpha: 0.1,
};

const lightHigh: Theme = {
  ...light,
  contrast: "high",
  textSecondary: "#48484e",
  textTertiary: "#6c6c72",
  pillNeutral: "#3c3c43",
  separator: "rgba(60, 60, 67, 0.36)",
  accent: "#3730a3",
  accentFill: "#3730a3",
  red: "#8f1a13",
  redFill: "#8f1a13",
  amber: "#6e4100",
  green: "#0c5a2c",
  grey: "#6c6c72",
};

const dark: Theme = {
  scheme: "dark",
  contrast: "normal",
  background: "#000000",
  card: "#1c1c1e",
  cardRaised: "#2c2c2e",
  fill: "rgba(142, 142, 147, 0.24)",
  text: "#ffffff",
  textSecondary: "#9a9aa1",
  textTertiary: "#636366",
  pillNeutral: "#aeaeb4",
  separator: "rgba(84, 84, 88, 0.6)",
  accent: "#9993ff",
  accentFill: "#4f46e5",
  onAccent: "#ffffff",
  red: "#ff7469",
  redFill: "#cc2f25",
  amber: "#ffb340",
  green: "#34c46a",
  grey: "#8e8e93",
  tabBar: "#161618",
  pillAlpha: 0.16,
};

const darkHigh: Theme = {
  ...dark,
  contrast: "high",
  textSecondary: "#c7c7cc",
  textTertiary: "#9a9aa1",
  pillNeutral: "#d1d1d6",
  separator: "rgba(140, 140, 145, 0.7)",
  accent: "#b3afff",
  red: "#ff8a82",
  redFill: "#b3241b",
  amber: "#ffc566",
  green: "#4cd982",
  grey: "#aeaeb2",
};

export const themes = { light, dark, lightHigh, darkHigh };

// Placeholder text on a field filled with `fill`. In the light scheme the fill
// darkens the field below the secondary color's 4.5:1, so Android, which
// DEC-17(4) holds to 4.5:1 in both schemes, uses the Increase Contrast
// secondary color there. Every other case keeps the secondary color.
export function placeholderOnFill(theme: Theme): string {
  return Platform.OS === "android" && theme.scheme === "light" && theme.contrast !== "high"
    ? lightHigh.textSecondary
    : theme.textSecondary;
}

// Whether iOS Increase Contrast ("darker system colors") is on, shared by
// every themed component and updated when the setting changes. Android
// reports false.
const increaseContrast = {
  value: false,
  listeners: new Set<() => void>(),
  set(next: boolean) {
    if (next !== this.value) {
      this.value = next;
      for (const listener of this.listeners) listener();
    }
  },
};
if (Platform.OS === "ios") {
  AccessibilityInfo.isDarkerSystemColorsEnabled?.()
    .then((enabled) => increaseContrast.set(enabled))
    .catch(() => undefined);
  AccessibilityInfo.addEventListener?.("darkerSystemColorsChanged", (enabled) =>
    increaseContrast.set(enabled),
  );
}

function subscribeContrast(listener: () => void) {
  increaseContrast.listeners.add(listener);
  return () => {
    increaseContrast.listeners.delete(listener);
  };
}

export function themeFor(scheme: ColorSchemeName, high = false): Theme {
  if (scheme === "dark") {
    return high ? darkHigh : dark;
  }
  return high ? lightHigh : light;
}

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const high = useSyncExternalStore(subscribeContrast, () => increaseContrast.value);
  return themeFor(scheme, high);
}

// A color at the given opacity, for tinted backgrounds such as a red pill.
// Accepts #rrggbb only.
export function tint(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export const radius = { card: 16, control: 12, small: 10, pill: 999 };
export const spacing = { screen: 16, gap: 10 };

// The smallest touch target: 44x44 pt on iOS (Apple HIG Buttons) and 48x48 dp
// on Android (DEC-17(4)). Controls read it while rendering.
export function minTouchTarget(): number {
  return Platform.OS === "android" ? 48 : 44;
}

// The hit slop of a one-line text link, which draws about 20 pt tall. It
// grows the link's hit region to the smallest touch target.
export function linkHitSlop() {
  const vertical = Platform.OS === "android" ? 14 : 12;
  return { top: vertical, bottom: vertical, left: 8, right: 8 };
}

// Builds a hook that returns a StyleSheet for the current color scheme and
// contrast. Each combination's sheet is created once.
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (theme: Theme) => T) {
  const sheets = new Map<string, T>();
  return function useStyles(): T {
    const theme = useTheme();
    return useMemo(() => {
      const key = `${theme.scheme}-${theme.contrast}`;
      let sheet = sheets.get(key);
      if (sheet === undefined) {
        sheet = StyleSheet.create(factory(theme));
        sheets.set(key, sheet);
      }
      return sheet;
    }, [theme]);
  };
}
