import { Text } from "react-native";
import { HeaderlessScreen } from "./headerless-screen";
import { styles } from "./styles";

// Shown instead of the app when a public configuration variable is missing,
// so the app names the gap rather than crashing in a provider. It shows
// variable names only, never values.
export function ConfigError({ missing }: { missing: string[] }) {
  return (
    <HeaderlessScreen style={styles.centered}>
      <Text accessibilityRole="header" style={styles.title}>
        AgentDesk is not configured
      </Text>
      <Text style={styles.body}>Set these variables in apps/mobile/.env and restart Expo:</Text>
      {missing.map((name) => (
        <Text key={name} style={styles.code}>
          {name}
        </Text>
      ))}
    </HeaderlessScreen>
  );
}
