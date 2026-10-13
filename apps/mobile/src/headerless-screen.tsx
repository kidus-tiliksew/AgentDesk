import type { ReactNode } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SCREEN_PADDING } from "./styles";
import { useTheme } from "./theme";

// A screen drawn without a navigation header: sign-in, the configuration
// screen, the guards' loading states, and the account gate's states. It adds
// the device's safe-area insets to the screen padding, so the content clears
// the status bar, the camera cutout, and the home indicator. A screen under a
// stack header keeps its own layout, since the header already clears the
// status bar. Expo Router's root provides the safe-area context.
export function HeaderlessScreen({
  style,
  children,
}: {
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  return (
    <View
      style={[
        { backgroundColor: theme.background },
        style,
        {
          paddingTop: SCREEN_PADDING + insets.top,
          paddingRight: SCREEN_PADDING + insets.right,
          paddingBottom: SCREEN_PADDING + insets.bottom,
          paddingLeft: SCREEN_PADDING + insets.left,
        },
      ]}
    >
      {children}
    </View>
  );
}
