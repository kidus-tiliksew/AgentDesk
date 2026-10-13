import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Nodes, PhrasingContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import semver from "semver";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// component-agent-skill §Verification. The checks parse
// packages/skill/agentdesk/SKILL.md and judge it against the gateway's tool
// declaration, so a renamed or added tool fails here instead of leaving a
// stale list behind.

const SKILL_PATH = fileURLToPath(new URL("../agentdesk/SKILL.md", import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const GATEWAY_TOOLS_PATH = fileURLToPath(
  new URL("../../../apps/gateway/src/tools.ts", import.meta.url),
);

const SECTIONS = ["Topic", "When to ask", "How to ask", "Waiting", "Status"] as const;

// The body stays under 120 lines: 119 passes and 120 fails.
const MAX_BODY_LINES = 119;

const EXPECTED_TOOL_COUNT = 6;

// Identifiers the skill may write as standalone inline code without naming a
// tool: the gateway's argument and result fields, the topic environment
// variable, and the enumerated input-type, answer-kind, decision-state,
// status-state, and priority values. Any other standalone identifier in
// inline code must be a tool name.
const SCHEMA_FIELDS = [
  "title",
  "body",
  "input_type",
  "options",
  "topic",
  "priority",
  "recommendation",
  "deadline",
  "default",
  "parent_id",
  "idempotency_key",
  "decision_id",
  "decision_ids",
  "timeout_seconds",
  "state",
  "line",
  "link",
  "display_name",
  "answer",
  "note",
  "applied_by_default",
  "answered_via",
  "kind",
  "option_id",
  "option_ids",
  "text",
  "id",
  "label",
];
const ENVIRONMENT_IDENTIFIERS = ["AGENTDESK_TOPIC"];
const ENUM_VALUES = [
  "approve_reject",
  "single_choice",
  "multiple_choice",
  "free_text",
  "single_choice_or_text",
  "approve",
  "reject",
  "option",
  "options",
  "text",
  "pending",
  "answered",
  "expired",
  "cancelled",
  "working",
  "waiting",
  "blocked",
  "done",
  "normal",
  "urgent",
];
const NON_TOOL_IDENTIFIERS = new Set([
  ...SCHEMA_FIELDS,
  ...ENVIRONMENT_IDENTIFIERS,
  ...ENUM_VALUES,
]);

// English function words that may follow "call" or precede "tool" in prose,
// as in "call it again" or "the tool". They are never tool names.
const FUNCTION_WORDS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "each",
  "every",
  "any",
  "another",
  "other",
  "same",
  "one",
  "it",
  "them",
  "again",
  "back",
  "once",
  "only",
  "then",
  "your",
  "its",
  "their",
  "to",
  "with",
  "for",
  "and",
  "or",
]);

// Fenced languages whose content is shell commands, where `name(` is shell
// syntax rather than a tool call.
const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh", "console"]);

