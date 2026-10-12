import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectHarnesses } from "../src/harnesses.js";
import { cleanupSandboxes, makeContext, makeSandbox, stubExecutable } from "./helpers.js";

afterEach(cleanupSandboxes);

function detected(sandbox: ReturnType<typeof makeSandbox>, env: Record<string, string> = {}) {
  const { ctx } = makeContext(sandbox, { env });
  return detectHarnesses(ctx).map((d) => ({ id: d.harness.id, via: d.via }));
}

describe("harness detection (AC-9.1)", () => {
  it("detects nothing in an empty home with an empty PATH", () => {
    expect(detected(makeSandbox())).toEqual([]);
  });

  it("detects Claude Code by the claude executable", () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    expect(detected(sandbox)).toEqual([{ id: "claude-code", via: "claude on PATH" }]);
  });

  it("detects Claude Code by ~/.claude.json", () => {
    const sandbox = makeSandbox();
    writeFileSync(join(sandbox.home, ".claude.json"), "{}\n");
    expect(detected(sandbox)).toEqual([
      { id: "claude-code", via: join(sandbox.home, ".claude.json") },
    ]);
  });

  it("detects Codex by the codex executable", () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    expect(detected(sandbox)).toEqual([{ id: "codex", via: "codex on PATH" }]);
  });

  it("detects Codex by ~/.codex", () => {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, ".codex"));
    expect(detected(sandbox)).toEqual([{ id: "codex", via: join(sandbox.home, ".codex") }]);
  });

  it("detects Codex by CODEX_HOME instead of ~/.codex", () => {
    const sandbox = makeSandbox();
    const codexHome = join(sandbox.root, "custom-codex");
    mkdirSync(codexHome);
    expect(detected(sandbox, { CODEX_HOME: codexHome })).toEqual([{ id: "codex", via: codexHome }]);
    // ~/.codex alone does not count when CODEX_HOME names another directory.
    const other = makeSandbox();
    mkdirSync(join(other.home, ".codex"));
    expect(detected(other, { CODEX_HOME: join(other.root, "missing") })).toEqual([]);
  });

  it.each(["cursor-agent", "agent", "cursor"])("detects Cursor by the %s executable", (name) => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, name);
    expect(detected(sandbox)).toEqual([{ id: "cursor", via: `${name} on PATH` }]);
  });

  it("detects Cursor by ~/.cursor", () => {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, ".cursor"));
    expect(detected(sandbox)).toEqual([{ id: "cursor", via: join(sandbox.home, ".cursor") }]);
  });

  it("ignores a file on PATH that is not executable", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.bin, "codex");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o644);
    expect(detected(sandbox)).toEqual([]);
  });

  it("detects all three harnesses together in registry order", () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    stubExecutable(sandbox, "codex");
    stubExecutable(sandbox, "claude");
    expect(detected(sandbox).map((d) => d.id)).toEqual(["claude-code", "codex", "cursor"]);
  });

  it("fails install when no harness is detected", async () => {
    const sandbox = makeSandbox();
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain("No supported harness was found");
    expect(h.gateway.requests).toEqual([]);
  });
});
