import type { AgentSession } from "@agentdesk/contract";
import { Pressable, View } from "react-native";
import type { NotificationRule } from "../../../../convex/notifications/rules";
import { makeStyles, useTheme } from "../theme";
import { Icon } from "../ui/icon";
import { AppText } from "../ui/text";
import { ACTION_LOOK, ruleWhat, ruleWhere } from "./format";

const useStyles = makeStyles((theme) => ({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  tile: { alignItems: "center", borderRadius: 8, height: 30, justifyContent: "center", width: 30 },
  text: { flex: 1, gap: 2 },
}));

// One rule in the rules list (prototype frame "Rules"): its action's icon
// tile, where it applies in bold, and "event → action" below. The row opens
// the rule's editor.
export function RuleRow({
  rule,
  agents,
  accessibilityLabel,
  onPress,
}: {
  rule: NotificationRule;
  agents: AgentSession[];
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const look = ACTION_LOOK[rule.action];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.tile, { backgroundColor: look.color }]}>
        <Icon name={look.icon} size={18} color="#ffffff" />
      </View>
      <View style={styles.text}>
        <AppText weight="600" numberOfLines={1}>
          {ruleWhere(rule, agents)}
        </AppText>
        <AppText variant="footnote" tone="secondary">
          {ruleWhat(rule)}
        </AppText>
      </View>
      <Icon name="chevron-forward" size={17} color={theme.textTertiary} />
    </Pressable>
  );
}
