import type { ReactNode } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { makeStyles } from "../theme";

const useStyles = makeStyles((theme) => ({
  dock: {
    backgroundColor: theme.tabBar,
    borderTopColor: theme.separator,
    borderTopWidth: 0.5,
    gap: 10,
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
}));

// A bar pinned to the bottom of a screen for its main actions, such as the
// answer buttons on a decision. It clears the tab bar and the home indicator:
// the native safe area inside a tab includes the tab bar, which the window
// insets from useSafeAreaInsets do not. "maximum" keeps the 12 pt padding
// where the safe area is smaller.
export function Dock({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <SafeAreaView edges={{ bottom: "maximum" }} style={styles.dock}>
      {children}
    </SafeAreaView>
  );
}
