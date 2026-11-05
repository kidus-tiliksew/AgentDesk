import { useAuth } from "@clerk/expo";
import { useSegments } from "expo-router";
import { type PostHog, PostHogProvider, usePostHog } from "posthog-react-native";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { AnalyticsConfig } from "./config";

// Product analytics through PostHog. A signed-in person is identified by their
// Clerk user ID, with their email as a person property. Events sent as an
// anonymous ID create no person and are not linked to one at a later sign-in,
// and PostHog derives no location from an event's IP address. One limit: the SDK
// captures its lifecycle events while it starts, before the app can know the
// session, so on a cold launch they can carry the earlier account's ID when that
// session ended while the app was closed. Autocapture is limited to app lifecycle
// events (installed, updated, opened, backgrounded); touches are not captured
// because their element text would carry decision content, and screens are
// recorded below by route pattern. Session replay and surveys are off, and
// feature flags are not preloaded at startup. Without a project token the app
// mounts no PostHog client and sends nothing.
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
        personProfiles: "identified_only",
        disableGeoip: true,
        captureAppLifecycleEvents: true,
        enableSessionReplay: false,
        disableSurveys: true,
        preloadFeatureFlags: false,
      }}
    >
      <ClientBoundary>{children}</ClientBoundary>
    </PostHogProvider>
  );
}

// usePostHog logs an error when no provider is mounted, so only this boundary
// inside the provider calls it. Everything else reads this context, which holds
// null when the app has no analytics key. It also holds the Clerk session the
// SDK was last identified for: AccountGate, below the routes, reports it, and
// ScreenViews, above them, waits for it.
const AnalyticsClient = createContext<PostHog | null>(null);
const IdentifiedSession = createContext<string | null>(null);
const MarkIdentified = createContext<(sessionId: string) => void>(() => undefined);

function ClientBoundary({ children }: { children: ReactNode }) {
  const posthog = usePostHog();
  const [identifiedSession, markIdentified] = useState<string | null>(null);
  return (
    <AnalyticsClient.Provider value={posthog}>
      <MarkIdentified.Provider value={markIdentified}>
        <IdentifiedSession.Provider value={identifiedSession}>
          {children}
        </IdentifiedSession.Provider>
      </MarkIdentified.Provider>
    </AnalyticsClient.Provider>
  );
}

export function useAnalyticsClient() {
  return useContext(AnalyticsClient);
}

export function useMarkAnalyticsIdentified() {
  return useContext(MarkIdentified);
}

// The SDK's ID getters return an empty string until it has read its storage, so
// an identity comparison waits for ready(). Callers run in the order they asked.
// Analytics failures never reach the app's own flows.
function whenReady(client: PostHog, run: () => void) {
  client
    .ready()
    .then(run)
    .catch(() => undefined);
}

// Attaches the device's usage to the account `ensureAccount` returned. A
// different distinct ID, including the anonymous one from before sign-in, is
// reset first, so identify links only the new empty anonymous ID and the
// earlier events stay unlinked. A matching one only calls identify, which
// carries a changed email to the person. `isCurrent` is asked once the SDK is
// ready, so a session that ended during the wait identifies nobody.
// `onIdentified` runs once identify has been called, and only then.
export function identifyAnalytics(
  client: PostHog | null,
  account: { clerkUserId: string; email: string },
  isCurrent: () => boolean,
  onIdentified: () => void,
) {
  if (client === null) {
    return;
  }
  whenReady(client, () => {
    if (!isCurrent()) {
      return;
    }
    if (client.getDistinctId() !== account.clerkUserId) {
      client.reset();
    }
    client.identify(account.clerkUserId, { email: account.email });
    onIdentified();
  });
}

// Mounted inside the Clerk provider and above the route groups, so a sign-out
// does not unmount it. Does nothing without an analytics key. The first sibling's
// effects run first, so a screen view in the same commit waits behind the cleanup.
export function AnalyticsSignOut() {
  const posthog = useAnalyticsClient();
  if (posthog === null) {
    return null;
  }
  return (
    <>
      <ClearIdentity posthog={posthog} />
      <ScreenViews posthog={posthog} />
    </>
  );
}

// Clears the identity once Clerk has loaded with no session: a sign-out, an
// account deletion, or a session that ended while the app was closed. A distinct
// ID equal to the anonymous ID is already clear, so a repeat render resets
// nothing. A clear waiting for the SDK still runs if a session starts meanwhile:
// waiting callers run in order, so it comes before that session's identify, and
// the earlier account's ID does not stay on the device until the account is ready.
function ClearIdentity({ posthog }: { posthog: PostHog }) {
  const { isLoaded, sessionId } = useAuth();
  useEffect(() => {
    if (!isLoaded || sessionId) {
      return;
    }
    whenReady(posthog, () => {
      if (posthog.getDistinctId() !== posthog.getAnonymousId()) {
        posthog.reset();
      }
    });
  }, [posthog, isLoaded, sessionId]);
  return null;
}

// Records a screen view each time the route changes. It waits for Clerk, so a
// signed-out screen never carries the account that was on the device, and it
// waits for a session's identify, so a signed-in screen carries that session's
// account and never an earlier account or an unlinked anonymous ID. A session
// whose account never becomes ready records no screen.
function ScreenViews({ posthog }: { posthog: PostHog }) {
  const { isLoaded, sessionId } = useAuth();
  const identifiedSession = useContext(IdentifiedSession);
  const name = screenName(useSegments());
  const settled = isLoaded && (!sessionId || identifiedSession === sessionId);
  useEffect(() => {
    if (!settled) {
      return;
    }
    let current = true;
    whenReady(posthog, () => {
      if (current) {
        posthog.screen(name);
      }
    });
    return () => {
      current = false;
    };
  }, [posthog, settled, name]);
  return null;
}

// The route pattern of the current screen, without its layout groups:
// "/agent/[id]" rather than the agent's id, so no account data leaves the
// device in a screen name.
export function screenName(segments: readonly string[]): string {
  const visible = segments.filter((segment) => !/^\(.*\)$/.test(segment));
  return `/${visible.join("/")}`;
}
