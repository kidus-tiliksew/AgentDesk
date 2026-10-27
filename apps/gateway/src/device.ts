import type { ErrorCode } from "@agentdesk/contract";
import { z } from "zod";
import { MAC_CLIENT } from "../../../convex/identity/clients.js";
import { isHarnessId, parseHarnesses } from "../../../convex/identity/harnesses.js";
import { authenticate, bearerToken, type Caller, hashToken } from "./auth.js";
import { type ServiceCall, ServiceError, UpstreamError } from "./convex.js";
import type { Env } from "./env.js";

// component-gateway §Sign-in endpoints: short-code sign-in for the installer
// and the Mac app, and the presenting connection's check and revoke
// (req-accounts-and-connections REQ-6; req-installation-and-agent-guidance
// AC-9.6; req-mac-app REQ-2). `component-identity` owns the
// requests, codes, and tokens. These handlers validate, rate-limit, and map
// its service results, and keep nothing. A Convex outage or an unexpected
// service result throws, and `handle` answers it with 503.

// The installer polls every 2 seconds, and a code lives 10 minutes
// (AC-6.1).
export const POLL_INTERVAL_SECONDS = 2;
export const CODE_TTL_SECONDS = 600;

const MAX_MACHINE_NAME_LENGTH = 255;

// A device secret is 32 random bytes in base64url, as identity issues it.
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/;

const startedSchema = z.object({
  code: z.string().regex(/^[0-9A-Z]{8}$/),
  device_secret: z.string().regex(DEVICE_SECRET),
  expires_at: z.number(),
});

