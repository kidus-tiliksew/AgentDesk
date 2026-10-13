import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { makeStyles } from "../theme";

const useStyles = makeStyles((theme) => ({
  dock: {
    backgroundColor: theme.tabBar,
    borderTopColor: theme.separator,
    borderTopWidth: 0.5,
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
}));

// A bar pinned to the bottom of a screen for its main actions, such as the
// answer buttons on a decision. It clears the home indicator.
export function Dock({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) }]}>{children}</View>
  );
}
