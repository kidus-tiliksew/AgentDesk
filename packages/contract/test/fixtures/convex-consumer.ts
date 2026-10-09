// A representative Convex function body: it imports the contract by package
// name and passes the time it read to the validators
// (component-backend-foundation §Errors and time).
import { type ErrorCode, validateAnswer, validateDecisionInput } from "@agentdesk/contract";

export function create(input: unknown, now: number): { code: ErrorCode | "ok"; field?: string } {
  const result = validateDecisionInput(input, now);
  if (!result.success) {
    return { code: "invalid", field: result.error.issues[0]?.path.join(".") };
  }
  const { input_type, options, recommendation } = result.data;
  if (recommendation && !validateAnswer(input_type, options, recommendation).success) {
    return { code: "invalid", field: "recommendation" };
  }
  return { code: "ok" };
}
