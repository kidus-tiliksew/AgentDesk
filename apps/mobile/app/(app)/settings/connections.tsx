import { Stack } from "expo-router";
import { Text, View } from "react-native";
import { styles } from "../../../src/styles";

// Placeholder connections screen. Phase 2 slice 6 replaces this file's
// contents with connected harnesses and revocation (component-mobile-app
// §Screens).
export default function ConnectionsScreen() {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: "Connections" }} />
      <Text style={styles.body}>Your connected harnesses will appear here.</Text>
    </View>
  );
}
