import { screen, waitFor } from "expo-router/testing-library";
import { screenName } from "../src/analytics";
import { DEFAULT_POSTHOG_HOST, readConfig } from "../src/config";
import { agent } from "./data";
import { analytics, setQuery, signInAs } from "./fakes";
import { findInbox, renderApp } from "./render";

const env = {
  EXPO_PUBLIC_CONVEX_URL: "https://test.convex.cloud",
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
};

describe("analytics configuration", () => {
  test("is off without a PostHog project token", () => {
    const result = readConfig({ ...env, EXPO_PUBLIC_POSTHOG_KEY: "  " });

    expect(result).toEqual({
      ok: true,
      config: {
        convexUrl: env.EXPO_PUBLIC_CONVEX_URL,
        clerkPublishableKey: env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
        analytics: null,
      },
    });
  });

  test("uses the US cloud host unless one is set", () => {
    const token = { ...env, EXPO_PUBLIC_POSTHOG_KEY: "phc_test" };

    expect(readConfig(token)).toMatchObject({
      config: { analytics: { apiKey: "phc_test", host: DEFAULT_POSTHOG_HOST } },
    });
    expect(
      readConfig({ ...token, EXPO_PUBLIC_POSTHOG_HOST: " https://eu.i.posthog.com " }),
    ).toMatchObject({ config: { analytics: { host: "https://eu.i.posthog.com" } } });
  });
});

describe("analytics", () => {
  test("mounts no PostHog client and records nothing without a token", async () => {
    renderApp("/");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(analytics.provider).toBeNull();
    expect(analytics.screen).not.toHaveBeenCalled();
  });

  test("starts PostHog anonymous, without location, replay, surveys, or touch capture", async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";

    renderApp("/");

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(analytics.provider).toMatchObject({
      apiKey: "phc_test",
      autocapture: { captureScreens: false, captureTouches: false },
      options: {
        host: DEFAULT_POSTHOG_HOST,
        personProfiles: "never",
        disableGeoip: true,
        captureAppLifecycleEvents: true,
        enableSessionReplay: false,
        disableSurveys: true,
        preloadFeatureFlags: false,
      },
    });
    expect(analytics.screen).toHaveBeenCalledWith("/sign-in");
  });

  test("names a screen by its route pattern, never by the id in its URL", async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
    setQuery("agents/app:get", {
      ...agent({ id: "a_secret" }),
      history: [],
      pending_decisions: [],
    });
    signInAs("sess_a");

    renderApp("/agent/a_secret");

    await waitFor(() => expect(analytics.screen).toHaveBeenCalledWith("/agent/[id]"));
    for (const [name] of analytics.screen.mock.calls) {
      expect(name).not.toContain("a_secret");
    }
  });

  test("records the inbox as the root screen", async () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
    signInAs("sess_a");

    renderApp("/");

    await findInbox();
    expect(analytics.screen).toHaveBeenLastCalledWith("/");
  });
});

describe("screenName", () => {
  test("drops layout groups and keeps dynamic segments as patterns", () => {
    expect(screenName([])).toBe("/");
    expect(screenName(["(auth)", "sign-in"])).toBe("/sign-in");
    expect(screenName(["(app)", "(tabs)", "(inbox,settled)", "agent", "[id]"])).toBe("/agent/[id]");
    expect(screenName(["(app)", "(tabs)", "settings", "rules"])).toBe("/settings/rules");
  });
});
