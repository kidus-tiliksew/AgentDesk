import { describe, expect, test } from "vitest";
import { statusInputSchema } from "../src/index.js";

// component-contract §Status input; req-agent-status AC-1.3, AC-2.2.
const BASE = { state: "working", line: "Running the test suite" };

function paths(input: unknown) {
  const result = statusInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

describe("status input", () => {
  test("has exactly state, line, link, and display_name", () => {
    expect(Object.keys(statusInputSchema.shape)).toEqual(["state", "line", "link", "display_name"]);
  });

  test("accepts input without a topic, link, or display_name", () => {
    expect(statusInputSchema.parse(BASE)).toEqual(BASE);
  });

  test("defines no topic field", () => {
    expect(statusInputSchema.parse({ ...BASE, topic: "repo" })).toEqual(BASE);
  });

  test.each(["working", "waiting", "blocked", "done"])("accepts state %s", (state) => {
    expect(paths({ ...BASE, state })).toEqual([]);
  });

  test.each(["idle", "Working", "", null])("rejects state %j", (state) => {
    expect(paths({ ...BASE, state })).toEqual([["state"]]);
  });

  test.each(["state", "line"])("requires %s", (field) => {
    const input: Record<string, unknown> = { ...BASE };
    delete input[field];
    expect(paths(input)).toEqual([[field]]);
  });

  test.each([
    [0, false],
    [1, true],
    [200, true],
    [201, false],
  ])("line of %i characters is valid: %j", (length, valid) => {
    expect(paths({ ...BASE, line: "x".repeat(length) })).toEqual(valid ? [] : [["line"]]);
  });

  test.each([
    "https://github.com/acme/repo/pull/7",
    "http://localhost:3000/build/12",
    "HTTPS://EXAMPLE.COM/",
  ])("accepts link %j", (link) => {
    expect(paths({ ...BASE, link })).toEqual([]);
  });

  test.each([
    "/builds/12",
    "builds/12",
    "example.com/builds",
    "ftp://example.com/file",
    "file:///etc/passwd",
    "mailto:dev@example.com",
    "javascript:alert(1)",
    "",
  ])("rejects link %j", (link) => {
    expect(paths({ ...BASE, link })).toEqual([["link"]]);
  });

  test.each([
    [0, false],
    [1, true],
    [60, true],
    [61, false],
  ])("display_name of %i characters is valid: %j", (length, valid) => {
    expect(paths({ ...BASE, display_name: "x".repeat(length) })).toEqual(
      valid ? [] : [["display_name"]],
    );
  });
});
