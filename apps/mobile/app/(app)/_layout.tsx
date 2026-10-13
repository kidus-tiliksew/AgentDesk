import { useAuth } from "@clerk/expo";
import { Redirect, Slot } from "expo-router";
import { AccountGate } from "../../src/account-bootstrap";
import { Loading } from "../../src/loading";
import { NotificationSession } from "../../src/notifications";

// Signed-in routes. A signed-out person is sent to sign-in. AccountGate mounts
// the routes only after the account exists, so no route below issues a Convex
// call first. NotificationSession starts device registration and opens a
// tapped notification's screen once the account is ready. Every signed-in
// route lives in the (tabs) group: Inbox, History, and Settings each push
// their screens on their own stack, so the tab bar stays on screen.
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
      <Slot />
    </AccountGate>
  );
}
