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
type TableIssue = { rule: "kind" | "unknown_option" | "repeated_option"; path: Path };

// The answer table. One implementation serves answers, recommendations, and
// defaults (req-decision-requests AC-2.2, AC-2.3, AC-2.4, AC-3.1, AC-5.3).
function tableIssues(
  inputType: InputType,
  options: readonly Option[] | undefined,
  answer: Answer,
  path: Path,
): TableIssue[] {
  if (!VALID_KINDS[inputType].includes(answer.kind)) {
    return [{ rule: "kind", path: [...path, "kind"] }];
  }
  const ids = new Set((options ?? []).map((option) => option.id));
  const issues: TableIssue[] = [];
  if (answer.kind === "option" && !ids.has(answer.option_id)) {
    issues.push({ rule: "unknown_option", path: [...path, "option_id"] });
  }
  if (answer.kind === "options") {
    const seen = new Set<string>();
    answer.option_ids.forEach((id, index) => {
      if (!ids.has(id)) {
        issues.push({ rule: "unknown_option", path: [...path, "option_ids", index] });
      } else if (seen.has(id)) {
        issues.push({ rule: "repeated_option", path: [...path, "option_ids", index] });
      }
      seen.add(id);
    });
  }
  return issues;
}

// The answer table's issues as decision creation reports them for a
// recommendation or a default, naming the fields an agent sent.
export function answerTableIssues(
  inputType: InputType,
  options: readonly Option[] | undefined,
  answer: Answer,
  path: Path = [],
): Issue[] {
  const field = answer.kind === "option" ? "option_id" : "option_ids";
  return tableIssues(inputType, options, answer, path).map(({ rule, path }) => ({
    message:
      rule === "kind"
        ? `answer kind "${answer.kind}" is not valid for input type "${inputType}"`
        : rule === "unknown_option"
          ? `${field} names no option`
          : `${field} repeats an option`,
    path,
  }));
}

// What a person must do when an answer's kind does not fit the decision.
const KIND_MESSAGES: Record<InputType, string> = {
  approve_reject: "Approve or reject this decision.",
  single_choice: "Choose one option.",
  multiple_choice: "Choose one or more options.",
  free_text: "Enter a text answer.",
  single_choice_or_text: "Choose one option or enter a text answer.",
};

const TABLE_MESSAGES: Record<Exclude<TableIssue["rule"], "kind">, string> = {
  unknown_option: "Choose an option from the list.",
  repeated_option: "Choose each option only once.",
};

// Returns a schema that accepts only answers valid for the input type and
// options. Its answer table messages are written for the person answering.
export function answerSchemaFor(inputType: InputType, options: readonly Option[] | undefined) {
  return answerSchema.superRefine((answer, ctx) => {
    for (const { rule, path } of tableIssues(inputType, options, answer, [])) {
      ctx.addIssue({
        code: "custom",
        input: answer,
        message: rule === "kind" ? KIND_MESSAGES[inputType] : TABLE_MESSAGES[rule],
        path,
      });
    }
  });
}

// The message a person reads for each issue an answer or a submission can
// raise, in place of Zod's developer-facing defaults (req-mobile-app REQ-3).
// validateAnswer and validateAnswerSubmission pass it to each parse. It is
// never installed with z.config(), so every other schema, and these schemas
// parsed anywhere else, keep their own messages. An issue that carries its
// own message, such as an answer table issue, keeps it.
const answerErrorMap: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "unrecognized_keys") {
    return "Remove the extra details from this answer.";
  }
  const path = issue.path ?? [];
  const field = [...path].reverse().find((part) => typeof part === "string");
  switch (field) {
    case "option_id":
      return issue.input === undefined ? "Choose an option." : "Choose an option from the list.";
    case "option_ids":
      // A malformed entry sits at an index below option_ids.
      return typeof path.at(-1) === "number"
        ? "Choose an option from the list."
        : "Choose at least one option.";
    case "text":
      return issue.code === "too_big"
        ? "Keep your answer to 4,000 characters or fewer."
        : "Enter an answer.";
    case "note":
      return issue.code === "too_big"
        ? "Keep your note to 2,000 characters or fewer."
        : "Write the note as text.";
    default:
      return "Choose an answer.";
  }
};

export function validateAnswer(
  inputType: InputType,
  options: readonly Option[] | undefined,
  answer: unknown,
): z.ZodSafeParseResult<Answer> {
  return answerSchemaFor(inputType, options).safeParse(answer, { error: answerErrorMap });
}

// An answer as the user submits it, with an optional note
// (req-decision-requests AC-2.5). Validate `answer` against the decision with
// validateAnswer.
export const answerSubmissionSchema = z.object({
  answer: answerSchema,
  note: z.string().max(2000).optional(),
});
export type AnswerSubmission = z.infer<typeof answerSubmissionSchema>;

// Parses a submission with the messages a person reads. It checks the note
// and the answer's shape; validateAnswer checks the answer against the
// decision.
export function validateAnswerSubmission(
  submission: unknown,
): z.ZodSafeParseResult<AnswerSubmission> {
  return answerSubmissionSchema.safeParse(submission, { error: answerErrorMap });
}
