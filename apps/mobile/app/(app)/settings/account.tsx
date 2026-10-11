import { useAuth } from "@clerk/expo";
import { Stack } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../../src/button";
import {
  type RegistrationStatus,
  type SetupFailure,
  useRegistrationStatus,
  useSignOutDevice,
} from "../../../src/notifications";
import { styles } from "../../../src/styles";

// Account settings. Sign-out first unregisters this device, then ends the
// exact Clerk session, and the (app) layout returns to sign-in
// (component-mobile-app §Notifications, req-mobile-app AC-4.2). When the
// unregistration fails, the session stays signed in and the button offers
// another attempt, so the device never keeps receiving pushes after a
// sign-out that looked complete.

const UNREGISTER_FAILED =
  "Could not stop notifications on this device. Check your connection and try again.";
const SIGN_OUT_FAILED = "Could not sign out. Try again.";

const SETUP_FAILURES: Record<SetupFailure, string> = {
  unsupported: "Notifications need a physical iPhone or Android phone.",
  project: "Notifications are not configured for this build.",
  storage: "Could not read this device's id for notifications.",
  token: "Could not get a push token for this device.",
  register: "Could not register this device for notifications.",
};

function NotificationStatus({ status, retry }: { status: RegistrationStatus; retry: () => void }) {
  if (status.kind === "denied") {
    return (
      <Text style={styles.body}>
        Notifications are off for this device. Allow them in system settings to get pushes.
      </Text>
    );
  }
  if (status.kind === "failed") {
    return (
      <View>
        <Text style={styles.error}>{SETUP_FAILURES[status.reason]}</Text>
        <Button label="Try notifications again" onPress={retry} />
      </View>
    );
  }
  return null;
}

export default function AccountScreen() {
  const { sessionId, signOut } = useAuth();
  const signOutDevice = useSignOutDevice();
  const { status, retry } = useRegistrationStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignOut = async () => {
    if (!sessionId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signOutDevice(sessionId);
    } catch {
      setError(UNREGISTER_FAILED);
      setBusy(false);
      return;
    }
    try {
      await signOut({ sessionId });
    } catch {
      setError(SIGN_OUT_FAILED);
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Account" }} />
      <NotificationStatus status={status} retry={retry} />
      {error !== null && <Text style={styles.error}>{error}</Text>}
      <Button label="Sign out" onPress={() => void onSignOut()} disabled={busy} />
    </View>
  );
}
