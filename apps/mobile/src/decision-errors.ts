import { type Decision, decisionSchema, errorCodeSchema } from "@agentdesk/contract";
import { ConvexError } from "convex/values";
import { errorData } from "./query-error-boundary";

// What a failed answer mutation means for the decision screen.
// - `conflict`: the decision settled elsewhere first; `decision` is the stored
//   outcome from the error's data (req-mobile-app AC-3.2).
// - `malformed_conflict`: the backend reported `conflict` without a readable
//   stored decision. The screen shows no outcome and allows no resubmission
//   until the decision query reports the settlement.
// - `failed`: any other failure, with a message to show. The draft stays.
export type AnswerFailure =
  | { kind: "conflict"; decision: Decision }
  | { kind: "malformed_conflict" }
  | { kind: "failed"; message: string };

function dataMessage(error: unknown): string | null {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    typeof error.data.message === "string" &&
    error.data.message !== ""
  ) {
    return error.data.message;
  }
  return null;
}

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
  return {
    kind: "failed",
    message: dataMessage(error) ?? "Could not send your answer. Check your connection.",
  };
}
