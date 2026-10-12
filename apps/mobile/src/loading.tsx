import { ActivityIndicator, Text, View } from "react-native";
import { HeaderlessScreen } from "./headerless-screen";
import { styles } from "./styles";

// A spinner and a label. `headerless` marks a caller drawn without a
// navigation header, which needs the safe-area insets; a screen under a stack
// header leaves it off.
export function Loading({ label, headerless = false }: { label: string; headerless?: boolean }) {
  const content = (
    <>
      <ActivityIndicator />
      <Text style={styles.body}>{label}</Text>
    </>
  );
  if (headerless) {
    return <HeaderlessScreen style={styles.centered}>{content}</HeaderlessScreen>;
  }
  return <View style={styles.centered}>{content}</View>;
}