// An approved outcome carries the installer's connections or a Mac request's
// one API token (req-mac-app AC-2.3), never both.
const collectedSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("declined") }),
  // An unknown secret, or one whose outcome was already collected.
  z.object({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("approved"),
    connections: z
      .array(
        z.object({
          harness: z.string().refine(isHarnessId),
          connection_id: z.string().min(1),
          token: z.string().startsWith("adc_"),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    status: z.literal("approved"),
    api_token: z.object({
      credential_id: z.string().min(1),
      token: z.string().startsWith("adp_"),
    }),
  }),
]);

// `POST /device/start` (AC-6.1). The rate limit runs first, so neither an
// invalid body nor a valid one gets past ten starts a minute from one client
// IP. Without the binding or the client IP the route refuses rather than run
// unlimited.
export async function deviceStart(request: Request, env: Env, svc: ServiceCall): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (env.DEVICE_START_LIMIT === undefined || clientIp === null || clientIp === "") {
    console.error("/device/start needs the DEVICE_START_LIMIT binding and CF-Connecting-IP");
    throw new UpstreamError("The device start rate limit is not configured");
  }
  const { success } = await env.DEVICE_START_LIMIT.limit({ key: clientIp });
  if (!success) {
    return failure(429, "rate_limited", "Too many sign-in requests; try again in a minute");
  }

  const body = await jsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
    return failure(400, "invalid", "Body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  const machineName = typeof fields.machine_name === "string" ? fields.machine_name.trim() : "";
  if (machineName === "" || machineName.length > MAX_MACHINE_NAME_LENGTH) {
    return failure(
      400,
      "invalid",
      `machine_name must be 1 to ${MAX_MACHINE_NAME_LENGTH} characters`,
      "machine_name",
    );
  }
  // A request names exactly one of `harnesses` and `client: "macos"`
  // (req-mac-app AC-2.1). Without `client`, the installer's harness check and
  // its 400 naming `harnesses` are unchanged.
  let requester: { harnesses: string[] } | { client: typeof MAC_CLIENT };
  if (fields.client !== undefined) {
    if (fields.harnesses !== undefined || fields.client !== MAC_CLIENT) {
      return failure(400, "invalid", `client must be ${MAC_CLIENT}, without harnesses`, "client");
    }
    requester = { client: MAC_CLIENT };
  } else {
    const harnesses = Array.isArray(fields.harnesses) ? parseHarnesses(fields.harnesses) : null;
    if (harnesses === null) {
      return failure(
        400,
        "invalid",
        "harnesses must be a non-empty list of distinct values from claude-code, codex, and cursor",
        "harnesses",
      );
    }
    requester = { harnesses };
  }

  const started = startedSchema.safeParse(
    await svc("identity/device-start", { machine_name: machineName, ...requester }),
  );
  if (!started.success) {
    throw new UpstreamError("Service call identity/device-start returned an invalid result");
  }
  // The code goes out as identity's 8 bare symbols. The installer validates
  // that form and alone displays it as `XXXX-XXXX` (AC-6.1).
  const { code, device_secret } = started.data;
  return Response.json(
    {
      user_code: code,
      device_secret,
      interval: POLL_INTERVAL_SECONDS,
      expires_in: CODE_TTL_SECONDS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// `POST /device/poll` (AC-6.3, AC-6.4; req-mac-app AC-2.3). Identity's
// statuses pass through unchanged. An approved outcome carries one connection
// token per harness, or a Mac request's one API token, and identity returns it
// exactly once: the next poll for the same secret is `not_found`.
export async function devicePoll(request: Request, _env: Env, svc: ServiceCall): Promise<Response> {
  const body = await jsonBody(request);
  const deviceSecret =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).device_secret
      : undefined;
  if (typeof deviceSecret !== "string" || !DEVICE_SECRET.test(deviceSecret)) {
    return failure(
      400,
      "invalid",
      "device_secret must be the secret from /device/start",
      "device_secret",
    );
  }

  const collected = collectedSchema.safeParse(
    await svc("identity/device-collect", { device_secret: deviceSecret }),
  );
  if (!collected.success) {
    throw new UpstreamError("Service call identity/device-collect returned an invalid result");
  }
  return Response.json(collected.data, { headers: { "Cache-Control": "no-store" } });
}

// Resolves the credential presenting itself on `/device/connection`: a
// connection token, or the API token a Mac sign-in minted
// (req-mac-app AC-2.7). Any other API token, and anything else, is null.
async function presentingConnection(
  request: Request,
  svc: ServiceCall,
): Promise<{ token: string; caller: Caller } | null> {
  const connection = bearerToken(request, "connection_token");
  if (connection !== null) {
    const caller = await authenticate(request, svc);
    return caller === null ? null : { token: connection, caller };
  }
  const apiToken = bearerToken(request, "api_token");
  if (apiToken !== null) {
    const caller = await authenticate(request, svc, "api_token");
    return caller === null || caller.harness !== MAC_CLIENT ? null : { token: apiToken, caller };
  }
  return null;
}

// `GET /device/connection`: the installer's re-run check, and the Mac app's
// check of its own sign-in. The token resolves again on every request, so a
// revoked connection fails its next check (DEC-6; req-accounts-and-connections
// AC-4.2).
export async function getConnection(
  request: Request,
  _env: Env,
  svc: ServiceCall,
): Promise<Response> {
  const presenting = await presentingConnection(request, svc);
  if (presenting === null) {
    return refused();
  }
  const { caller } = presenting;
  if (caller.harness !== MAC_CLIENT && !isHarnessId(caller.harness)) {
    throw new UpstreamError("Service call identity/resolve-token returned no harness");
  }
  return Response.json({ connection_id: caller.credentialId, harness: caller.harness });
}

// `DELETE /device/connection`: the installer's uninstall, or the Mac app's
// sign-out, revokes the token it presents (AC-9.6; req-mac-app AC-2.7). Only
// the token's hash reaches Convex.
export async function deleteConnection(
  request: Request,
  _env: Env,
  svc: ServiceCall,
): Promise<Response> {
  const presenting = await presentingConnection(request, svc);
  if (presenting === null) {
    return refused();
  }
  const { token } = presenting;
  try {
    await svc("identity/revoke-self", { token_hash: await hashToken(token) });
  } catch (error) {
    // Revoked by another request between the check and the revoke.
    if (error instanceof ServiceError && error.code === "unauthenticated") {
      return refused();
    }
    throw error;
  }
  return Response.json(null);
}

// The 401 for `/device/connection`. Unlike `/mcp`'s, it carries no
// `WWW-Authenticate` challenge, because the challenge starts browser sign-in.
function refused(): Response {
  return failure(401, "unauthenticated", "Missing or invalid credential");
}

function failure(status: number, code: ErrorCode, message: string, field?: string): Response {
  return Response.json(
    { error: field === undefined ? { code, message } : { code, message, field } },
    { status },
  );
}

// The parsed JSON body, or undefined when the body is not JSON.
async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
