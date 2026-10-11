import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { type ReactNode, useMemo } from "react";
import type { AppConfig } from "./config";

// component-mobile-app §Stack: ClerkProvider, with expo-secure-store as its
// token cache, wraps ConvexProviderWithClerk, so every query and mutation
// carries the person's Clerk session.
export function Providers({ config, children }: { config: AppConfig; children: ReactNode }) {
  // A native app has no page unload to warn about.
  const convex = useMemo(
    () => new ConvexReactClient(config.convexUrl, { unsavedChangesWarning: false }),
    [config.convexUrl],
  );
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
