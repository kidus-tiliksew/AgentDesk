import { z } from "zod";
import {
  answerSchema,
  answerTableIssues,
  CHOICE_INPUT_TYPES,
  inputTypeSchema,
  optionSchema,
} from "./answers.js";
import { topicInputSchema } from "./topics.js";

// An ISO 8601 instant with seconds and a `Z` or numeric offset: the RFC 3339
// profile that JSON Schema's `date-time` format names.
export const instantSchema = z.iso.datetime({ offset: true });

// component-contract §Decision input and answers, one schema per field row.
export const titleSchema = z.string().min(1).max(120);
export const bodySchema = z.string().max(16000);
export const optionsSchema = z.array(optionSchema).min(2).max(10);
export const prioritySchema = z.enum(["normal", "urgent"]);
export type Priority = z.infer<typeof prioritySchema>;
export const deadlineSchema = instantSchema;
export const parentIdSchema = z.string();
export const idempotencyKeySchema = z.string().min(1).max(128);
export const interactiveSchema = z
  .boolean()
  .describe("True when the user may be watching this session and can answer in its chat");

// The decision input fields without cross-field rules. It needs no clock, so
// route tables and JSON Schema generation can use it.
export const decisionInputFieldsSchema = z.object({
  title: titleSchema,
  body: bodySchema.optional(),
  input_type: inputTypeSchema,
  options: optionsSchema.optional(),
  topic: topicInputSchema,
  priority: prioritySchema.default("normal"),
  interactive: interactiveSchema.default(false),
  recommendation: answerSchema.optional(),
  deadline: deadlineSchema.optional(),
  default: answerSchema.optional(),
  parent_id: parentIdSchema.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
});
export type DecisionInput = z.output<typeof decisionInputFieldsSchema>;

// Returns the full decision input schema, with the cross-field rules checked
// against `now`, the caller's current time in epoch milliseconds
// (component-backend-foundation §Errors and time).
export function decisionInputSchema(now: number) {
  return decisionInputFieldsSchema.superRefine((input, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", input, message, path });

    const choice = CHOICE_INPUT_TYPES.includes(input.input_type);
    if (choice && input.options === undefined) {
      issue(`options is required for input type "${input.input_type}"`, ["options"]);
    }
    if (!choice && input.options !== undefined) {
      issue(`options is not allowed for input type "${input.input_type}"`, ["options"]);
    }
    const seen = new Set<string>();
    input.options?.forEach((option, index) => {
      if (seen.has(option.id)) {
        issue("option id repeats an earlier option", ["options", index, "id"]);
      }
      seen.add(option.id);
    });

    if (input.default !== undefined && input.deadline === undefined) {
      issue("default requires deadline", ["default"]);
    }
    // A malformed deadline already carries its format issue.
    const deadline = deadlineSchema.safeParse(input.deadline);
    if (deadline.success && Date.parse(deadline.data) <= now) {
      issue("deadline must be later than now", ["deadline"]);
    }

    for (const field of ["recommendation", "default"] as const) {
      const answer = input[field];
      if (answer !== undefined) {
        for (const { message, path } of answerTableIssues(input.input_type, input.options, answer, [
          field,
        ])) {
          issue(message, path);
        }
      }
    }
  });
}

export function validateDecisionInput(
  input: unknown,
  now: number,
): z.ZodSafeParseResult<DecisionInput> {
  return decisionInputSchema(now).safeParse(input);
}

// component-contract §Relayed answers. A chat message the user typed, kept
// word for word: a message with no non-whitespace character is refused, and
// an accepted message is returned without trimming or normalization
// (req-decision-requests AC-8.2).
export const chatMessageSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((message) => /\S/.test(message), {
    message: "chat_message must contain a non-whitespace character",
  });

// The resolve tool's input (req-agent-tools REQ-9). The answer is checked for
// shape only; component-decisions validates it against the decision with
// validateAnswer. A relayed answer carries no note.
export const resolveInputSchema = z.object({
  decision_id: z.string().min(1),
  answer: answerSchema,
  chat_message: chatMessageSchema,
});
export type ResolveInput = z.output<typeof resolveInputSchema>;
