import { Stack } from "expo-router";
import { largeTitleOptions, tabStackOptions, useTabVisited } from "../../../../src/tab-stack";

// The Settings tab's stack. Its screens push here, under the tab bar. The
// Settings list is the anchor, so back from a deep-linked or cross-tab push,
// such as the inbox's "Enter installer code", reaches it.
export const unstable_settings = {
  anchor: "index",
};

export default function SettingsLayout() {
  const visited = useTabVisited();
  if (!visited) {
    return null;
  }
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={largeTitleOptions("Settings")} />
      {/* The title shown while a rule loads; the editor replaces it. Apple
          HIG Sheets: editing a rule is a self-contained task, so the editor
          slides up as a sheet with Cancel and Save in its navigation bar.
          "modal" is the iOS page sheet, which keeps the native header and
          its bar buttons; "formSheet" is a detent sheet, which
          react-native-screens renders as an Android bottom sheet without
          nested stack support. */}
      <Stack.Screen name="rule/[id]" options={{ title: "Rule", presentation: "modal" }} />
    </Stack>
  );
}
