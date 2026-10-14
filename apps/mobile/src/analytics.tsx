import { useSegments } from "expo-router";
import { PostHogProvider, usePostHog } from "posthog-react-native";
import { type ReactNode, useEffect } from "react";
import type { AnalyticsConfig } from "./config";

// Anonymous product analytics through PostHog. Events carry no account: the
// app never calls `identify`, person profiles are off, and PostHog derives no
// location from the request's IP address. Autocapture is limited to app
// lifecycle events (installed, updated, opened, backgrounded); touches are not
// captured because their element text would carry decision content, and
// screens are recorded below by route pattern. Session replay, surveys, and
// feature flag requests are off. Without a project token the app mounts no
// PostHog client and sends nothing.
export function AnalyticsProvider({
  config,
  children,
}: {
  config: AnalyticsConfig | null;
  children: ReactNode;
}) {
  if (config === null) {
    return children;
  }
  return (
    <PostHogProvider
      apiKey={config.apiKey}
      autocapture={{ captureScreens: false, captureTouches: false }}
      options={{
        host: config.host,
        personProfiles: "never",
        disableGeoip: true,
        captureAppLifecycleEvents: true,
        enableSessionReplay: false,
        disableSurveys: true,
        preloadFeatureFlags: false,
      }}
    >
      <ScreenViews />
      {children}
    </PostHogProvider>
  );
}

// Records a screen view each time the route changes.
function ScreenViews() {
  const posthog = usePostHog();
  const name = screenName(useSegments());
  useEffect(() => {
    posthog.screen(name);
  }, [posthog, name]);
  return null;
}

// The route pattern of the current screen, without its layout groups:
// "/agent/[id]" rather than the agent's id, so no account data leaves the
// device in a screen name.
export function screenName(segments: readonly string[]): string {
  const visible = segments.filter((segment) => !/^\(.*\)$/.test(segment));
  return `/${visible.join("/")}`;
}
