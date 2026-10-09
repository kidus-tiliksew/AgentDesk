import { z } from "zod";

// component-contract §Status input. The status tool's topic is validated
// separately with topicInputSchema (req-agent-tools REQ-8).
export const statusStateSchema = z.enum(["working", "waiting", "blocked", "done"]);
export type StatusState = z.infer<typeof statusStateSchema>;

export const statusLineSchema = z.string().min(1).max(200);

// An absolute http or https URL (req-agent-status AC-1.3).
export const statusLinkSchema = z.url({ protocol: /^https?$/ });

export const displayNameSchema = z.string().min(1).max(60);

// `link` is optional (req-agent-status REQ-1); `display_name` renames the
// session (AC-2.2).
export const statusInputSchema = z.object({
  state: statusStateSchema,
  line: statusLineSchema,
  link: statusLinkSchema.optional(),
  display_name: displayNameSchema.optional(),
});
export type StatusInput = z.infer<typeof statusInputSchema>;
