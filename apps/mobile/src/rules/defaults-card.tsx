import { Fragment } from "react";
import { View } from "react-native";
import { makeStyles } from "../theme";
import { Card } from "../ui/card";
import { AppText, type TextTone } from "../ui/text";
import { actionLabel, DEFAULT_ROUTING, eventKindLabel, type RuleAction } from "./format";

const useStyles = makeStyles((theme) => ({
  card: { gap: 0, paddingVertical: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 9 },
  separator: { backgroundColor: theme.separator, height: 0.5 },
  label: { paddingBottom: 7, paddingHorizontal: 32, paddingTop: 22 },
}));

// Push reads red and the digest amber, as the actions' tiles do. Mute reads
// in the secondary text color: the tiles' grey is under 4.5:1 as text (Apple
// HIG Accessibility: color contrast). The words carry the action either way.
const ACTION_TONE: Record<RuleAction, TextTone> = {
  push: "red",
  digest: "amber",
  mute: "secondary",
};

// What each event kind does when no rule matches it (req-notification-rules
// REQ-4), as a two-column table (prototype frame "Rules").
export function DefaultsCard() {
  const styles = useStyles();
  return (
    <View>
      <AppText
        accessibilityRole="header"
        variant="footnote"
        tone="secondary"
        style={[styles.label, { textTransform: "uppercase" }]}
      >
        Without a rule
      </AppText>
      <Card style={styles.card}>
        {DEFAULT_ROUTING.map(({ kind, action }, index) => (
          <Fragment key={kind}>
            {index === 0 ? null : <View style={styles.separator} />}
            <View
              accessible
              accessibilityLabel={`${eventKindLabel(kind)}: ${actionLabel(action)}`}
              style={styles.row}
            >
              <AppText variant="subhead">{eventKindLabel(kind)}</AppText>
              <AppText variant="subhead" weight="600" tone={ACTION_TONE[action]}>
                {actionLabel(action)}
              </AppText>
            </View>
          </Fragment>
        ))}
      </Card>
    </View>
  );
}