const IDENTIFIER = /^[A-Za-z_][\w-]*$/;
const PROSE_CALL = /\bcall(?:s|ing)?\s+`?([A-Za-z_][\w-]*)`?/gi;
const PROSE_TOOL = /`?([A-Za-z_][\w-]*)`?\s+tool\b/g;
const CODE_CALL = /(?<![\w$])([A-Za-z_][\w]*)\s*\(/g;
const CODE_SELECTOR = /(?<![\w-])["']?(?:tool|name)["']?\s*[:=]\s*["'`]?([A-Za-z_][\w-]*)/g;

// Reads the `name` of every element of the TOOLS array literal in the
// gateway source with the TypeScript parser. Nothing is executed, so no Worker
// global or service is needed.
function extractToolNames(source: string): string[] {
  const file = ts.createSourceFile("tools.ts", source, ts.ScriptTarget.ES2022, true);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "TOOLS"
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (declarations.length !== 1) {
    throw new Error(`expected one TOOLS declaration, found ${declarations.length}`);
  }
  let initializer = declarations[0]?.initializer;
  while (
    initializer !== undefined &&
    (ts.isAsExpression(initializer) ||
      ts.isSatisfiesExpression(initializer) ||
      ts.isParenthesizedExpression(initializer))
  ) {
    initializer = initializer.expression;
  }
  if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error("TOOLS is not initialized with an array literal");
  }
  const names = initializer.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`TOOLS[${index}] is not an object literal`);
    }
    const properties = element.properties.filter(
      (property) =>
        property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "name",
    );
    const property = properties[0];
    if (properties.length !== 1 || property === undefined) {
      throw new Error(`TOOLS[${index}] has ${properties.length} name properties`);
    }
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
      throw new Error(`TOOLS[${index}].name is not a string literal`);
    }
    return property.initializer.text;
  });
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`TOOLS declares duplicate names: ${duplicates.join(", ")}`);
  }
  if (names.length !== EXPECTED_TOOL_COUNT) {
    throw new Error(`TOOLS declares ${names.length} tools, expected ${EXPECTED_TOOL_COUNT}`);
  }
  return names;
}

interface SplitSkill {
  frontmatter: string;
  body: string;
}

// Normalizes line endings and splits the YAML frontmatter from the body.
function splitSkill(raw: string): SplitSkill | null {
  const text = raw.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (match === null) {
    return null;
  }
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

// The number of body lines, disregarding only the final newline.
function bodyLineCount(body: string): number {
  if (body === "") {
    return 0;
  }
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  return trimmed.split("\n").length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Renders phrasing content as prose, keeping inline code in backticks.
function prose(children: readonly PhrasingContent[]): string {
  return children
    .map((child) => {
      if (child.type === "text") {
        return child.value;
      }
      if (child.type === "inlineCode") {
        return `\`${child.value}\``;
      }
      if ("children" in child) {
        return prose(child.children);
      }
      return " ";
    })
    .join("");
}

function headingText(children: readonly PhrasingContent[]): string {
  return prose(children).replaceAll("`", "").trim();
}

function validateFrontmatter(frontmatter: string): string[] {
  let data: unknown;
  try {
    data = parseYaml(frontmatter);
  } catch (caught) {
    return [`frontmatter is not valid YAML: ${(caught as Error).message}`];
  }
  if (!isRecord(data)) {
    return ["frontmatter is not a mapping"];
  }
  const problems: string[] = [];
  if (data.name !== "agentdesk") {
    problems.push('frontmatter name must be "agentdesk"');
  }
  if (typeof data.description !== "string" || data.description.trim() === "") {
    problems.push("frontmatter description must be a nonempty string");
  }
  const version = isRecord(data.metadata) ? data.metadata.version : undefined;
  if (version === undefined) {
    problems.push("frontmatter metadata.version is missing");
  } else if (typeof version !== "string") {
    problems.push("frontmatter metadata.version must be a string");
  } else if (!isStrictSemver(version)) {
    problems.push(`frontmatter metadata.version "${version}" is not semver`);
  }
  return problems;
}

// True when the string is exactly a semver version, with no `v` prefix,
// surrounding space, or other loose form. Build metadata is kept.
function isStrictSemver(version: string): boolean {
  const parsed = semver.parse(version);
  if (parsed === null) {
    return false;
  }
  const build = parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "";
  return `${parsed.version}${build}` === version;
}

function validateSections(headings: readonly string[]): string[] {
  const problems: string[] = [];
  for (const section of SECTIONS) {
    const count = headings.filter((heading) => heading === section).length;
    if (count === 0) {
      problems.push(`missing section "${section}"`);
    } else if (count > 1) {
      problems.push(`section "${section}" appears ${count} times`);
    }
  }
  for (const heading of headings) {
    if (!(SECTIONS as readonly string[]).includes(heading)) {
      problems.push(`unexpected section "${heading}"`);
    }
  }
  if (problems.length === 0 && headings.join("\n") !== SECTIONS.join("\n")) {
    problems.push(`sections must appear in the order ${SECTIONS.join(", ")}`);
  }
  return problems;
}

