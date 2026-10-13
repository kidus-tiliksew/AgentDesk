import { Stack } from "expo-router";
import { largeTitleOptions, tabStackOptions, useTabVisited } from "../../../../src/tab-stack";

// The Inbox tab, group (inbox), and the History tab, group (settled), share
// their drill-down screens. Expo Router's array group makes this layout, and
// the decision, agent, and digest routes beside it, exist once in each group,
// each group with its own stack. A push of /decision/[id] from a History row
// lands on the History stack and one from the inbox lands on the Inbox stack,
// so the tab bar stays and back returns to the screen that pushed.
//
// A URL that comes from neither tab, such as a cold link or a tapped
// notification over Settings, matches the group that sorts first, so the
// History group is named (settled) to sort after (inbox): those open on the
// Inbox stack, with the inbox under them as the anchor.
export const unstable_settings = {
  inbox: { anchor: "index" },
  settled: { anchor: "history" },
};

export default function FeedLayout({ segment }: { segment: string }) {
  const visited = useTabVisited();
  if (!visited) {
    return null;
  }
  return (
    <Stack screenOptions={tabStackOptions}>
      {segment === "(settled)" ? (
        <Stack.Screen name="history" options={largeTitleOptions("History")} />
      ) : (
        <Stack.Screen name="index" options={largeTitleOptions("Inbox")} />
      )}
      {/* Titles shown while a screen loads; each screen may replace its own. */}
      <Stack.Screen name="decision/[id]" options={{ title: "Decision" }} />
      <Stack.Screen name="agent/[id]" options={{ title: "Agent" }} />
      <Stack.Screen name="digest/[id]" options={{ title: "Digest" }} />
    </Stack>
  );
}
