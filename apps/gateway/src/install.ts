import script from "../../../packages/installer/install.sh";
import type { Env } from "./env.js";

// component-gateway §Routes: `GET /install.sh` serves `component-installer`'s
// script, bundled at build time by the Text module rule in wrangler.toml, so
// the installer's file stays the only copy. The script names its server
// through one placeholder, which becomes this deployment's origin.

export const ORIGIN_PLACEHOLDER = "__AGENTDESK_PUBLIC_ORIGIN__";

export function installScript(origin: string): string {
  const trimmed = origin.replace(/\/+$/, "");
  // A function replacement, so `$` in the origin is never a pattern.
  return script.replaceAll(ORIGIN_PLACEHOLDER, () => trimmed);
}

export function serveInstallScript(_request: Request, env: Env): Response {
  return new Response(installScript(env.PUBLIC_ORIGIN), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
