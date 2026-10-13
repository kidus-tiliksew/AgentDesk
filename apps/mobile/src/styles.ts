import { StyleSheet } from "react-native";

// The padding around a screen's content. A screen without a navigation header
// adds the device's safe-area insets to it (src/headerless-screen.tsx).
export const SCREEN_PADDING = 24;

// Layout shared by the headerless states (loading, configuration, account
// gate). Colors come from src/theme.ts; screens style themselves with
// makeStyles and the primitives in src/ui.
export const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: SCREEN_PADDING,
  },
  error: { color: "#e0352b", fontSize: 15 },
});
