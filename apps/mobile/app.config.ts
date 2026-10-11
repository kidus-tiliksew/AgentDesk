import type { ExpoConfig } from "expo/config";

// EAS_PROJECT_ID links the app to its EAS project. It is unset until the
// operator links the project, and local tests and Metro bundling need none.
const projectId = process.env.EAS_PROJECT_ID?.trim();

const config: ExpoConfig = {
  name: "AgentDesk",
  slug: "agentdesk",
  scheme: "agentdesk",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: { bundleIdentifier: "sh.kidus.agentdesk" },
  android: { package: "sh.kidus.agentdesk" },
  plugins: ["expo-router", "expo-secure-store"],
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
};

export default config;
