// component-identity §Short-code sign-in: the clients that sign in by short
// code with one API token instead of the installer's harness list
// (req-mac-app REQ-2). The Mac client is not a harness, so
// convex/identity/harnesses.ts never names it. This module imports nothing
// from Convex, so the gateway can import it.

export const MAC_CLIENT = "macos";
export const MAC_CLIENT_NAME = "AgentDesk for Mac";

export type ClientId = typeof MAC_CLIENT;

// True only for the API token a Mac sign-in minted. Every other API token
// stays out of the connection functions, revoke-self, and
// `/device/connection`.
export function isMacCredential(credential: { kind: string; harness?: string }): boolean {
  return credential.kind === "api_token" && credential.harness === MAC_CLIENT;
}
