import { useAuth } from "@clerk/expo";
import { Stack } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../../src/button";
import { styles } from "../../../src/styles";

// Account settings. Signing out ends the Clerk session, and the (app) layout
// returns to sign-in. Phase 2 slice 5 adds device unregistration before the
// sign-out (component-mobile-app §Notifications).
export default function AccountScreen() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignOut = () => {
    setBusy(true);
    setError(null);
    signOut().catch(() => {
      setError("Could not sign out. Try again.");
      setBusy(false);
    });
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Account" }} />
      {error !== null && <Text style={styles.error}>{error}</Text>}
      <Button label="Sign out" onPress={onSignOut} disabled={busy} />
    </View>
  );
}
