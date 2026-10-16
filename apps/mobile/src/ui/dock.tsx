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
// insets from useSafeAreaInsets do not. "additive" sets the bottom padding to
// that safe area plus 12 pt, so a gap always separates the actions from the
// tab bar, or from the screen's edge where there is no safe area.
export function Dock({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <SafeAreaView edges={{ bottom: "additive" }} style={styles.dock}>
      {children}
    </SafeAreaView>
  );
}