function checkCandidate(
  candidate: string,
  tools: ReadonlySet<string>,
  form: string,
  problems: string[],
): void {
  if (!tools.has(candidate) && !FUNCTION_WORDS.has(candidate.toLowerCase())) {
    problems.push(`unknown tool "${candidate}" in ${form}`);
  }
}

function scanCode(
  value: string,
  language: string,
  form: string,
  tools: ReadonlySet<string>,
  problems: string[],
): void {
  for (const match of value.matchAll(CODE_SELECTOR)) {
    const candidate = match[1] ?? "";
    if (!tools.has(candidate)) {
      problems.push(`unknown tool "${candidate}" in ${form} selector`);
    }
  }
  if (SHELL_LANGUAGES.has(language)) {
    return;
  }
  for (const match of value.matchAll(CODE_CALL)) {
    const candidate = match[1] ?? "";
    if (!tools.has(candidate)) {
      problems.push(`unknown tool "${candidate}" in ${form} call`);
    }
  }
}

// Checks every tool-like mention in the Markdown body: standalone identifiers
// in inline code, "call NAME" and "NAME tool" in prose, and calls or
// tool/name selectors in inline and fenced code.
function validateToolMentions(root: Nodes, tools: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === "inlineCode") {
      const value = node.value.trim();
      if (IDENTIFIER.test(value)) {
        if (!tools.has(value) && !NON_TOOL_IDENTIFIERS.has(value)) {
          problems.push(`unknown tool "${value}" in inline code`);
        }
      } else {
        scanCode(value, "", "inline code", tools, problems);
      }
      return;
    }
    if (node.type === "code") {
      scanCode(node.value, (node.lang ?? "").toLowerCase(), "fenced code", tools, problems);
      return;
    }
    if (node.type === "paragraph" || node.type === "heading") {
      const text = prose(node.children);
      for (const match of text.matchAll(PROSE_CALL)) {
        checkCandidate(match[1] ?? "", tools, 'prose "call NAME"', problems);
      }
      for (const match of text.matchAll(PROSE_TOOL)) {
        checkCandidate(match[1] ?? "", tools, 'prose "NAME tool"', problems);
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(root);
  return problems;
}

// Returns every problem with a SKILL.md text; an empty list means it passes.
function validateSkill(raw: string, toolNames: readonly string[]): string[] {
  const split = splitSkill(raw);
  if (split === null) {
    return ["missing YAML frontmatter delimited by --- lines"];
  }
  const problems = validateFrontmatter(split.frontmatter);
  const lines = bodyLineCount(split.body);
  if (lines > MAX_BODY_LINES) {
    problems.push(`body has ${lines} lines; the limit is ${MAX_BODY_LINES}`);
  }
  const root = fromMarkdown(split.body);
  const headings = root.children.flatMap((node) =>
    node.type === "heading" && node.depth === 2 ? [headingText(node.children)] : [],
  );
  problems.push(...validateSections(headings));
  problems.push(...validateToolMentions(root, new Set(toolNames)));
  return problems;
}

const TOOL_NAMES = extractToolNames(readFileSync(GATEWAY_TOOLS_PATH, "utf8"));

const VALID_FIXTURE = [
  "---",
  "name: agentdesk",
  "description: Use when a choice needs the user.",
  "metadata:",
  '  version: "1.0.0"',
  "---",
  "",
  "# AgentDesk",
  "",
  "## Topic",
  "",
  "Run `git remote get-url origin`. Use `AGENTDESK_TOPIC` when it is set.",
  "",
  "## When to ask",
  "",
  "Ask only for irreversible actions.",
  "",
  "## How to ask",
  "",
  "Call `ask` with a `topic` and a `recommendation`.",
  "",
  "## Waiting",
  "",
  "Call `await` with the same `decision_id`. When it returns `pending`, call it again.",
  "",
  "## Status",
  "",
  "Call the `status` tool with `state` set to `working`.",
  "",
].join("\n");

function withBodyLines(fixture: string, target: number): string {
  const split = splitSkill(fixture);
  if (split === null) {
    throw new Error("fixture has no frontmatter");
  }
  const padding = target - bodyLineCount(split.body);
  if (padding < 0) {
    throw new Error("fixture body is already longer than the target");
  }
  return `---\n${split.frontmatter}\n---\n${split.body}${"Padding line.\n".repeat(padding)}`;
}

function replaceLine(fixture: string, from: string, to: string): string {
  if (!fixture.includes(from)) {
    throw new Error(`fixture does not contain ${from}`);
  }
  return fixture.replace(from, to);
}

function withBody(extra: string): string {
  return `${VALID_FIXTURE}\n${extra}\n`;
}

describe("gateway tool names", () => {
  it("reads the six tools from the gateway TOOLS declaration", () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      "ask",
      "await",
      "cancel",
      "check",
      "resolve",
      "status",
    ]);
  });

  it.each([
    ["no TOOLS declaration", "const OTHER = [];", /expected one TOOLS declaration/],
    ["a non-array initializer", "const TOOLS = makeTools();", /not initialized with an array/],
    [
      "a spread element",
      'const TOOLS = [...more, { name: "ask" }];',
      /TOOLS\[0\] is not an object literal/,
    ],
    ["a computed name", "const TOOLS = [{ name: NAME }];", /TOOLS\[0\]\.name is not a string/],
    ["a missing name", 'const TOOLS = [{ title: "ask" }];', /TOOLS\[0\] has 0 name properties/],
    [
      "a duplicate name",
      'const TOOLS = [{ name: "ask" }, { name: "ask" }, { name: "await" }, { name: "check" }, { name: "resolve" }, { name: "status" }];',
      /duplicate names: ask/,
    ],
    [
      "five tools",
      'const TOOLS = [{ name: "ask" }, { name: "await" }, { name: "check" }, { name: "cancel" }, { name: "status" }];',
      /declares 5 tools, expected 6/,
    ],
  ])("fails visibly on %s", (_label, source, message) => {
    expect(() => extractToolNames(source)).toThrow(message);
  });

  it("accepts a typed array literal of six string names", () => {
    const source = `const TOOLS: Tool[] = [${[
      "ask",
      "await",
      "check",
      "cancel",
      "resolve",
      "status",
    ]
      .map((name) => `{ name: "${name}", run() {} }`)
      .join(", ")}];`;
    expect(extractToolNames(source)).toEqual([
      "ask",
      "await",
      "check",
      "cancel",
      "resolve",
      "status",
    ]);
  });
});

