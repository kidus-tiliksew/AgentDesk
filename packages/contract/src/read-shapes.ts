import { z } from "zod";
import { answerSchema, inputTypeSchema, optionSchema } from "./answers.js";
import { bodySchema, instantSchema, prioritySchema, titleSchema } from "./decisions.js";
import { statusLineSchema, statusLinkSchema, statusStateSchema } from "./status.js";
import { topicSchema } from "./topics.js";

// component-contract §Read shapes and webhook events. Read shapes carry no
// defaults, transforms, or clock checks, so stored values pass through
// unchanged and every shape converts with z.toJSONSchema. An absent value is
// null.

export const decisionStateSchema = z.enum(["pending", "answered", "expired", "cancelled"]);
export type DecisionState = z.infer<typeof decisionStateSchema>;

export const answeredViaSchema = z.enum(["app", "notification", "api", "default"]);
export type AnsweredVia = z.infer<typeof answeredViaSchema>;

export const decisionSchema = z.object({
  id: z.string(),
  topic: topicSchema,
  title: titleSchema,
  body: bodySchema.nullable(),
  input_type: inputTypeSchema,
  options: z.array(optionSchema).nullable(),
  recommendation: answerSchema.nullable(),
  priority: prioritySchema,
  deadline: instantSchema.nullable(),
  default: answerSchema.nullable(),
  state: decisionStateSchema,
  answer: answerSchema.nullable(),
  note: z.string().nullable(),
  answered_at: instantSchema.nullable(),
  answered_via: answeredViaSchema.nullable(),
  applied_by_default: z.boolean(),
  parent_id: z.string().nullable(),
  follow_up_ids: z.array(z.string()),
  agent_session_id: z.string().nullable(),
  created_at: instantSchema,
});
export type Decision = z.infer<typeof decisionSchema>;

// `display_name` is the card name, which falls back to the client name and
// topic, so it has no input bound. `state`, `line`, `link`, and `status_at`
// are null until the session's first status call.
export const agentSessionSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  topic: topicSchema,
  state: statusStateSchema.nullable(),
  line: statusLineSchema.nullable(),
  link: statusLinkSchema.nullable(),
  status_at: instantSchema.nullable(),
  last_activity_at: instantSchema,
  stale: z.boolean(),
  ended_at: instantSchema.nullable(),
  pending_decision_count: z.int().min(0),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const decisionEventKindSchema = z.enum([
  "decision.created",
  "decision.expired",
  "decision.answered",
  "decision.cancelled",
]);
export const agentEventKindSchema = z.enum(["agent.stale", "agent.status_changed", "agent.done"]);
export const webhookEventKindSchema = z.enum([
  ...decisionEventKindSchema.options,
  ...agentEventKindSchema.options,
]);
export type WebhookEventKind = z.infer<typeof webhookEventKindSchema>;

// null for kinds that notification rules do not route.
export const webhookActionSchema = z.enum(["push", "digest", "mute"]).nullable();
export type WebhookAction = z.infer<typeof webhookActionSchema>;

const webhookEventBase = {
  id: z.string(),
  occurred_at: instantSchema,
  action: webhookActionSchema,
};

// Decision kinds carry a Decision and agent kinds an AgentSession.
export const webhookEventSchema = z.union([
  z.object({ ...webhookEventBase, kind: decisionEventKindSchema, data: decisionSchema }),
  z.object({ ...webhookEventBase, kind: agentEventKindSchema, data: agentSessionSchema }),
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
