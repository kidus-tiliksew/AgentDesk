import { DarkTheme, DefaultTheme, Slot, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AccountDeletionProvider } from "../src/account-deletion";
import { AnalyticsProvider } from "../src/analytics";
import { readConfig } from "../src/config";
import { ConfigError } from "../src/config-error";
import { NotificationProvider } from "../src/notifications";
import { Providers } from "../src/providers";
import { type Theme, useTheme } from "../src/theme";

// The root layout validates the public configuration before it mounts Clerk or
// builds the Convex client. The (auth) and (app) group layouts below it hold
// the route guards, so a later route added under either group needs no edit
// here. NotificationProvider sits above both groups, so a notification tap
// that launched the app is held through sign-in and account setup.
// AccountDeletionProvider sits inside it for the same reason: an account
// deletion finishes its sign-out and hands its notice to sign-in after the
// (app) routes unmount. AnalyticsProvider wraps everything below the
// configuration check, so screen views cover sign-in as well as the app.
// React Navigation's stack headers and screen backgrounds take the app's
// colors for the current scheme: `primary` tints back buttons and header
// items, `card` fills a pushed screen's header, and `text` colors titles. A
// tab root's large-title header is translucent, and the native tab bar takes
// its tint from the tabs layout, so both keep the system material.
function navigationTheme(theme: Theme) {
  const base = theme.scheme === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.accent,
      background: theme.background,
      card: theme.tabBar,
      text: theme.text,
      border: theme.separator,
      notification: theme.red,
    },
  };
}

export default function RootLayout() {
  const theme = useTheme();
  const result = readConfig();
  if (!result.ok) {
    return <ConfigError missing={result.missing} />;
  }
  return (
    <ThemeProvider value={navigationTheme(theme)}>
      <AnalyticsProvider config={result.config.analytics}>
        <Providers config={result.config}>
          <NotificationProvider>
            <AccountDeletionProvider>
              <StatusBar style="auto" />
              <Slot />
            </AccountDeletionProvider>
          </NotificationProvider>
        </Providers>
      </AnalyticsProvider>
    </ThemeProvider>
  );
}
