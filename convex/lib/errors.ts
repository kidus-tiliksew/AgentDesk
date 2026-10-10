import type { ErrorBody, ErrorCode } from "@agentdesk/contract";
import { ConvexError } from "convex/values";

// component-backend-foundation §Errors and time: every domain throws
// `ConvexError({code, message, field?})` with a code from @agentdesk/contract.
export function appError(code: ErrorCode, message: string, field?: string) {
  const data: ErrorBody["error"] =
    field === undefined ? { code, message } : { code, message, field };
  return new ConvexError(data);
}
