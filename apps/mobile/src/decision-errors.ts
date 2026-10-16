import {
  type Decision,
  decisionSchema,
  type ErrorCode,
  errorCodeSchema,
} from "@agentdesk/contract";
import { ConvexError } from "convex/values";
import { errorData } from "./query-error-boundary";

// What a failed answer mutation means for the decision screen.
// - `conflict`: the decision settled elsewhere first; `decision` is the stored
//   outcome from the error's data (req-mobile-app AC-3.2).
// - `malformed_conflict`: the backend reported `conflict` without a readable
//   stored decision. The screen shows no outcome and allows no resubmission
//   until the decision query reports the settlement.
// - `failed`: any other failure, with fixed copy for its code to show. The
//   draft stays.
export type AnswerFailure =
  | { kind: "conflict"; decision: Decision }
  | { kind: "malformed_conflict" }
  | { kind: "failed"; message: string };

// Fixed copy for each refusal code the answer mutation can return. The
// backend's `data.message` is written for developers and API clients, so it is
// never shown.
const CODE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  invalid: "Check your answer and try again.",
  unauthenticated: "Your session ended. Sign in again.",
  not_found: "This decision no longer exists.",
  locked: "This decision cannot accept an answer right now.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
};

// A refusal with a code this app does not know.
const UNKNOWN_CODE_MESSAGE = "Could not send your answer. Try again.";

// A failure with no `ConvexError` code, such as a transport error or a plain
// `Error` that Convex redacts in production.
const NO_CODE_MESSAGE = "Could not send your answer. Check your connection.";

function storedDecision(error: unknown): unknown {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    "decision" in error.data
  ) {
    return error.data.decision;
  }
  return undefined;
}

// `decisions/app:answer` refuses a settled decision as
// `ConvexError({code: "conflict", decision})` (component-decisions §Reads).
// The stored decision is checked against the contract's Decision shape rather
// than cast, so a malformed payload is never shown as the recorded outcome.
export function answerFailure(error: unknown): AnswerFailure {
  const data = errorData(error);
  if (data !== null && data.code === errorCodeSchema.enum.conflict) {
    const parsed = decisionSchema.safeParse(storedDecision(error));
    if (parsed.success && parsed.data.state !== "pending") {
      return { kind: "conflict", decision: parsed.data };
    }
    return { kind: "malformed_conflict" };
  }
  if (data === null) {
    return { kind: "failed", message: NO_CODE_MESSAGE };
  }
  const parsed = errorCodeSchema.safeParse(data.code);
  return {
    kind: "failed",
    message: (parsed.success ? CODE_MESSAGES[parsed.data] : undefined) ?? UNKNOWN_CODE_MESSAGE,
  };
}
