import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { Button } from "../button";
import { haptic } from "../haptics";
import { makeStyles, radius, spacing, useTheme } from "../theme";
import { Card } from "../ui/card";
import { Icon } from "../ui/icon";
import { AppText } from "../ui/text";

// The new key's secret, shown once after creation (component-mobile-app
// §Install keys; req-install-keys AC-1.1). The screen holds the secret in
// component state and passes it here; this card never stores, logs, or
// reports it. Copy puts it on the clipboard only when the person presses
// Copy.

export const SECRET_WARNING =
  "Copy this key now and store it in your sandbox provider's secret store. It can't be shown again.";
export const COPY_FAILURE = "Could not copy the key. Select it and copy it instead.";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

const useStyles = makeStyles((theme) => ({
  card: { gap: 12, marginHorizontal: spacing.screen, marginTop: 18, padding: 16 },
  heading: { alignItems: "center", flexDirection: "row", gap: 8 },
  secret: {
    backgroundColor: theme.fill,
    borderRadius: radius.small,
    fontFamily: mono,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actions: { flexDirection: "row", gap: 10 },
}));

export function SecretCard({
  label,
  secret,
  onDone,
}: {
  label: string;
  secret: string;
  onDone: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    setFailed(false);
    try {
      await Clipboard.setStringAsync(secret);
      setCopied(true);
      haptic.success();
      AccessibilityInfo.announceForAccessibility("Install key copied");
    } catch {
      setFailed(true);
      haptic.error();
      AccessibilityInfo.announceForAccessibility(COPY_FAILURE);
    }
  };

  return (
    <Card style={styles.card}>
      <View style={styles.heading}>
        <Icon name="key" size={20} color={theme.accent} />
        <AppText variant="headline" accessibilityRole="header">
          {`${label} created`}
        </AppText>
      </View>
      <AppText variant="subhead" tone="amber">
        {SECRET_WARNING}
      </AppText>
      <AppText selectable accessibilityLabel="Install key secret" style={styles.secret}>
        {secret}
      </AppText>
      {failed ? (
        <AppText variant="footnote" tone="red">
          {COPY_FAILURE}
        </AppText>
      ) : null}
      <View style={styles.actions}>
        <Button
          label={copied ? "Copied" : "Copy"}
          icon={copied ? "checkmark" : "copy-outline"}
          variant="tinted"
          grow
          onPress={() => void copy()}
        />
        <Button label="Done" variant="secondary" grow onPress={onDone} />
      </View>
    </Card>
  );
}
