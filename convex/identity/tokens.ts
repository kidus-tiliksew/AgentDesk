// component-identity §Credentials: a token is 32 random bytes in base64url
// with the `adc_` prefix for a connection token or `adp_` for an API token,
// and only its SHA-256 hex digest is stored (DEC-6). An install key's secret
// is minted the same way with the `adk_` prefix (§Install keys). These helpers use Web Crypto alone, because the default Convex
// runtime has no Node crypto, and import nothing from Convex, so the gateway
// can hash a presented token the same way.

export const CONNECTION_TOKEN_PREFIX = "adc_";
export const API_TOKEN_PREFIX = "adp_";
export const INSTALL_KEY_PREFIX = "adk_";
const TOKEN_BYTES = 32;

// Returns the lowercase SHA-256 hex digest of a presented token.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Mints a token with `prefix`, a connection token by default. The caller
// stores `hash` and hands `plaintext` to the client once.
export async function mintToken(
  prefix:
    | typeof CONNECTION_TOKEN_PREFIX
    | typeof API_TOKEN_PREFIX
    | typeof INSTALL_KEY_PREFIX = CONNECTION_TOKEN_PREFIX,
): Promise<{ plaintext: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const plaintext = prefix + base64url(bytes);
  return { plaintext, hash: await hashToken(plaintext) };
}

function base64url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
