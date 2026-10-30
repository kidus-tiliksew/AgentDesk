import type { ErrorCode } from "@agentdesk/contract";
import { z } from "zod";
import { isHarnessId, parseHarnesses } from "../../../convex/identity/harnesses.js";
import { hashToken } from "./auth.js";
import { type ServiceCall, ServiceError } from "./convex.js";
import type { Env } from "./env.js";

// component-gateway §Sign-in endpoints: `POST /device/enroll`, the
// installer's install-key enrollment (req-install-keys REQ-2; DEC-21).
// `component-identity` owns the keys and the enrollment. This handler
// rate-limits, validates, hashes the key, and maps identity's status. The
// install key reaches no log line: the handler answers every failure itself,
// so nothing it touched reaches the Worker's catch-all, which logs, and it
// logs only fixed text.

const MAX_MACHINE_NAME_LENGTH = 255;

// An install key is `adk_` and 32 random bytes in base64url.
const INSTALL_KEY = /^adk_[A-Za-z0-9_-]{43}$/;

// Identity's field names in an `invalid` refusal, as the body names them.
const FIELDS: Record<string, string> = { machineName: "machine_name", harnesses: "harnesses" };

const enrolledSchema = z.union([
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({ status: z.literal("revoked") }),
  z.strictObject({ status: z.literal("expired") }),
  z.strictObject({ status: z.literal("limit_reached") }),
  z.strictObject({
    status: z.literal("harness_not_allowed"),
    harness: z.string().refine(isHarnessId),
  }),
  z.strictObject({
    status: z.literal("enrolled"),
    machine_id: z.string().regex(/^[0-9a-f]{32}$/),
    connections: z
      .array(
        z.strictObject({
          harness: z.string().refine(isHarnessId),
          connection_id: z.string().min(1),
          token: z.string().startsWith("adc_"),
        }),
      )
      .min(1),
  }),
]);

// `POST /device/enroll`. The rate limit runs before the body is read, so
// neither a valid nor an invalid body gets past 60 calls a minute from one
// client IP. Without the binding or the client IP the route refuses rather
// than run unlimited. Every answer carries `Cache-Control: no-store`, since an
// enrollment carries connection tokens.
export async function deviceEnroll(
  request: Request,
  env: Env,
  svc: ServiceCall,
): Promise<Response> {
  try {
    return await enroll(request, env, svc);
  } catch (error) {
    // A Convex outage, an unexpected service refusal or result, or any other
    // failure. Neither the error, which may carry the request, nor the body
    // is logged or returned.
    console.error(
      `/device/enroll failed: ${error instanceof ServiceError ? `service ${error.code}` : "unavailable"}`,
    );
    return failure(503, "unavailable", "AgentDesk is temporarily unavailable");
  }
}

async function enroll(request: Request, env: Env, svc: ServiceCall): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (env.DEVICE_ENROLL_LIMIT === undefined || clientIp === null || clientIp === "") {
    console.error("/device/enroll needs the DEVICE_ENROLL_LIMIT binding and CF-Connecting-IP");
    return failure(503, "unavailable", "AgentDesk is temporarily unavailable");
  }
  const { success } = await env.DEVICE_ENROLL_LIMIT.limit({ key: clientIp });
  if (!success) {
    return failure(429, "rate_limited", "Too many enrollments; try again in a minute");
  }

  const body = await jsonBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return failure(400, "invalid", "Body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  const installKey = fields.install_key;
  if (typeof installKey !== "string" || !INSTALL_KEY.test(installKey)) {
    return failure(400, "invalid", "install_key must be an AgentDesk install key", "install_key");
  }
  const machineName = typeof fields.machine_name === "string" ? fields.machine_name.trim() : "";
  if (machineName === "" || machineName.length > MAX_MACHINE_NAME_LENGTH) {
    return failure(
      400,
      "invalid",
      `machine_name must be 1 to ${MAX_MACHINE_NAME_LENGTH} characters`,
      "machine_name",
    );
  }
  const harnesses = Array.isArray(fields.harnesses) ? parseHarnesses(fields.harnesses) : null;
  if (harnesses === null) {
    return failure(
      400,
      "invalid",
      "harnesses must be a non-empty list of distinct values from claude-code, codex, and cursor",
      "harnesses",
    );
  }

  let result: unknown;
  try {
    result = await svc("identity/enroll", {
      key_hash: await hashToken(installKey),
      machine_name: machineName,
      harnesses,
    });
  } catch (error) {
    const field = error instanceof ServiceError ? FIELDS[error.field ?? ""] : undefined;
    if (error instanceof ServiceError && error.code === "invalid" && field !== undefined) {
      return failure(400, "invalid", `${field} is not valid`, field);
    }
    throw error;
  }
  const enrolled = enrolledSchema.safeParse(result);
  if (!enrolled.success) {
    throw new Error("Service call identity/enroll returned an invalid result");
  }
  return Response.json(enrolled.data, { headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, code: ErrorCode | "unavailable", message: string, field?: string) {
  return Response.json(
    { error: field === undefined ? { code, message } : { code, message, field } },
    { status, headers: { "Cache-Control": "no-store" } },
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
