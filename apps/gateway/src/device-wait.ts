import type { Decision, ErrorCode } from "@agentdesk/contract";
import { authenticate } from "./auth.js";
import { pollDecision } from "./await.js";
import { type ServiceCall, ServiceError, UpstreamError } from "./convex.js";
import type { Env } from "./env.js";
import { eventStream } from "./sse.js";

// component-gateway §Waiter endpoint: `POST /device/wait` serves
// component-resume's waiter, which runs outside any MCP session (DEC-15(2)).
// The route resolves only a connection token and calls no `/svc/agents/*`
// route, so a waiting harness adds no agent session
// (req-installation-and-agent-guidance AC-12.7). `/svc/decisions/watch`
// touches the session that asked the decision (req-agent-status AC-3.5).

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 600;

type WaitEvent =
  | { decision: Decision }
  | { state: "pending"; decision_id: string }
  | { error: { code: string; message: string; field?: string } };

const UNAVAILABLE: WaitEvent = {
  error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
};

// Authentication and the body checks answer before the stream opens. A
// Convex outage while resolving the credential throws, and `handle` answers
// it with 503, never 401.
export async function deviceWait(request: Request, _env: Env, svc: ServiceCall): Promise<Response> {
  const caller = await authenticate(request, svc);
  if (caller === null) {
    return failure(401, "unauthenticated", "Missing or invalid credential");
  }
  const input = await waitInput(request);
  if (input instanceof Response) {
    return input;
  }
  // The identity comes only from the credential; the body names none.
  const body = { userId: caller.userId, decisionId: input.decisionId };

  return eventStream(request.signal, async (signal): Promise<WaitEvent> => {
    try {
      const decision = await pollDecision(
        svc,
        "decisions/watch",
        body,
        input.timeoutSeconds,
        signal,
      );
      return decision === null ? { state: "pending", decision_id: input.decisionId } : { decision };
    } catch (error) {
      // After a disconnect nothing more is written.
      if (signal.aborted) {
        throw error;
      }
      // A service error body, such as `not_found` for an unknown decision or
      // another user's, passes through as the contract states it.
      if (error instanceof ServiceError) {
        return {
          error:
            error.field === undefined
              ? { code: error.code, message: error.message }
              : { code: error.code, message: error.message, field: error.field },
        };
      }
      // The stream is open, so `handle` can no longer answer 503. The event
      // names no route, credential, or secret.
      if (!(error instanceof UpstreamError)) {
        console.error(error);
      }
      return UNAVAILABLE;
    }
  });
}

// Reads `{decision_id, timeout_seconds}`. Unknown fields are dropped. A
// failure is a 400 `invalid` naming the field.
async function waitInput(
  request: Request,
): Promise<{ decisionId: string; timeoutSeconds: number } | Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return failure(400, "invalid", "Body must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure(400, "invalid", "Body must be a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  const decisionId = fields.decision_id;
  if (typeof decisionId !== "string" || decisionId === "") {
    return failure(400, "invalid", "decision_id must be a non-empty string", "decision_id");
  }
  const timeout = fields.timeout_seconds;
  if (timeout === undefined) {
    return { decisionId, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  }
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_TIMEOUT_SECONDS
  ) {
    return failure(
      400,
      "invalid",
      `timeout_seconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`,
      "timeout_seconds",
    );
  }
  return { decisionId, timeoutSeconds: timeout };
}

function failure(status: number, code: ErrorCode, message: string, field?: string): Response {
  return Response.json(
    { error: field === undefined ? { code, message } : { code, message, field } },
    { status },
  );
}
