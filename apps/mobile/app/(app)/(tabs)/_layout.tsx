import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueries } from "convex/react";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useMemo } from "react";
import { decisions } from "../../../../../convex/decisions/refs";
import { useTheme } from "../../../src/theme";

// The number of pending decisions, from the same reactive query the inbox
// lists. useQueries hands back a failed query's error as a value instead of
// throwing it, so a failure leaves the tab bar standing with no badge while
// the inbox shows the failure and its retry.
function usePendingCount() {
  const requests = useMemo(() => ({ pending: { query: decisions.app.listPending, args: {} } }), []);
  const { pending } = useQueries(requests);
  return Array.isArray(pending) ? pending.length : 0;
}

// The three tabs on the system tab bar (Liquid Glass on iOS 26). Each tab
// holds its own stack with native headers, so the tab bar stays while the
// person drills in. iOS draws SF Symbols; Android draws the Ionicons glyphs
// the app used before. The Inbox badge is the tab bar item's own badge, so
// VoiceOver reads the count with the tab.
export default function TabsLayout() {
  const theme = useTheme();
  const count = usePendingCount();
  return (
    <NativeTabs tintColor={theme.accent} badgeBackgroundColor={theme.red}>
      <NativeTabs.Trigger name="(inbox)">
        <NativeTabs.Trigger.Icon
          sf={{ default: "tray", selected: "tray.fill" }}
          src={{
            default: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="file-tray-outline" />,
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="file-tray" />,
          }}
        />
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        {count > 0 ? (
          <NativeTabs.Trigger.Badge>{count > 99 ? "99+" : String(count)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settled)">
        <NativeTabs.Trigger.Icon
          sf={{ default: "clock", selected: "clock.fill" }}
          src={{
            default: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="time-outline" />,
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="time" />,
          }}
        />
        <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
          src={{
            default: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="settings-outline" />,
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="settings" />,
          }}
        />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
