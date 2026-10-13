import { useAuth } from "@clerk/expo";
import * as Device from "expo-device";
import { Stack } from "expo-router";
import { useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { confirmDestructive } from "../../../../src/confirm";
import {
  type RegistrationStatus,
  type SetupFailure,
  useRegistrationStatus,
  useSignOutDevice,
} from "../../../../src/notifications";
import { makeStyles, useTheme } from "../../../../src/theme";
import { GroupedRow, GroupedSection } from "../../../../src/ui/grouped";
import { Icon } from "../../../../src/ui/icon";
import { StackScreen } from "../../../../src/ui/screen";
import { AppText } from "../../../../src/ui/text";

// Account settings: who is signed in, this device's push status, and
// sign-out. Apple HIG Managing accounts and Action sheets: sign-out first asks
// for confirmation in an action sheet, as it ends the session and this
// device's notifications. It then unregisters this device and ends the exact
// Clerk session, and the (app) layout returns to sign-in (component-mobile-app
// §Notifications, req-mobile-app AC-4.2). When the unregistration fails, the
// session stays signed in and the row offers another attempt, so the device
// never keeps receiving pushes after a sign-out that looked complete.

const UNREGISTER_FAILED =
  "Could not stop notifications on this device. Check your connection and try again.";
const SIGN_OUT_FAILED = "Could not sign out. Try again.";
const DENIED =
  "Notifications are off for this device. Allow them in system settings to get pushes.";
const NOT_ASKED = "You chose not to get notifications on this device.";

const SETUP_FAILURES: Record<SetupFailure, string> = {
  unsupported: "Notifications need a physical iPhone or Android phone.",
  project: "Notifications are not configured for this build.",
  storage: "Could not read this device's id for notifications.",
  token: "Could not get a push token for this device.",
  register: "Could not register this device for notifications.",
};

const PUSH_STATE: Record<RegistrationStatus["kind"], string> = {
  off: "Push off",
  "setting-up": "Setting up",
  registered: "Push on",
  denied: "Push off",
  "not-asked": "Push off",
  failed: "Push not set up",
};

const useStyles = makeStyles((theme) => ({
  identity: { alignItems: "center", gap: 10, paddingBottom: 8, paddingTop: 18 },
  avatar: {
    alignItems: "center",
    backgroundColor: theme.scheme === "dark" ? theme.cardRaised : theme.fill,
    borderRadius: 36,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  error: { paddingHorizontal: 32, paddingTop: 7 },
}));

// This device and its push status. A setup failure names its cause and
// offers another attempt; a denial points to system settings; a Not now on
// the push explanation offers to turn push on, which goes straight to the
// system prompt.
function ThisDevice({ status, retry }: { status: RegistrationStatus; retry: () => void }) {
  const subtitle =
    status.kind === "denied"
      ? DENIED
      : status.kind === "not-asked"
        ? NOT_ASKED
        : status.kind === "failed"
          ? SETUP_FAILURES[status.reason]
          : undefined;
  const name = Device.deviceName ?? Device.modelName ?? "This device";
  // VoiceOver reads the row as one element: the device, its push status, and
  // the reason when push is off or failed.
  const label = [name, PUSH_STATE[status.kind], subtitle].filter(Boolean).join(", ");
  return (
    <GroupedSection title="This device">
      <GroupedRow
        title={name}
        subtitle={subtitle}
        value={PUSH_STATE[status.kind]}
        accessibilityLabel={label}
      />
      {status.kind === "failed" ? (
        <GroupedRow title="Try notifications again" tone="accent" onPress={retry} />
      ) : null}
      {status.kind === "not-asked" ? (
        <GroupedRow title="Turn on notifications" tone="accent" onPress={retry} />
      ) : null}
    </GroupedSection>
  );
}

export default function AccountScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const { sessionId, signOut } = useAuth();
  const signOutDevice = useSignOutDevice();
  const { status, retry } = useRegistrationStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (message: string) => {
    setError(message);
    setBusy(false);
    AccessibilityInfo.announceForAccessibility(message);
  };

  const onSignOut = async () => {
    if (!sessionId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signOutDevice(sessionId);
    } catch {
      fail(UNREGISTER_FAILED);
      return;
    }
    try {
      await signOut({ sessionId });
    } catch {
      fail(SIGN_OUT_FAILED);
    }
  };

  const confirmSignOut = () =>
    confirmDestructive({
      title: "Sign out of AgentDesk?",
      message: "This device stops getting notifications until you sign in again.",
      action: "Sign Out",
      onConfirm: () => void onSignOut(),
    });

  return (
    <>
      <Stack.Screen options={{ title: "Account" }} />
      <StackScreen>
        {/* The signed-in email is not available to this screen yet, so the
            identity block names only how the person signed in. */}
        <View style={styles.identity}>
          <View style={styles.avatar}>
            <Icon name="person" size={36} color={theme.textSecondary} />
          </View>
          <AppText variant="subhead" tone="secondary">
            Signed in with an email code
          </AppText>
        </View>
        <ThisDevice status={status} retry={retry} />
        <GroupedSection>
          <GroupedRow
            title="Sign out"
            tone="destructive"
            onPress={confirmSignOut}
            disabled={busy}
          />
        </GroupedSection>
        {error === null ? null : (
          <AppText variant="footnote" tone="red" style={styles.error}>
            {error}
          </AppText>
        )}
      </StackScreen>
    </>
  );
}
