import { renderRouter } from "expo-router/testing-library";
import { StrictMode } from "react";

// Renders the real route tree in apps/mobile/app at a starting URL. Strict
// mode runs each effect twice on mount, as development builds do.
export function renderApp(initialUrl: string, { strict = false } = {}) {
  return renderRouter("./app", { initialUrl, ...(strict ? { wrapper: StrictMode } : {}) });
}
