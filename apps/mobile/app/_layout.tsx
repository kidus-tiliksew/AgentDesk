import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { readConfig } from "../src/config";
import { ConfigError } from "../src/config-error";
import { NotificationProvider } from "../src/notifications";
import { Providers } from "../src/providers";

// The root layout validates the public configuration before it mounts Clerk or
// builds the Convex client. The (auth) and (app) group layouts below it hold
// the route guards, so a later route added under either group needs no edit
// here. NotificationProvider sits above both groups, so a notification tap
// that launched the app is held through sign-in and account setup.
export default function RootLayout() {
  const result = readConfig();
  if (!result.ok) {
    return <ConfigError missing={result.missing} />;
  }
  return (
    <Providers config={result.config}>
      <NotificationProvider>
        <StatusBar style="auto" />
        <Slot />
      </NotificationProvider>
    </Providers>
  );
}
