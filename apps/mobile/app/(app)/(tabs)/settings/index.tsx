import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { GroupedRow, GroupedSection } from "../../../../src/ui/grouped";
import { LargeTitleScreen } from "../../../../src/ui/screen";
import { AppText } from "../../../../src/ui/text";

// The Settings tab: one list for everything the inbox header used to link to.
// Each row pushes its screen on the Settings tab's stack.
export default function SettingsScreen() {
  const router = useRouter();
  const version = Constants.expoConfig?.version;
  return (
    <LargeTitleScreen title="Settings">
      <GroupedSection title="Notifications">
        <GroupedRow
          title="Notifications"
          icon={{ name: "notifications", color: "#ff3b30" }}
          chevron
          onPress={() => router.push("/settings/notifications")}
        />
        <GroupedRow
          title="Rules"
          icon={{ name: "options", color: "#5856d6" }}
          chevron
          onPress={() => router.push("/settings/rules")}
        />
      </GroupedSection>
      <GroupedSection title="Machines">
        <GroupedRow
          title="Connections"
          icon={{ name: "terminal", color: "#34c759" }}
          chevron
          onPress={() => router.push("/settings/connections")}
        />
        <GroupedRow
          title="Add machine"
          icon={{ name: "add", color: "#007aff" }}
          chevron
          onPress={() => router.push("/settings/add-machine")}
        />
      </GroupedSection>
      <GroupedSection title="Account">
        <GroupedRow
          title="Account"
          icon={{ name: "person", color: "#8e8e93" }}
          chevron
          onPress={() => router.push("/settings/account")}
        />
      </GroupedSection>
      {version === undefined ? null : (
        <View style={{ paddingTop: 24 }}>
          <AppText variant="footnote" tone="secondary" style={{ textAlign: "center" }}>
            {`AgentDesk ${version}`}
          </AppText>
        </View>
      )}
    </LargeTitleScreen>
  );
}
