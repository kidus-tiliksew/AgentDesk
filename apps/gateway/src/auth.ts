import { z } from "zod";
import { type ServiceCall, ServiceError } from "./convex.js";
import type { Env } from "./env.js";

// component-gateway §Authentication. Connection tokens (`adc_`) are accepted
// on `/mcp`, `/device/connection`, and `/device/wait`, and API tokens (`adp_`)
// on `/v1`, and on `/device/connection` only when a Mac sign-in minted them;
// Clerk OAuth access tokens arrive with the discovery documents.
// Every request resolves its credential again and nothing is cached, so a
// revoked credential is refused on its next call (DEC-6;
// req-accounts-and-connections AC-4.2; req-public-api-and-webhooks AC-3.2).

// The credential kinds the gateway accepts, each with its bearer form.
const TOKEN_FORMS = {
  connection_token: /^adc_[A-Za-z0-9_-]{1,200}$/,
  api_token: /^adp_[A-Za-z0-9_-]{1,200}$/,
} as const;

export type TokenKind = keyof typeof TOKEN_FORMS;

const resolvedSchema = z.object({
  userId: z.string().min(1),
  credentialId: z.string().min(1),
  kind: z.string(),
  // The harness a connection token was minted for, or `macos` for a Mac's API
  // token. Only `/device/connection` reads it, so `/mcp` and `/v1` do not
  // depend on it.
  harness: z.string().optional(),
});

export interface Caller {
  userId: string;
  credentialId: string;
  harness?: string;
}

// Returns the lowercase SHA-256 hex digest of a presented token, encoded the
// same way as `hashToken` in convex/identity/tokens.ts.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Resolves the request's bearer credential of `kind`, a connection token
// unless named, or returns null when it is missing, malformed, of another
// kind, or refused by identity as `unauthenticated`. A token whose resolved
// kind does not match its prefix is refused. Any other failure, an outage or
// another service error code, propagates, so it is never mistaken for a bad
// credential.
export async function authenticate(
  request: Request,
  svc: ServiceCall,
  kind: TokenKind = "connection_token",
): Promise<Caller | null> {
  const token = bearerToken(request, kind);
  if (token === null) {
    return null;
  }
  let resolved: unknown;
  try {
    resolved = await svc("identity/resolve-token", { token_hash: await hashToken(token) });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "unauthenticated") {
      return null;
    }
    throw error;
  }
  const credential = resolvedSchema.safeParse(resolved);
  if (!credential.success || credential.data.kind !== kind) {
    return null;
  }
  const { userId, credentialId, harness } = credential.data;
  return harness === undefined ? { userId, credentialId } : { userId, credentialId, harness };
}

// Returns the request's bearer value when it has the form of `kind`, and null
// otherwise.
export function bearerToken(request: Request, kind: TokenKind): string | null {
  const match = /^Bearer +(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  const token = match?.[1];
  return token !== undefined && TOKEN_FORMS[kind].test(token) ? token : null;
}

// The 401 a compliant MCP client answers by starting browser sign-in
// (req-agent-tools AC-1.1). The metadata document it names is not served yet.
export function unauthorized(env: Pick<Env, "PUBLIC_ORIGIN">): Response {
  const origin = env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  return Response.json(
    { error: { code: "unauthenticated", message: "Missing or invalid credential" } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}
