import { ActivityIndicator, Text, View } from "react-native";
import { styles } from "./styles";

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.centered}>
      <ActivityIndicator />
      <Text style={styles.body}>{label}</Text>
    </View>
  );
}
