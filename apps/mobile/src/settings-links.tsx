import { Link } from "expo-router";
import { View } from "react-native";
import { styles } from "./styles";

// The inbox header's links to the decision history and the settings screens.
export function SettingsLinks() {
  return (
    <View style={styles.headerLinks}>
      <Link href="/history" style={styles.link}>
        History
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
