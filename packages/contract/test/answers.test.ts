import { describe, expect, test } from "vitest";
import {
  type Answer,
  answerSchema,
  answerSubmissionSchema,
  type InputType,
  type Option,
  validateAnswer,
  validateAnswerSubmission,
  validateDecisionInput,
} from "../src/index.js";

const OPTIONS: Option[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

const ONE_OF_EACH_KIND: Record<Answer["kind"], Answer> = {
  approve: { kind: "approve" },
  reject: { kind: "reject" },
  option: { kind: "option", option_id: "a" },
  options: { kind: "options", option_ids: ["a", "b"] },
  text: { kind: "text", text: "Use the second approach." },
};

// component-contract answer table; req-decision-requests AC-2.2.
const VALID_KINDS: Record<InputType, Answer["kind"][]> = {
  approve_reject: ["approve", "reject"],
  single_choice: ["option"],
  multiple_choice: ["options"],
  free_text: ["text"],
  single_choice_or_text: ["option", "text"],
};

const ROWS = Object.entries(VALID_KINDS).flatMap(([inputType, valid]) =>
  Object.values(ONE_OF_EACH_KIND).map(
    (answer) => [inputType as InputType, answer, valid.includes(answer.kind)] as const,
  ),
);

describe("validateAnswer answer table", () => {
  test.each(ROWS)("%s with %j is valid: %j", (inputType, answer, valid) => {
    const result = validateAnswer(inputType, OPTIONS, answer);
    expect(result.success).toBe(valid);
    if (result.success) {
      expect(result.data).toEqual(answer);
    } else {
      expect(result.error.issues[0]?.path).toEqual(["kind"]);
    }
  });
});

describe("validateAnswer option ids", () => {
  test.each(["single_choice", "single_choice_or_text"] as const)(
    "%s rejects an unknown option id",
    (inputType) => {
      const result = validateAnswer(inputType, OPTIONS, { kind: "option", option_id: "z" });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([["option_id"]]);
    },
  );

  test.each([
    [["a"], true],
    [["a", "b", "c"], true],
    [["c", "a"], true],
    [[], false],
    [["a", "a"], false],
    [["a", "z"], false],
  ])("multiple_choice with option_ids %j is valid: %j", (ids, valid) => {
    const result = validateAnswer("multiple_choice", OPTIONS, { kind: "options", option_ids: ids });
    expect(result.success).toBe(valid);
  });

  test("multiple_choice names the duplicate and unknown positions", () => {
    const result = validateAnswer("multiple_choice", OPTIONS, {
      kind: "options",
      option_ids: ["a", "a", "z"],
    });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["option_ids", 1],
      ["option_ids", 2],
    ]);
  });

  test("a choice answer without options names no existing id", () => {
    expect(validateAnswer("single_choice", undefined, ONE_OF_EACH_KIND.option).success).toBe(false);
  });
});

describe("answer structure", () => {
  test.each([
    [0, false],
    [1, true],
    [4000, true],
    [4001, false],
  ])("text of %i characters is valid: %j", (length, valid) => {
    const answer = { kind: "text", text: "x".repeat(length) };
    expect(validateAnswer("free_text", undefined, answer).success).toBe(valid);
    expect(answerSchema.safeParse(answer).success).toBe(valid);
  });

  test("text over 4,000 characters is reported on the text field", () => {
    const result = validateAnswer("free_text", undefined, { kind: "text", text: "x".repeat(4001) });
    expect(result.error?.issues[0]?.path).toEqual(["text"]);
  });

  // req-decision-requests AC-2.4: an option or text, never both.
  test.each([
    { kind: "option", option_id: "a", text: "also text" },
    { kind: "text", text: "text", option_id: "a" },
    { kind: "options", option_ids: ["a"], option_id: "b" },
    { kind: "approve", text: "why" },
  ])("rejects mixed payload %j", (answer) => {
    expect(validateAnswer("single_choice_or_text", OPTIONS, answer).success).toBe(false);
  });

  test.each([
    {},
    { kind: "maybe" },
    { kind: "option" },
    { kind: "options", option_ids: "a" },
    { kind: "text" },
    "approve",
    null,
  ])("rejects malformed answer %j", (answer) => {
    expect(validateAnswer("approve_reject", OPTIONS, answer).success).toBe(false);
  });
});

