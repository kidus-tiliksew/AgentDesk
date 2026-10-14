// The app's public client configuration (component-repository §Configuration).
// Expo inlines an EXPO_PUBLIC_ variable into the bundle only where the code
// reads it as a static `process.env.NAME` access, so each one is read by name.

export type AppConfig = {
  convexUrl: string;
  clerkPublishableKey: string;
  // PostHog product analytics, or null when no project token is set, which
  // turns analytics off.
  analytics: AnalyticsConfig | null;
};

export type AnalyticsConfig = {
  apiKey: string;
  host: string;
};

// PostHog's US cloud ingestion host, used when EXPO_PUBLIC_POSTHOG_HOST is unset.
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// The privacy policy the website publishes (req-mobile-app REQ-7). Settings
// and sign-in open it in an in-app browser sheet (component-mobile-app §Screens).
export const PRIVACY_POLICY_URL = "https://agentdesk.kidus.sh/privacy";

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; missing: string[] };

type PublicEnv = {
  EXPO_PUBLIC_CONVEX_URL: string | undefined;
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: string | undefined;
  EXPO_PUBLIC_POSTHOG_KEY?: string | undefined;
  EXPO_PUBLIC_POSTHOG_HOST?: string | undefined;
};

// Validates the configuration before any provider or client is built. A
// blank value counts as missing. The PostHog variables are optional: a
// missing or blank project token leaves analytics off.
export function readConfig(
  env: PublicEnv = {
    EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    EXPO_PUBLIC_POSTHOG_KEY: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST,
  },
): ConfigResult {
  const convexUrl = env.EXPO_PUBLIC_CONVEX_URL?.trim() ?? "";
  const clerkPublishableKey = env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? "";
  const missing: string[] = [];
  if (convexUrl === "") {
    missing.push("EXPO_PUBLIC_CONVEX_URL");
  }
  if (clerkPublishableKey === "") {
    missing.push("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
  }
  const posthogKey = env.EXPO_PUBLIC_POSTHOG_KEY?.trim() ?? "";
  const posthogHost = env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  const analytics = posthogKey === "" ? null : { apiKey: posthogKey, host: posthogHost };
  return missing.length > 0
    ? { ok: false, missing }
    : { ok: true, config: { convexUrl, clerkPublishableKey, analytics } };
}
