import { HeaderlessScreen } from "./headerless-screen";
import { styles } from "./styles";
import { AppText } from "./ui/text";

// Shown instead of the app when a public configuration variable is missing,
// so the app names the gap rather than crashing in a provider. It shows
// variable names only, never values.
export function ConfigError({ missing }: { missing: string[] }) {
  return (
    <HeaderlessScreen style={styles.centered}>
      <AppText accessibilityRole="header" variant="title3" style={{ textAlign: "center" }}>
        AgentDesk is not configured
      </AppText>
      <AppText variant="callout" style={{ textAlign: "center" }}>
        Set these variables in apps/mobile/.env and restart Expo:
      </AppText>
      {missing.map((name) => (
        <AppText key={name} variant="subhead" style={{ fontFamily: "Courier" }}>
          {name}
        </AppText>
      ))}
    </HeaderlessScreen>
  );
}