describe("delivered SKILL.md", () => {
  const raw = readFileSync(SKILL_PATH, "utf8");

  it("passes every check", () => {
    expect(validateSkill(raw, TOOL_NAMES)).toEqual([]);
  });

  it("keeps the body under 120 lines", () => {
    const split = splitSkill(raw);
    expect(split).not.toBeNull();
    expect(bodyLineCount(split?.body ?? "")).toBeLessThan(120);
  });

  it("names every tool in inline code", () => {
    for (const name of TOOL_NAMES) {
      expect(raw).toContain(`\`${name}\``);
    }
  });
});

describe("package export", () => {
  it("resolves @agentdesk/skill/agentdesk/SKILL.md to the skill file", () => {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@agentdesk/skill/agentdesk/SKILL.md");
    expect(realpathSync(resolved)).toBe(realpathSync(SKILL_PATH));
    const split = splitSkill(readFileSync(resolved, "utf8"));
    const data: unknown = parseYaml(split?.frontmatter ?? "");
    const version = isRecord(data) && isRecord(data.metadata) ? data.metadata.version : undefined;
    expect(version).toBe("1.0.0");
  });

  it("is private, ships the file, and has no runtime dependencies", () => {
    const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    expect(isRecord(pkg)).toBe(true);
    if (!isRecord(pkg)) {
      return;
    }
    expect(pkg.name).toBe("@agentdesk/skill");
    expect(pkg.private).toBe(true);
    expect(pkg.exports).toEqual({ "./agentdesk/SKILL.md": "./agentdesk/SKILL.md" });
    expect(pkg.files).toEqual(["agentdesk/SKILL.md"]);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });
});