// req-decision-requests AC-2.5.
describe("answer submission", () => {
  test.each([
    [undefined, true],
    [0, true],
    [2000, true],
    [2001, false],
  ])("note of %j characters is valid: %j", (length, valid) => {
    const submission =
      length === undefined
        ? { answer: { kind: "approve" } }
        : { answer: { kind: "approve" }, note: "n".repeat(length) };
    const result = answerSubmissionSchema.safeParse(submission);
    expect(result.success).toBe(valid);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["note"]);
    }
  });

  test("requires an answer", () => {
    expect(answerSubmissionSchema.safeParse({ note: "hi" }).success).toBe(false);
  });
});

// Every message validateAnswer and validateAnswerSubmission raise is written
// for the person answering (req-mobile-app REQ-3): one sentence, with no Zod
// default text, schema syntax, type names, or field identifiers.
const DEVELOPER_TEXT =
  /invalid input|expected|received|too small|too big|unrecognized|discriminator|>=|<=|option_ids?|input type|\bkind\b|string|array|object|undefined|null/i;

// A case's input for a test name, cut short so an over-limit text stays legible.
function brief(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function expectHuman(messages: string[]) {
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message).not.toMatch(DEVELOPER_TEXT);
    expect(message).toMatch(/^[A-Z][^.]*\.$/);
  }
}

describe("validateAnswer messages", () => {
  const cases = [
    ["single_choice", null, ["Choose an answer."]],
    ["single_choice", undefined, ["Choose an answer."]],
    ["approve_reject", "approve", ["Choose an answer."]],
    ["approve_reject", 7, ["Choose an answer."]],
    ["approve_reject", [], ["Choose an answer."]],
    ["approve_reject", {}, ["Choose an answer."]],
    ["approve_reject", { kind: "maybe" }, ["Choose an answer."]],
    ["approve_reject", { kind: 3 }, ["Choose an answer."]],
    ["single_choice", { kind: "option" }, ["Choose an option."]],
    ["single_choice", { kind: "option", option_id: 3 }, ["Choose an option from the list."]],
    ["single_choice", { kind: "option", option_id: "z" }, ["Choose an option from the list."]],
    [
      "single_choice_or_text",
      { kind: "option", option_id: "z" },
      ["Choose an option from the list."],
    ],
    ["multiple_choice", { kind: "options" }, ["Choose at least one option."]],
    ["multiple_choice", { kind: "options", option_ids: "a" }, ["Choose at least one option."]],
    ["multiple_choice", { kind: "options", option_ids: [] }, ["Choose at least one option."]],
    ["multiple_choice", { kind: "options", option_ids: [1] }, ["Choose an option from the list."]],
    [
      "multiple_choice",
      { kind: "options", option_ids: ["a", "a", "z"] },
      ["Choose each option only once.", "Choose an option from the list."],
    ],
    ["free_text", { kind: "text" }, ["Enter an answer."]],
    ["free_text", { kind: "text", text: 5 }, ["Enter an answer."]],
    ["free_text", { kind: "text", text: "" }, ["Enter an answer."]],
    [
      "free_text",
      { kind: "text", text: "x".repeat(4001) },
      ["Keep your answer to 4,000 characters or fewer."],
    ],
    ["single_choice_or_text", { kind: "text", text: "" }, ["Enter an answer."]],
    [
      "single_choice_or_text",
      { kind: "option", option_id: "a", text: "also text" },
      ["Remove the extra details from this answer."],
    ],
    [
      "approve_reject",
      { kind: "approve", text: "why" },
      ["Remove the extra details from this answer."],
    ],
    ["approve_reject", { kind: "text", text: "yes" }, ["Approve or reject this decision."]],
    ["single_choice", { kind: "approve" }, ["Choose one option."]],
    ["multiple_choice", { kind: "option", option_id: "a" }, ["Choose one or more options."]],
    ["free_text", { kind: "reject" }, ["Enter a text answer."]],
    [
      "single_choice_or_text",
      { kind: "options", option_ids: ["a"] },
      ["Choose one option or enter a text answer."],
    ],
  ] as const;
  test.each(
    cases.map(
      ([inputType, answer, messages]) => [inputType, brief(answer), messages, answer] as const,
    ),
  )("%s with %s reads %j", (inputType, _name, messages, answer) => {
    const result = validateAnswer(inputType, OPTIONS, answer);
    expect(result.success).toBe(false);
    const actual = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(actual).toEqual(messages);
    expectHuman(actual);
  });

  test("keeps each issue on the field it names", () => {
    const result = validateAnswer("multiple_choice", OPTIONS, {
      kind: "options",
      option_ids: ["a", "a", "z"],
    });
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["option_ids", 1], "Choose each option only once."],
      [["option_ids", 2], "Choose an option from the list."],
    ]);
  });

  test("every answer table row that fails reads as a person would", () => {
    for (const [inputType, answer, valid] of ROWS) {
      const result = validateAnswer(inputType, OPTIONS, answer);
      if (!valid) {
        expectHuman(result.error?.issues.map((issue) => issue.message) ?? []);
      }
    }
  });
});

