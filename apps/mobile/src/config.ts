// The app's public client configuration (component-repository §Configuration).
// Expo inlines an EXPO_PUBLIC_ variable into the bundle only where the code
// reads it as a static `process.env.NAME` access, so each one is read by name.

export type AppConfig = {
  convexUrl: string;
  clerkPublishableKey: string;
};

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; missing: string[] };

type PublicEnv = {
  EXPO_PUBLIC_CONVEX_URL: string | undefined;
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: string | undefined;
};

// Validates the configuration before any provider or client is built. A
// blank value counts as missing.
export function readConfig(
  env: PublicEnv = {
    EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
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
  return missing.length > 0
    ? { ok: false, missing }
    : { ok: true, config: { convexUrl, clerkPublishableKey } };
}