describe("validator fixtures", () => {
  it("accepts the valid fixture", () => {
    expect(validateSkill(VALID_FIXTURE, TOOL_NAMES)).toEqual([]);
  });

  it("accepts CRLF line endings", () => {
    expect(validateSkill(VALID_FIXTURE.replaceAll("\n", "\r\n"), TOOL_NAMES)).toEqual([]);
  });

  it("counts body lines without the frontmatter or the final newline", () => {
    expect(bodyLineCount("one\ntwo\n")).toBe(2);
    expect(bodyLineCount("one\ntwo")).toBe(2);
    expect(bodyLineCount("one\r\ntwo\r\n".replace(/\r\n/g, "\n"))).toBe(2);
    expect(bodyLineCount("")).toBe(0);
  });

  it("accepts a 119-line body", () => {
    expect(validateSkill(withBodyLines(VALID_FIXTURE, 119), TOOL_NAMES)).toEqual([]);
  });

  it("rejects a 120-line body", () => {
    expect(validateSkill(withBodyLines(VALID_FIXTURE, 120), TOOL_NAMES)).toEqual([
      "body has 120 lines; the limit is 119",
    ]);
  });

  it("rejects a 120-line body written with CRLF line endings", () => {
    const fixture = withBodyLines(VALID_FIXTURE, 120).replaceAll("\n", "\r\n");
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual(["body has 120 lines; the limit is 119"]);
  });

  it.each(SECTIONS.map((section) => [section]))("rejects a missing %s section", (section) => {
    const fixture = replaceLine(VALID_FIXTURE, `## ${section}\n`, `${section}\n`);
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual([`missing section "${section}"`]);
  });

  it("does not count a heading inside a fenced example", () => {
    const fixture = replaceLine(VALID_FIXTURE, "## Status\n", "```md\n## Status\n```\n");
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual(['missing section "Status"']);
  });

  it("accepts a section heading repeated inside a fenced example", () => {
    expect(validateSkill(withBody("```md\n## Topic\n```"), TOOL_NAMES)).toEqual([]);
  });

  it("recognizes setext and inline-formatted headings", () => {
    const fixture = replaceLine(VALID_FIXTURE, "## Waiting\n", "*Waiting*\n---\n");
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual([]);
  });

  it("rejects an extra or duplicated section", () => {
    expect(validateSkill(withBody("## Notes"), TOOL_NAMES)).toEqual(['unexpected section "Notes"']);
    expect(validateSkill(withBody("## Status"), TOOL_NAMES)).toEqual([
      'section "Status" appears 2 times',
    ]);
  });

  it("rejects sections out of order", () => {
    const fixture = replaceLine(
      replaceLine(VALID_FIXTURE, "## Topic\n", "## TEMP\n"),
      "## Status\n",
      "## Topic\n",
    ).replace("## TEMP\n", "## Status\n");
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual([
      "sections must appear in the order Topic, When to ask, How to ask, Waiting, Status",
    ]);
  });

  it("rejects missing frontmatter", () => {
    expect(validateSkill("## Topic\n", TOOL_NAMES)).toEqual([
      "missing YAML frontmatter delimited by --- lines",
    ]);
  });

  it("rejects a missing version", () => {
    const fixture = replaceLine(VALID_FIXTURE, 'metadata:\n  version: "1.0.0"\n', "");
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual(["frontmatter metadata.version is missing"]);
    const empty = replaceLine(VALID_FIXTURE, '  version: "1.0.0"\n', "  other: x\n");
    expect(validateSkill(empty, TOOL_NAMES)).toEqual(["frontmatter metadata.version is missing"]);
  });

  it.each(["1.0", "v1.0.0", "1.0.0.0", "01.0.0", "latest", " 1.0.0", ""])(
    'rejects the invalid version "%s"',
    (version) => {
      const fixture = replaceLine(VALID_FIXTURE, '"1.0.0"', JSON.stringify(version));
      expect(validateSkill(fixture, TOOL_NAMES)).toEqual([
        `frontmatter metadata.version "${version}" is not semver`,
      ]);
    },
  );

  it("rejects a version that YAML reads as a number", () => {
    const fixture = replaceLine(VALID_FIXTURE, '"1.0.0"', "1.0");
    expect(validateSkill(fixture, TOOL_NAMES)).toEqual([
      "frontmatter metadata.version must be a string",
    ]);
  });

  it("accepts prerelease and build semver versions", () => {
    for (const version of ["2.10.3", "1.0.0-rc.1", "1.0.0+build.5"]) {
      const fixture = replaceLine(VALID_FIXTURE, '"1.0.0"', `"${version}"`);
      expect(validateSkill(fixture, TOOL_NAMES)).toEqual([]);
    }
  });

  it("rejects a wrong name and an empty description", () => {
    const name = replaceLine(VALID_FIXTURE, "name: agentdesk", "name: other");
    expect(validateSkill(name, TOOL_NAMES)).toEqual(['frontmatter name must be "agentdesk"']);
    const description = replaceLine(
      VALID_FIXTURE,
      "description: Use when a choice needs the user.",
      'description: ""',
    );
    expect(validateSkill(description, TOOL_NAMES)).toEqual([
      "frontmatter description must be a nonempty string",
    ]);
  });

  it("rejects malformed YAML", () => {
    const fixture = replaceLine(VALID_FIXTURE, "name: agentdesk", "name: [agentdesk");
    expect(validateSkill(fixture, TOOL_NAMES)[0]).toMatch(/^frontmatter is not valid YAML/);
  });

  it.each([
    ["inline code", "Use `ask_user` for questions.", 'unknown tool "ask_user" in inline code'],
    [
      "inline code call",
      "Run `ask_user({})` first.",
      'unknown tool "ask_user" in inline code call',
    ],
    ["prose call", "Call askuser when unsure.", 'unknown tool "askuser" in prose "call NAME"'],
    [
      "prose call of inline code",
      "Then call `notify` and stop.",
      'unknown tool "notify" in inline code',
    ],
    ["prose tool", "Use the askuser tool.", 'unknown tool "askuser" in prose "NAME tool"'],
    [
      "fenced call",
      '```ts\nawait askUser({ title: "Deploy?" });\n```',
      'unknown tool "askUser" in fenced code call',
    ],
    [
      "fenced name selector",
      '```json\n{ "name": "notify", "arguments": {} }\n```',
      'unknown tool "notify" in fenced code selector',
    ],
    [
      "fenced tool selector",
      "```yaml\ntool: notify\n```",
      'unknown tool "notify" in fenced code selector',
    ],
    [
      "shell fence selector",
      "```sh\nmcp-cli call tool=notify\n```",
      'unknown tool "notify" in fenced code selector',
    ],
  ])("rejects an unknown tool named in %s", (_form, extra, problem) => {
    expect(validateSkill(withBody(extra), TOOL_NAMES)).toContain(problem);
  });

  it.each([
    ["argument names", "Pass `decision_id`, `recommendation`, and `timeout_seconds`."],
    ["field values", "Set `input_type` to `approve_reject` and `state` to `blocked`."],
    ["environment identifiers", "Prefer `AGENTDESK_TOPIC` when set."],
    ["answer shapes", 'Write `{"kind": "option", "option_id": "pg"}`.'],
    ["prose calls of tools", "Call `check` between tasks and call `cancel` when obsolete."],
    ["tool references", "The `await` tool waits. Use the `ask` tool once."],
    ["function words", "When it returns pending, call it again. Each tool reports errors."],
    ["fenced calls", "```ts\nask({ topic: 'acme/api' });\nstatus({ state: 'done' });\n```"],
    ["fenced selectors", '```json\n{ "name": "await", "arguments": { "decision_id": "d1" } }\n```'],
    ["display names", '```json\n{ "display_name": "Builder", "state": "working" }\n```'],
    ["shell commands", '```sh\ngit remote get-url origin\nbasename "$(pwd)"\n```'],
  ])("accepts %s", (_label, extra) => {
    expect(validateSkill(withBody(extra), TOOL_NAMES)).toEqual([]);
  });
});
