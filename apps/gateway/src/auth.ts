import { z } from "zod";
import { type ServiceCall, ServiceError } from "./convex.js";
import type { Env } from "./env.js";

// component-gateway §Authentication. Only connection tokens are accepted on
// `/mcp` in this slice; Clerk OAuth access tokens arrive with the discovery
// documents. Every request resolves its credential again and nothing is
// cached, so a revoked connection is refused on its next call (DEC-6;
// req-accounts-and-connections AC-4.2).

const CONNECTION_TOKEN = /^adc_[A-Za-z0-9_-]{1,200}$/;

const resolvedSchema = z.object({
  userId: z.string().min(1),
  credentialId: z.string().min(1),
  kind: z.string(),
});

export interface Caller {
  userId: string;
  credentialId: string;
}

// Returns the lowercase SHA-256 hex digest of a presented token, encoded the
// same way as `hashToken` in convex/identity/tokens.ts.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Resolves the request's bearer credential, or returns null when it is
// missing, malformed, of another kind, or refused by identity. A Convex outage
// throws UpstreamError instead, so it is never mistaken for a bad credential.
export async function authenticate(request: Request, svc: ServiceCall): Promise<Caller | null> {
  const match = /^Bearer +(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  const token = match?.[1];
  if (token === undefined || !CONNECTION_TOKEN.test(token)) {
    return null;
  }
  let resolved: unknown;
  try {
    resolved = await svc("identity/resolve-token", { token_hash: await hashToken(token) });
  } catch (error) {
    if (error instanceof ServiceError) {
      return null;
    }
    throw error;
  }
  const credential = resolvedSchema.safeParse(resolved);
  if (!credential.success || credential.data.kind !== "connection_token") {
    return null;
  }
  return { userId: credential.data.userId, credentialId: credential.data.credentialId };
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
