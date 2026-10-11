import { Text, View } from "react-native";
import { styles } from "../../src/styles";

// Placeholder inbox. Phase 2 slice 3 replaces this file's contents with
// pending decisions and live agents (component-mobile-app §Screens).
export default function InboxScreen() {
  return (
    <View style={styles.centered}>
      <Text style={styles.body}>Your pending decisions and live agents will appear here.</Text>
    </View>
  );
}
