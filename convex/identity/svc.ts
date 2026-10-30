import type { RouteSpec } from "convex/server";
import { z } from "zod";
import { internal } from "../_generated/api";
import { serviceRoute } from "../lib/svc";
import { identity } from "./refs";

// The identity domain's service routes, mounted by convex/http.ts
// (component-backend-foundation §Composition). Credential resolution,
// self-revoke, the installer's short-code start and collect, and install-key
// enrollment act for no account, so the gateway sends no userId (§Service
// routes).

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
    // req-accounts-and-connections AC-6.1; req-mac-app AC-2.1. The body names
    // the harnesses or the Mac client; startDeviceRequest checks that it names
    // exactly one and validates the harness list against the fixed vocabulary.
    handler: serviceRoute(
      z.object({
        machine_name: z.string().trim().min(1).max(255),
        harnesses: z.array(z.string()).optional(),
        client: z.string().optional(),
      }),
      async (ctx, input) => {
        const started = await ctx.runMutation(internal.identity.deviceRequests.startDeviceRequest, {
          machineName: input.machine_name,
          harnesses: input.harnesses,
          client: input.client,
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
    // req-accounts-and-connections AC-6.3, AC-6.4; req-mac-app AC-2.3: one
    // mutation, so the tokens are returned once. The secret is 32 bytes in
    // base64url.
    handler: serviceRoute(
      z.object({ device_secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      (ctx, input) =>
        ctx.runMutation(internal.identity.deviceRequests.collectDeviceRequest, {
          deviceSecret: input.device_secret,
        }),
    ),
  },
  {
    path: "/svc/identity/enroll",
    method: "POST",
    // req-install-keys REQ-2: the gateway sends the install key's SHA-256
    // hex, never the key. `enroll` validates the machine name and harnesses
    // and answers its status; an enrolled run's tokens are returned once.
    handler: serviceRoute(
      z.object({ key_hash: tokenHash, machine_name: z.string(), harnesses: z.array(z.string()) }),
      async (ctx, input) => {
        const result = await ctx.runMutation(identity.installKeys.enroll, {
          keyHash: input.key_hash,
          machineName: input.machine_name,
          harnesses: input.harnesses,
        });
        if (result.status !== "enrolled") {
          return result;
        }
        return {
          status: result.status,
          machine_id: result.machineId,
          connections: result.connections,
        };
      },
    ),
  },
];
