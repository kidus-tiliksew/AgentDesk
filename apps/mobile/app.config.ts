import type { ExpoConfig } from "expo/config";

// EAS_PROJECT_ID links the app to its EAS project. It is unset until the
// operator links the project, and local tests and Metro bundling need none.
const projectId = process.env.EAS_PROJECT_ID?.trim();
// GOOGLE_SERVICES_JSON is the path to the Firebase google-services.json that
// Android needs for FCM push, set by the operator as an EAS file environment
// variable. Builds without it run, and Android push setup reports a token
// failure (component-mobile-app §Notifications).
const googleServicesFile = process.env.GOOGLE_SERVICES_JSON?.trim();

const config: ExpoConfig = {
  name: "AgentDesk",
  slug: "agentdesk",
  scheme: "agentdesk",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: { bundleIdentifier: "sh.kidus.agentdesk" },
  android: {
    package: "sh.kidus.agentdesk",
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  // expo-notifications adds the push entitlement and names the Android
  // channel the app creates at startup (component-mobile-app §Notifications).
  // @clerk/expo raises the iOS deployment target to 17.0, which its native
  // module requires, in Podfile.properties.json and the Xcode project. The app
  // signs in by email code only, so it adds no Sign in with Apple entitlement.
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "default" }],
    ["@clerk/expo", { appleSignIn: false }],
  ],
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
};

export default config;
