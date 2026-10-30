import { type ErrorCode, errorBodySchema } from "@agentdesk/contract";
import type { Env } from "./env.js";

// component-gateway §Configuration: the only module that reaches Convex
// (DEC-4). Every call is `POST ${CONVEX_SITE_URL}/svc/<domain>/<operation>`
// with the service secret, and the gateway keeps nothing it receives.

export const SERVICE_TIMEOUT_MS = 10_000;

export type ServiceRoute =
  | "identity/resolve-token"
  | "identity/revoke-self"
  | "identity/device-start"
  | "identity/device-collect"
  | "identity/enroll"
  | "agents/open"
  | "agents/session"
  | "agents/status"
  | "agents/list"
  | "agents/get"
  | "decisions/create"
  | "decisions/poll"
  | "decisions/watch"
  | "decisions/check"
  | "decisions/cancel"
  | "decisions/resolve"
  | "decisions/list"
  | "decisions/get"
  | "decisions/answer";

// Posts one service call and returns its parsed JSON result. Aborting `signal`
// cancels the call in flight. Tests replace it with a fake.
export type ServiceCall = (
  route: ServiceRoute,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

// A contract error body from a service route, such as `not_found` for another
// user's decision.
export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

// Convex did not answer with a usable result: a timeout, a network failure,
// or a response that is not the service route contract. The message never
// carries the request, so no token hash or secret leaks.
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export function serviceClient(
  env: Pick<Env, "CONVEX_SITE_URL" | "SERVICE_SECRET">,
  fetcher: typeof fetch = fetch,
): ServiceCall {
  const origin = env.CONVEX_SITE_URL.replace(/\/+$/, "");
  return async (route, body, signal) => {
    // A timer rather than AbortSignal.timeout, so tests can drive it with fake
    // timers.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SERVICE_TIMEOUT_MS);
    const cancel = () => controller.abort();
    if (signal?.aborted) {
      cancel();
    }
    signal?.addEventListener("abort", cancel);
    let response: Response;
    let text: string;
    try {
      response = await fetcher(`${origin}/svc/${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SERVICE_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      throw new UpstreamError(
        timedOut
          ? `Service call ${route} timed out`
          : controller.signal.aborted
            ? `Service call ${route} was cancelled`
            : `Service call ${route} failed`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UpstreamError(`Service call ${route} returned a body that is not JSON`);
    }
    if (response.ok) {
      return parsed;
    }
    const error = errorBodySchema.safeParse(parsed);
    if (!error.success) {
      throw new UpstreamError(`Service call ${route} failed with status ${response.status}`);
    }
    throw new ServiceError(error.data.error.code, error.data.error.message, error.data.error.field);
  };
}
