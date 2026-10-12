import type { RouteSpec } from "convex/server";
import { z } from "zod";
import { internal } from "../_generated/api";
import { serviceRoute } from "../lib/svc";

// The identity domain's service routes, mounted by convex/http.ts
// (component-backend-foundation §Composition). Credential resolution,
// self-revoke, and the installer's short-code start and collect act for no
// account, so the gateway sends no userId (§Service routes).

// The SHA-256 hex of a presented token, never the token itself.
const tokenHash = z.string().regex(/^[0-9a-f]{64}$/);

export const routes: RouteSpec[] = [
  {
    path: "/svc/identity/resolve-token",
    method: "POST",
    // Body: the SHA-256 hex of the presented token, never the token itself.
    handler: serviceRoute(z.object({ token_hash: tokenHash }), (ctx, input) =>
      ctx.runMutation(internal.identity.credentials.resolveToken, {
        tokenHash: input.token_hash,
      }),
    ),
  },
  {
    path: "/svc/identity/revoke-self",
    method: "POST",
    // The installer's uninstall revokes the token it presents; 200 null.
    handler: serviceRoute(z.object({ token_hash: tokenHash }), (ctx, input) =>
      ctx.runMutation(internal.identity.selfRevoke.revokeSelf, { tokenHash: input.token_hash }),
    ),
  },
  {
    path: "/svc/identity/device-start",
    method: "POST",
    // req-accounts-and-connections AC-6.1. The harness list is validated
    // against the fixed vocabulary by startDeviceRequest.
    handler: serviceRoute(
      z.object({
        machine_name: z.string().trim().min(1).max(255),
        harnesses: z.array(z.string()),
      }),
      async (ctx, input) => {
        const started = await ctx.runMutation(internal.identity.deviceRequests.startDeviceRequest, {
          machineName: input.machine_name,
          harnesses: input.harnesses,
        });
        return {
          code: started.code,
          device_secret: started.deviceSecret,
          expires_at: started.expiresAt,
        };
      },
    ),
  },
  {
    path: "/svc/identity/device-collect",
    method: "POST",
    // req-accounts-and-connections AC-6.3, AC-6.4: one mutation, so the
    // tokens are returned once. The secret is 32 bytes in base64url.
    handler: serviceRoute(
      z.object({ device_secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      (ctx, input) =>
        ctx.runMutation(internal.identity.deviceRequests.collectDeviceRequest, {
          deviceSecret: input.device_secret,
        }),
    ),
  },
];
