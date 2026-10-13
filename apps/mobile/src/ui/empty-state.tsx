import type { ReactNode } from "react";
import { View } from "react-native";
import { makeStyles, radius, useTheme } from "../theme";
import { Icon, type IconName } from "./icon";
import { AppText } from "./text";

const useStyles = makeStyles((theme) => ({
  wrap: { alignItems: "center", gap: 8, paddingHorizontal: 28, paddingVertical: 36 },
  tile: {
    alignItems: "center",
    backgroundColor: theme.card,
    borderRadius: radius.card + 6,
    height: 76,
    justifyContent: "center",
    marginBottom: 8,
    width: 76,
  },
  center: { textAlign: "center" },
  actions: { alignSelf: "stretch", gap: 12, marginTop: 14 },
}));

// A centered icon, title, and explanation for a screen or section with
// nothing to show, with optional actions below.
export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon: IconName;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      <View style={styles.tile}>
        <Icon name={icon} size={38} color={theme.accent} />
      </View>
      <AppText variant="title3" weight="700" style={styles.center}>
        {title}
      </AppText>
      {body === undefined ? null : (
        <AppText variant="subhead" tone="secondary" style={styles.center}>
          {body}
        </AppText>
      )}
      {children === undefined ? null : <View style={styles.actions}>{children}</View>}
    </View>
  );
}
