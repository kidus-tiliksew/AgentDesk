import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  answerSubmissionSchema,
  chatMessageSchema,
  decisionInputFieldsSchema,
  decisionInputSchema,
  type InputType,
  resolveInputSchema,
  validateDecisionInput,
} from "../src/index.js";

// component-contract §Decision input and answers; req-decision-requests
// REQ-1, AC-2.1, AC-3.1, AC-5.3. Every case passes `now` explicitly.
const NOW = Date.parse("2026-01-01T00:00:00Z");
const LATER = "2026-01-01T00:00:01Z";

const OPTIONS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
];

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "Ship it?", input_type: "approve_reject", topic: "repo/feature", ...overrides };
}

function choice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({ input_type: "single_choice", options: OPTIONS, ...overrides });
}

function options(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
}

function paths(input: unknown, now = NOW) {
  const result = validateDecisionInput(input, now);
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

function accepts(input: unknown, now = NOW) {
  return validateDecisionInput(input, now).success;
}

describe("minimal input", () => {
  test("accepts title, input type, and topic, and defaults priority to normal", () => {
    const result = validateDecisionInput(base(), NOW);
    expect(result.success).toBe(true);
    expect(result.data?.priority).toBe("normal");
  });

  test.each(["title", "input_type", "topic"])("rejects input without %s", (field) => {
    const input = base();
    delete input[field];
    expect(paths(input)).toEqual([[field]]);
  });
});

describe("field rules", () => {
  test.each([
    ["title", 0, false],
    ["title", 1, true],
    ["title", 120, true],
    ["title", 121, false],
    ["body", 0, true],
    ["body", 16000, true],
    ["body", 16001, false],
    ["idempotency_key", 0, false],
    ["idempotency_key", 1, true],
    ["idempotency_key", 128, true],
    ["idempotency_key", 129, false],
  ])("%s of %i characters is valid: %j", (field, length, valid) => {
    const input = base({ [field]: "x".repeat(length) });
    expect(accepts(input)).toBe(valid);
    if (!valid) expect(paths(input)).toEqual([[field]]);
  });

  test("body is optional", () => {
    expect(accepts(base())).toBe(true);
  });

  test.each([
    "approve_reject",
    "single_choice",
    "multiple_choice",
    "free_text",
    "single_choice_or_text",
  ])("input_type %s is accepted", (inputType) => {
    const needsOptions = inputType.includes("choice");
    expect(
      accepts(base({ input_type: inputType, ...(needsOptions && { options: OPTIONS }) })),
    ).toBe(true);
  });

  test.each(["yes_no", "", "Free_Text"])("input_type %j is rejected", (inputType) => {
    expect(paths(base({ input_type: inputType }))).toEqual([["input_type"]]);
  });

  test("topic is lowercased", () => {
    expect(validateDecisionInput(base({ topic: "Repo/Feature" }), NOW).data?.topic).toBe(
      "repo/feature",
    );
  });

  test.each(["", "x".repeat(101), "a b"])("topic %j is rejected", (topic) => {
    expect(paths(base({ topic }))).toEqual([["topic"]]);
  });

  test.each([
    ["normal", true],
    ["urgent", true],
    ["high", false],
    ["Urgent", false],
  ])("priority %j is valid: %j", (priority, valid) => {
    expect(accepts(base({ priority }))).toBe(valid);
  });

  test.each([
    ["decision-123", true],
    ["", true],
    [42, false],
    [null, false],
  ])("parent_id %j is valid: %j", (parentId, valid) => {
    expect(accepts(base({ parent_id: parentId }))).toBe(valid);
  });
});

describe("options", () => {
  test.each([
    [1, false],
    [2, true],
    [10, true],
    [11, false],
  ])("%i options are valid: %j", (count, valid) => {
    expect(accepts(choice({ options: options(count) }))).toBe(valid);
  });

  test.each([
    [0, false],
    [1, true],
    [80, true],
    [81, false],
  ])("an option label of %i characters is valid: %j", (length, valid) => {
    const input = choice({ options: [{ id: "a", label: "x".repeat(length) }, OPTIONS[1]] });
    expect(accepts(input)).toBe(valid);
    if (!valid) expect(paths(input)).toEqual([["options", 0, "label"]]);
  });

  test.each(["single_choice", "multiple_choice", "single_choice_or_text"])(
    "%s requires options",
    (inputType) => {
      expect(paths(base({ input_type: inputType }))).toEqual([["options"]]);
    },
  );

  test.each(["approve_reject", "free_text"])("%s forbids options", (inputType) => {
    expect(paths(base({ input_type: inputType, options: OPTIONS }))).toEqual([["options"]]);
  });

  test("option ids are unique", () => {
    const input = choice({
      options: [
        { id: "a", label: "First" },
        { id: "b", label: "Second" },
        { id: "a", label: "Third" },
      ],
    });
    expect(paths(input)).toEqual([["options", 2, "id"]]);
  });

  test.each([{ id: "a" }, { label: "Alpha" }, { id: 1, label: "One" }])(
    "a malformed option %j is rejected",
    (option) => {
      expect(accepts(choice({ options: [option, OPTIONS[1]] }))).toBe(false);
    },
  );
});

describe("deadline", () => {
  test.each([
    ["one second after now", "2026-01-01T00:00:01Z", true],
    ["with milliseconds", "2026-01-01T00:00:00.001Z", true],
    ["with an offset", "2026-01-01T01:00:01+01:00", true],
    ["equal to now", "2026-01-01T00:00:00Z", false],
    ["equal to now with an offset", "2026-01-01T01:00:00+01:00", false],
    ["in the past", "2025-12-31T23:59:59Z", false],
  ])("a deadline %s is valid: %j", (_name, deadline, valid) => {
    const input = base({ deadline });
    expect(accepts(input)).toBe(valid);
    if (!valid) expect(paths(input)).toEqual([["deadline"]]);
  });

  test.each([
    "2026-06-01",
    "2025-06-01",
    "2026-06-01T00:00:00",
    "2026-06-01T00:00Z",
    "tomorrow",
    "1767225601000",
    1767225601000,
  ])("a deadline %j that is not an ISO 8601 instant is rejected", (deadline) => {
    expect(paths(base({ deadline }))).toEqual([["deadline"]]);
  });

  test("the result depends only on the now argument", () => {
    const input = base({ deadline: "2030-01-01T00:00:00Z" });
    const before = Date.parse("2029-12-31T23:59:59Z");
    const after = Date.parse("2030-01-01T00:00:00Z");
    expect(accepts(input, before)).toBe(true);
    expect(accepts(input, after)).toBe(false);
    expect(accepts(input, before)).toBe(true);
    expect(decisionInputSchema(before).safeParse(input).success).toBe(true);
    expect(decisionInputSchema(after).safeParse(input).success).toBe(false);
  });
});

describe("default", () => {
  test("requires a deadline", () => {
    expect(paths(base({ default: { kind: "approve" } }))).toEqual([["default"]]);
  });

  test("is accepted with a future deadline", () => {
    expect(accepts(base({ default: { kind: "reject" }, deadline: LATER }))).toBe(true);
  });
});

// The recommendation and the default use the answer table
// (req-decision-requests AC-3.1, AC-5.3).
describe.each(["recommendation", "default"])("%s", (field) => {
  const withDeadline = (input: Record<string, unknown>) => ({ ...input, deadline: LATER });

  test.each<[InputType, unknown, boolean]>([
    ["approve_reject", { kind: "approve" }, true],
    ["approve_reject", { kind: "text", text: "yes" }, false],
    ["single_choice", { kind: "option", option_id: "b" }, true],
    ["single_choice", { kind: "text", text: "b" }, false],
    ["multiple_choice", { kind: "options", option_ids: ["a", "b"] }, true],
    ["multiple_choice", { kind: "option", option_id: "a" }, false],
    ["free_text", { kind: "text", text: "Use B." }, true],
    ["free_text", { kind: "approve" }, false],
    ["single_choice_or_text", { kind: "option", option_id: "a" }, true],
    ["single_choice_or_text", { kind: "text", text: "Neither." }, true],
    ["single_choice_or_text", { kind: "options", option_ids: ["a"] }, false],
  ])("for %s, %j is valid: %j", (inputType, answer, valid) => {
    const input = withDeadline(
      base({
        input_type: inputType,
        ...(inputType.includes("choice") && { options: OPTIONS }),
        [field]: answer,
      }),
    );
    expect(accepts(input)).toBe(valid);
    if (!valid) expect(paths(input)).toEqual([[field, "kind"]]);
  });

  test("an unknown option id is reported on the nested field", () => {
    const input = withDeadline(choice({ [field]: { kind: "option", option_id: "z" } }));
    expect(paths(input)).toEqual([[field, "option_id"]]);
  });

  test("duplicate multiple-choice ids are reported on the nested field", () => {
    const input = withDeadline(
      choice({
        input_type: "multiple_choice",
        [field]: { kind: "options", option_ids: ["a", "a"] },
      }),
    );
    expect(paths(input)).toEqual([[field, "option_ids", 1]]);
  });

  test("a malformed answer is reported on the nested field", () => {
    const input = withDeadline(
      base({ input_type: "free_text", [field]: { kind: "text", text: "" } }),
    );
    expect(paths(input)).toEqual([[field, "text"]]);
  });

  test("a field error and a cross-field error are both reported", () => {
    const input = withDeadline(base({ title: "", [field]: { kind: "text", text: "yes" } }));
    expect(paths(input)).toEqual([["title"], [field, "kind"]]);
  });
});

// component-contract §Decision input and answers, the interactive row
// (req-agent-tools REQ-10, AC-10.1).
describe("interactive", () => {
  test("defaults to false", () => {
    expect(validateDecisionInput(base(), NOW).data?.interactive).toBe(false);
  });

  test.each([true, false])("keeps an explicit %j", (interactive) => {
    expect(validateDecisionInput(base({ interactive }), NOW).data?.interactive).toBe(interactive);
  });

  test.each(["true", 1, null, {}])("refuses the non-boolean %j", (interactive) => {
    expect(paths(base({ interactive }))).toEqual([["interactive"]]);
  });

  test("publishes its description and default in the input JSON Schema", () => {
    // biome-ignore lint/suspicious/noExplicitAny: reading a generated JSON Schema.
    const json = z.toJSONSchema(decisionInputFieldsSchema, { io: "input" }) as any;
    expect(json.properties.interactive).toEqual({
      type: "boolean",
      default: false,
      description: "True when the user may be watching this session and can answer in its chat",
    });
    expect(json.required).not.toContain("interactive");
  });
});

// component-contract §Relayed answers (req-agent-tools REQ-9;
// req-decision-requests AC-8.2).
const MAX_MESSAGE = `  \n${"x".repeat(3993)}\r\n \t`;

describe("chatMessageSchema", () => {
  test("the boundary message is exactly 4,000 characters", () => {
    expect(MAX_MESSAGE).toHaveLength(4000);
  });

  test.each([
    ["one character", "y"],
    ["4,000 characters with surrounding whitespace and line breaks", MAX_MESSAGE],
    ["inner line breaks and repeated spaces", "Use B.\n\n  Then   ship."],
    ["non-ASCII text", "  Oui, vas-y \u2014 d\u00e9ploie.  "],
  ])("returns %s unchanged", (_name, message) => {
    expect(chatMessageSchema.parse(message)).toBe(message);
  });

  test.each([
    ["an empty message", ""],
    ["a whitespace-only message", " \n\t\r\n "],
    ["a 4,001-character message", "x".repeat(4001)],
    ["a 4,001-character message of padded text", ` ${MAX_MESSAGE}`],
    ["a non-string", 42],
    ["null", null],
  ])("refuses %s", (_name, message) => {
    expect(chatMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe("resolveInputSchema", () => {
  const RESOLVE = {
    decision_id: "d1",
    answer: { kind: "approve" },
    chat_message: "yes, ship it",
  };

  function resolvePaths(input: unknown) {
    const result = resolveInputSchema.safeParse(input);
    // An empty message fails both the length and the content check on one
    // field, so the distinct paths are compared.
    const found = result.success ? [] : result.error.issues.map((issue) => issue.path);
    return [...new Map(found.map((path) => [JSON.stringify(path), path])).values()];
  }

  test("accepts a decision id, an answer, and a chat message", () => {
    expect(resolveInputSchema.parse(RESOLVE)).toEqual(RESOLVE);
  });

  test("returns a 4,000-character message with surrounding whitespace unchanged", () => {
    const parsed = resolveInputSchema.parse({ ...RESOLVE, chat_message: MAX_MESSAGE });
    expect(parsed.chat_message).toBe(MAX_MESSAGE);
  });

  test.each(["decision_id", "answer", "chat_message"])("refuses input without %s", (field) => {
    const { [field]: _omitted, ...rest } = RESOLVE as Record<string, unknown>;
    expect(resolvePaths(rest)).toEqual([[field]]);
  });

  test.each([
    ["decision_id", ""],
    ["decision_id", 7],
    ["chat_message", ""],
    ["chat_message", "   \n  "],
    ["chat_message", "x".repeat(4001)],
  ])("refuses %s %j", (field, value) => {
    expect(resolvePaths({ ...RESOLVE, [field]: value })).toEqual([[field]]);
  });

  test.each([
    { kind: "maybe" },
    { kind: "option" },
    { kind: "text", text: "" },
    { kind: "options", option_ids: [] },
    { kind: "approve", note: "extra" },
    "approve",
  ])("refuses the malformed answer %j", (answer) => {
    const issues = resolvePaths({ ...RESOLVE, answer });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((path) => path[0] === "answer")).toBe(true);
  });

  // Shape only: the answer is checked against the decision by
  // component-decisions with validateAnswer, so any well-formed kind passes.
  test.each([
    { kind: "reject" },
    { kind: "option", option_id: "not-an-option-of-any-decision" },
    { kind: "options", option_ids: ["a", "a"] },
    { kind: "text", text: "Neither." },
  ])("accepts the shape-valid answer %j without decision checks", (answer) => {
    expect(resolveInputSchema.safeParse({ ...RESOLVE, answer }).success).toBe(true);
  });

  test("carries no note", () => {
    expect(Object.keys(resolveInputSchema.shape)).toEqual([
      "decision_id",
      "answer",
      "chat_message",
    ]);
    expect(resolveInputSchema.parse({ ...RESOLVE, note: "dropped" })).toEqual(RESOLVE);
  });
});

// No other contract input accepts a chat message (req-agent-tools AC-7.3).
describe("chat message placement", () => {
  test("the decision input drops a chat_message", () => {
    const parsed = validateDecisionInput(base({ chat_message: "yes" }), NOW);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("chat_message");
  });

  test("an answer submission drops a chat_message", () => {
    const parsed = answerSubmissionSchema.parse({
      answer: { kind: "approve" },
      chat_message: "yes",
    });
    expect(parsed).toEqual({ answer: { kind: "approve" } });
  });
});
