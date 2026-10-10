import type { RouteSpec } from "convex/server";
import { z } from "zod";
import { internal } from "../_generated/api";
import { serviceRoute } from "../lib/svc";

// The identity domain's service routes, mounted by convex/http.ts
// (component-backend-foundation §Composition). Credential resolution acts for
// no account, so the gateway sends no userId (§Service routes).
export const routes: RouteSpec[] = [
  {
    path: "/svc/identity/resolve-token",
    method: "POST",
    // Body: the SHA-256 hex of the presented token, never the token itself.
    handler: serviceRoute(
      z.object({ token_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
      (ctx, input) =>
        ctx.runMutation(internal.identity.credentials.resolveToken, {
          tokenHash: input.token_hash,
        }),
    ),
  },
];
