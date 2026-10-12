import { Link } from "expo-router";
import { View } from "react-native";
import { styles } from "./styles";

// The inbox header's links to the decision history, the notification rules,
// the notification settings, and the other settings screens.
export function SettingsLinks() {
  return (
    <View style={styles.headerLinks}>
      <Link href="/history" style={styles.link}>
        History
      </Link>
      <Link href="/settings/rules" style={styles.link}>
        Rules
      </Link>
      <Link href="/settings/notifications" style={styles.link}>
        Notifications
      </Link>
      <Link href="/settings/connections" style={styles.link}>
        Connections
      </Link>
      <Link href="/settings/account" style={styles.link}>
        Account
      </Link>
    </View>
  );
}
