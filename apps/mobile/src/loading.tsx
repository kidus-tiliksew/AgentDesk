import { ActivityIndicator, View } from "react-native";
import { HeaderlessScreen } from "./headerless-screen";
import { styles } from "./styles";
import { useTheme } from "./theme";
import { AppText } from "./ui/text";

// A spinner and a label. `headerless` marks a caller drawn without a
// navigation header, which needs the safe-area insets; a screen under a stack
// header leaves it off.
export function Loading({ label, headerless = false }: { label: string; headerless?: boolean }) {
  const theme = useTheme();
  const content = (
    <>
      <ActivityIndicator color={theme.textSecondary} />
      <AppText variant="callout" tone="secondary">
        {label}
      </AppText>
    </>
  );
  if (headerless) {
    return <HeaderlessScreen style={styles.centered}>{content}</HeaderlessScreen>;
  }
  return <View style={[styles.centered, { backgroundColor: theme.background }]}>{content}</View>;
}
