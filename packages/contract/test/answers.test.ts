import { describe, expect, test } from "vitest";
import {
  type Answer,
  answerSchema,
  answerSubmissionSchema,
  type InputType,
  type Option,
  validateAnswer,
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
