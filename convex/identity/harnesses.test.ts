import { describe, expect, test } from "vitest";
import { HARNESS_IDS, HARNESSES, harnessName, isHarnessId, parseHarnesses } from "./harnesses";

// component-identity §Short-code sign-in: the harness vocabulary.

describe("harness vocabulary", () => {
  test("is the fixed set of ids and display names", () => {
    expect(HARNESSES).toEqual([
      { id: "claude-code", name: "Claude Code" },
      { id: "codex", name: "Codex" },
      { id: "cursor", name: "Cursor" },
    ]);
    expect(HARNESS_IDS).toEqual(["claude-code", "codex", "cursor"]);
    expect(harnessName("claude-code")).toBe("Claude Code");
    expect(harnessName("codex")).toBe("Codex");
    expect(harnessName("cursor")).toBe("Cursor");
  });

  test("recognizes only the fixed ids", () => {
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("Codex")).toBe(false);
    expect(isHarnessId("windsurf")).toBe(false);
    expect(isHarnessId(1)).toBe(false);
  });
});

describe("parseHarnesses", () => {
  test("keeps a list of distinct known ids in its order", () => {
    expect(parseHarnesses(["cursor", "claude-code"])).toEqual(["cursor", "claude-code"]);
    expect(parseHarnesses(["codex"])).toEqual(["codex"]);
  });

  test.each([
    ["an empty list", []],
    ["a duplicate", ["codex", "codex"]],
    ["an unknown id", ["codex", "windsurf"]],
    ["a display name", ["Codex"]],
    ["a non-string", ["codex", 3]],
  ])("refuses %s", (_label, values) => {
    expect(parseHarnesses(values)).toBeNull();
  });
});
