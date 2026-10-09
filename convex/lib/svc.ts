import { type ErrorBody, type ErrorCode, errorBodySchema } from "@agentdesk/contract";
import { ConvexError } from "convex/values";
import type { z } from "zod";
import { type ActionCtx, httpAction } from "../_generated/server";

// component-backend-foundation §Service routes. The public API maps `locked`
// to 409 (component-contract §Route table); service routes map it to 423.
const SERVICE_STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  unauthenticated: 401,
  not_found: 404,
  conflict: 409,
  locked: 423,
  rate_limited: 429,
};

// Wraps one `POST /svc/<domain>/<operation>` route that the gateway calls
// (DEC-4): authenticate, validate the body, run the handler, map its errors.
export function serviceRoute<Schema extends z.ZodType>(
  schema: Schema,
  handler: (ctx: ActionCtx, input: z.output<Schema>) => Promise<unknown>,
) {
  return httpAction(async (ctx, request) => {
    if (!(await authorized(request.headers.get("Authorization")))) {
      return errorResponse("unauthenticated", "Invalid service credential");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("invalid", "Request body is not valid JSON");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join(".");
      return errorResponse("invalid", issue?.message ?? "Invalid request body", field || undefined);
    }

    try {
      return jsonResponse(200, (await handler(ctx, parsed.data)) ?? null);
    } catch (error) {
      // Only a ConvexError carrying a contract error code maps to a status;
      // anything else propagates as Convex's generic server error.
      const data =
        error instanceof ConvexError ? errorBodySchema.shape.error.safeParse(error.data) : null;
      if (!data?.success) {
        throw error;
      }
      return errorResponse(data.data.code, data.data.message, data.data.field);
    }
  });
}

// An unset or empty SERVICE_SECRET refuses every call, so a deployment without
// the secret never accepts "Bearer undefined".
async function authorized(header: string | null): Promise<boolean> {
  const secret = process.env.SERVICE_SECRET;
  if (!secret || header === null) {
    return false;
  }
  return await constantTimeEqual(header, `Bearer ${secret}`);
}

// The default Convex runtime has no Node crypto. Hashing both sides with Web
// Crypto yields equal-length digests, and the loop visits every byte, so the
// comparison time depends on neither the header's length nor its content.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}

function errorResponse(code: ErrorCode, message: string, field?: string): Response {
  const body: ErrorBody = {
    error: field === undefined ? { code, message } : { code, message, field },
  };
  return jsonResponse(SERVICE_STATUS[code], body);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
