import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { makeStyles } from "../theme";

// The space below a scrolling page's last item.
export const SCREEN_BOTTOM_PADDING = 32;

const useStyles = makeStyles((theme) => ({
  screen: { backgroundColor: theme.background, flex: 1 },
}));

// A tab's root screen: a scrolling page under the stack's native large-title
// header. The scroll view adjusts its insets for the translucent header and
// the tab bar, so the large title collapses into the navigation bar as the
// page scrolls. `accessory` becomes the header's right item, e.g. a + button.
export function LargeTitleScreen({
  title,
  accessory,
  children,
}: {
  title: string;
  accessory?: ReactNode;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerLargeTitleEnabled: true,
          ...(accessory === undefined ? {} : { headerRight: () => accessory }),
        }}
      />
      <ScrollView
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: SCREEN_BOTTOM_PADDING }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </>
  );
}

// A pushed screen's scrolling body under the stack header. The page runs
// behind the translucent tab bar, so the scroll view adjusts its insets for
// it as LargeTitleScreen's does: the last item scrolls clear of the tab bar
// and stays there when the drag is released. `bottomInset` is the space
// below the last item, on top of that adjustment. The opaque header sits
// above the scroll view rather than over it, so the adjustment adds no top
// inset.
export function StackScreen({
  children,
  bottomInset = 32,
}: {
  children: ReactNode;
  bottomInset?: number;
}) {
  const styles = useStyles();
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset, paddingTop: 4 }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
