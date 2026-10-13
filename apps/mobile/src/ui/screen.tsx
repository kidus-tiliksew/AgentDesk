import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { makeStyles } from "../theme";

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
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </>
  );
}

// A pushed screen's scrolling body under the stack header.
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
      contentContainerStyle={{ paddingBottom: bottomInset, paddingTop: 4 }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
