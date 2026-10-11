import { Stack } from "expo-router";
import { Text, View } from "react-native";
import { styles } from "../../../src/styles";

// Placeholder decision screen, so inbox and agent screen rows have a route to
// open. The decision screen task 261011-489b69 replaces this file's contents
// with the decision and its answer controls (component-mobile-app §Screens).
export default function DecisionScreen() {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: "Decision" }} />
      <Text style={styles.body}>The decision view is coming soon.</Text>
    </View>
  );
}
