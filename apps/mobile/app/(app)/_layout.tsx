import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import { AccountGate } from "../../src/account-bootstrap";
import { Loading } from "../../src/loading";
import { NotificationSession } from "../../src/notifications";
import { SettingsLinks } from "../../src/settings-links";

// Signed-in routes. A signed-out person is sent to sign-in. AccountGate mounts
// the routes only after the account exists, so no route below issues a Convex
// call first. NotificationSession starts device registration and opens a
// tapped notification's screen once the account is ready. Each route sets its
// own title, and the stack registers new route files without an edit here.
export default function AppLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return <Loading label="Loading" headerless />;
  }
  if (!isSignedIn) {
    return <Redirect href="/sign-in" />;
  }
  return (
    <AccountGate>
      <NotificationSession />
      <Stack>
        <Stack.Screen name="index" options={{ title: "Inbox", headerRight: SettingsLinks }} />
      </Stack>
    </AccountGate>
  );
}
