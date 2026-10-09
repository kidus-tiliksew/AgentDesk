import { z } from "zod";

// component-contract §Errors; component-backend-foundation §Service routes
// maps each code to an HTTP status.
export const errorCodeSchema = z.enum([
  "invalid",
  "unauthenticated",
  "not_found",
  "conflict",
  "locked",
  "rate_limited",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const ERROR_CODES: readonly ErrorCode[] = errorCodeSchema.options;

// The public HTTP API error body. `field` names the failing input field.
export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    field: z.string().optional(),
    retry_after: z.int().min(0).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
