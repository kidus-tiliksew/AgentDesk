import { z } from "zod";

// component-contract §Decision input and answers.
export const inputTypeSchema = z.enum([
  "approve_reject",
  "single_choice",
  "multiple_choice",
  "free_text",
  "single_choice_or_text",
]);
export type InputType = z.infer<typeof inputTypeSchema>;

// The input types whose decisions carry options.
export const CHOICE_INPUT_TYPES: readonly InputType[] = [
  "single_choice",
  "multiple_choice",
  "single_choice_or_text",
];

export const optionSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(80),
});
export type Option = z.infer<typeof optionSchema>;

// Each variant is strict, so a payload cannot carry an option and text at
// once (req-decision-requests AC-2.4).
export const answerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approve") }),
  z.strictObject({ kind: z.literal("reject") }),
  z.strictObject({ kind: z.literal("option"), option_id: z.string() }),
  z.strictObject({ kind: z.literal("options"), option_ids: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(4000) }),
]);
export type Answer = z.infer<typeof answerSchema>;
export type AnswerKind = Answer["kind"];

const VALID_KINDS: Record<InputType, readonly AnswerKind[]> = {
  approve_reject: ["approve", "reject"],
  single_choice: ["option"],
  multiple_choice: ["options"],
  free_text: ["text"],
  single_choice_or_text: ["option", "text"],
};

type Path = (string | number)[];
type Issue = { message: string; path: Path };

// The answer table. One implementation serves answers, recommendations, and
// defaults (req-decision-requests AC-2.2, AC-2.3, AC-2.4, AC-3.1, AC-5.3).
export function answerTableIssues(
  inputType: InputType,
  options: readonly Option[] | undefined,
  answer: Answer,
  path: Path = [],
): Issue[] {
  if (!VALID_KINDS[inputType].includes(answer.kind)) {
    return [
      {
        message: `answer kind "${answer.kind}" is not valid for input type "${inputType}"`,
        path: [...path, "kind"],
      },
    ];
  }
  const ids = new Set((options ?? []).map((option) => option.id));
  const issues: Issue[] = [];
  if (answer.kind === "option" && !ids.has(answer.option_id)) {
    issues.push({ message: "option_id names no option", path: [...path, "option_id"] });
  }
  if (answer.kind === "options") {
    const seen = new Set<string>();
    answer.option_ids.forEach((id, index) => {
      if (!ids.has(id)) {
        issues.push({
          message: "option_ids names no option",
          path: [...path, "option_ids", index],
        });
      } else if (seen.has(id)) {
        issues.push({
          message: "option_ids repeats an option",
          path: [...path, "option_ids", index],
        });
      }
      seen.add(id);
    });
  }
  return issues;
}

// Returns a schema that accepts only answers valid for the input type and
// options.
export function answerSchemaFor(inputType: InputType, options: readonly Option[] | undefined) {
  return answerSchema.superRefine((answer, ctx) => {
    for (const issue of answerTableIssues(inputType, options, answer)) {
      ctx.addIssue({ code: "custom", input: answer, ...issue });
    }
  });
}

export function validateAnswer(
  inputType: InputType,
  options: readonly Option[] | undefined,
  answer: unknown,
): z.ZodSafeParseResult<Answer> {
  return answerSchemaFor(inputType, options).safeParse(answer);
}

// An answer as the user submits it, with an optional note
// (req-decision-requests AC-2.5). Validate `answer` against the decision with
// validateAnswer.
export const answerSubmissionSchema = z.object({
  answer: answerSchema,
  note: z.string().max(2000).optional(),
});
export type AnswerSubmission = z.infer<typeof answerSubmissionSchema>;
