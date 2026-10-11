import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { readConfig } from "../src/config";
import { ConfigError } from "../src/config-error";
import { Providers } from "../src/providers";

// The root layout validates the public configuration before it mounts Clerk or
// builds the Convex client. The (auth) and (app) group layouts below it hold
// the route guards, so a later route added under either group needs no edit
// here.
export default function RootLayout() {
  const result = readConfig();
  if (!result.ok) {
    return <ConfigError missing={result.missing} />;
  }
  return (
    <Providers config={result.config}>
      <StatusBar style="auto" />
      <Slot />
    </Providers>
  );
}
