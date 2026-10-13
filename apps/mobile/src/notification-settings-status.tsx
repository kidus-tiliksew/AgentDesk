import { Linking, View } from "react-native";
import { Button } from "./button";
import { type SetupFailure, useRegistrationStatus } from "./notifications";
import { makeStyles, useTheme } from "./theme";
import { Icon, type IconName } from "./ui/icon";
import { AppText } from "./ui/text";

// The top of the notification settings: whether this device gets pushes
// (prototype frame "Notification settings"). It reads the device
// registration that NotificationSession runs (component-mobile-app
// §Notifications) and starts nothing itself. A denied permission links to
// the system settings, where only the person can allow it again; a failed
// setup offers another attempt.

const SETUP_FAILURES: Record<SetupFailure, string> = {
  unsupported: "Notifications need a physical iPhone or Android phone.",
  project: "Notifications are not configured for this build.",
  storage: "Could not read this device's id for notifications.",
  token: "Could not get a push token for this device.",
  register: "Could not register this device for notifications.",
};

const useStyles = makeStyles((theme) => ({
  group: {
    backgroundColor: theme.card,
    borderRadius: 12,
    gap: 10,
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  row: { alignItems: "center", flexDirection: "row", gap: 12 },
  text: { flex: 1, gap: 2 },
}));

export function PushStatus() {
  const styles = useStyles();
  const theme = useTheme();
  const { status, retry } = useRegistrationStatus();

  let icon: IconName;
  let color: string;
  let title: string;
  let detail: string;
  let action: { label: string; onPress: () => void } | null = null;
  switch (status.kind) {
    case "off":
      return null;
    case "setting-up":
      icon = "time-outline";
      color = theme.grey;
      title = "Setting up push for this device";
      detail = "This takes a moment.";
      break;
    case "registered":
      icon = "checkmark-circle";
      color = theme.green;
      title = "Push is on for this device";
      detail = "Decisions and agent alerts arrive here as your rules say.";
      break;
    case "denied":
      icon = "notifications-off";
      color = theme.red;
      title = "Push is off for this device";
      detail = "Allow notifications in system settings to get pushes.";
      action = { label: "Open Settings", onPress: () => void Linking.openSettings() };
      break;
    case "not-asked":
      // The person chose Not now on the push explanation. Turning push on
      // here is their explicit request, so it goes straight to the system
      // prompt.
      icon = "notifications-outline";
      color = theme.textSecondary;
      title = "Push is off for this device";
      detail = "Turn on push to get decisions and agent alerts on this phone.";
      action = { label: "Turn on push", onPress: retry };
      break;
    case "failed":
      icon = "warning";
      color = theme.amber;
      title = "Push is not set up";
      detail = SETUP_FAILURES[status.reason];
      action = { label: "Set up push again", onPress: retry };
      break;
  }

  return (
    <View style={styles.group}>
      <View style={styles.row}>
        <Icon name={icon} size={24} color={color} />
        <View style={styles.text}>
          <AppText>{title}</AppText>
          <AppText variant="footnote" tone="secondary">
            {detail}
          </AppText>
        </View>
      </View>
      {action === null ? null : (
        <Button label={action.label} variant="tinted" size="small" onPress={action.onPress} />
      )}
    </View>
  );
}
