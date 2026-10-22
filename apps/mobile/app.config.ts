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
  version: "1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  // The Prompt bubble mark on the Indigo Ink gradient. iOS masks the square
  // icon itself and uses the dark and tinted variants for those Home Screen
  // appearances (Apple HIG App icons); Android draws the white mark over the
  // adaptive background and uses the white-on-transparent monochrome layer
  // for themed icons (DEC-17(5)).
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "sh.kidus.agentdesk",
    // The app uses only the encryption iOS provides (HTTPS and the Keychain),
    // which is exempt from export documentation, so App Store Connect asks no
    // encryption question per build.
    config: { usesNonExemptEncryption: false },
    // An urgent decision's push asks for the time-sensitive interruption level
    // (component-notifications §Push sound), which iOS honors only with this
    // entitlement, so it can break through Focus. The App ID needs the Time
    // Sensitive Notifications capability before a build can sign with it.
    entitlements: { "com.apple.developer.usernotifications.time-sensitive": true },
    icon: {
      light: "./assets/icon.png",
      dark: "./assets/icon-dark.png",
      tinted: "./assets/icon-tinted.png",
    },
  },
  android: {
    package: "sh.kidus.agentdesk",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      monochromeImage: "./assets/adaptive-icon-monochrome.png",
      backgroundColor: "#4f46e5",
    },
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  // expo-notifications adds the push entitlement and names the Android
  // channel the app creates at startup (component-mobile-app §Notifications).
  // @clerk/expo raises the iOS deployment target to 17.0, which its native
  // module requires, in Podfile.properties.json and the Xcode project. The app
  // signs in by email code only, so it adds no Sign in with Apple entitlement.
  plugins: [
    "expo-router",
    // The app never uses Face ID, so the plugin's default Face ID purpose
    // string is removed (App Review 5.1.1(ii): purpose strings must describe
    // real use).
    ["expo-secure-store", { faceIDPermission: false }],
    ["expo-notifications", { defaultChannel: "default" }],
    ["@clerk/expo", { appleSignIn: false }],
    "@react-native-community/datetimepicker",
  ],
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
};

export default config;