describe("validateAnswerSubmission", () => {
  const cases = [
    [null, ["Choose an answer."]],
    [{}, ["Choose an answer."]],
    [{ note: "hi" }, ["Choose an answer."]],
    [{ answer: null }, ["Choose an answer."]],
    [{ answer: { kind: "text", text: "" } }, ["Enter an answer."]],
    [{ answer: { kind: "approve" }, note: 5 }, ["Write the note as text."]],
    [
      { answer: { kind: "approve" }, note: "n".repeat(2001) },
      ["Keep your note to 2,000 characters or fewer."],
    ],
  ] as const;
  test.each(
    cases.map(([submission, messages]) => [brief(submission), messages, submission] as const),
  )("%s reads %j", (_name, messages, submission) => {
    const result = validateAnswerSubmission(submission);
    expect(result.success).toBe(false);
    const actual = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(actual).toEqual(messages);
    expectHuman(actual);
  });

  test("accepts what answerSubmissionSchema accepts", () => {
    for (const submission of [
      { answer: { kind: "approve" } },
      { answer: { kind: "text", text: " " }, note: "" },
      { answer: { kind: "reject" }, note: "n".repeat(2000) },
    ]) {
      expect(validateAnswerSubmission(submission)).toEqual(
        answerSubmissionSchema.safeParse(submission),
      );
    }
  });
});

// The person-facing messages are scoped to validateAnswer and
// validateAnswerSubmission; agent-facing parses keep theirs.
describe("messages outside the answer validators", () => {
  test("the bare schemas keep their own messages", () => {
    expect(answerSchema.safeParse(null).error?.issues[0]?.message).toMatch(/expected object/);
    expect(
      answerSubmissionSchema.safeParse({ answer: { kind: "approve" }, note: "n".repeat(2001) })
        .error?.issues[0]?.message,
    ).toMatch(/<=2000/);
  });

  test("decision creation keeps the answer table's field names", () => {
    const result = validateDecisionInput(
      {
        title: "Pick one",
        topic: "repo/feature",
        input_type: "single_choice",
        options: OPTIONS,
        recommendation: { kind: "option", option_id: "z" },
      },
      0,
    );
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toContainEqual([
      ["recommendation", "option_id"],
      "option_id names no option",
    ]);
  });
});
