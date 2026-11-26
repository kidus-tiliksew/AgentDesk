import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectHarnesses, discoverT3Profiles, recordedT3ConfigDir } from "../src/harnesses.js";
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

  it("detects Antigravity by the agy executable", () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "agy");
    expect(detected(sandbox)).toEqual([{ id: "antigravity", via: "agy on PATH" }]);
  });

  it("detects Antigravity by ~/.gemini/antigravity-cli", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.home, ".gemini", "antigravity-cli");
    mkdirSync(path, { recursive: true });
    expect(detected(sandbox)).toEqual([{ id: "antigravity", via: path }]);
  });

  it("does not detect Antigravity by ~/.gemini/config alone", () => {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, ".gemini", "config"), { recursive: true });
    expect(detected(sandbox)).toEqual([]);
  });

  it("ignores a file on PATH that is not executable", () => {
    const sandbox = makeSandbox();
    const path = join(sandbox.bin, "codex");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o644);
    expect(detected(sandbox)).toEqual([]);
  });

  it("detects all four harnesses together in registry order", () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "agy");
    stubExecutable(sandbox, "cursor-agent");
    stubExecutable(sandbox, "codex");
    stubExecutable(sandbox, "claude");
    expect(detected(sandbox).map((d) => d.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "antigravity",
    ]);
  });

  it("fails install when no harness is detected", async () => {
    const sandbox = makeSandbox();
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain("No supported harness was found");
    expect(h.gateway.requests).toEqual([]);
  });
});

// DEC-25(1); component-installer §Harnesses: T3 Code Antigravity profiles
// under ${T3CODE_HOME:-~/.t3}/userdata/providers/antigravity also detect
// Antigravity, and discovery follows no link.
describe("T3 Code Antigravity profiles (AC-9.1)", () => {
  function providers(base: string): string {
    return join(base, "userdata", "providers", "antigravity");
  }

  function profile(base: string, name: string): string {
    const dir = join(providers(base), name, "config");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function profiles(sandbox: ReturnType<typeof makeSandbox>, env: Record<string, string> = {}) {
    return discoverT3Profiles(makeContext(sandbox, { env }).ctx);
  }

  it("detects Antigravity by a profile in ~/.t3 alone", () => {
    const sandbox = makeSandbox();
    profile(join(sandbox.home, ".t3"), "default");
    expect(detected(sandbox)).toEqual([
      {
        id: "antigravity",
        via: `T3 Code profiles in ${providers(join(sandbox.home, ".t3"))}`,
      },
    ]);
  });

  it("detects Antigravity by agy or ~/.gemini/antigravity-cli first when a profile also exists", () => {
    const sandbox = makeSandbox();
    profile(join(sandbox.home, ".t3"), "default");
    stubExecutable(sandbox, "agy");
    expect(detected(sandbox)).toEqual([{ id: "antigravity", via: "agy on PATH" }]);
    const other = makeSandbox();
    profile(join(other.home, ".t3"), "default");
    const cli = join(other.home, ".gemini", "antigravity-cli");
    mkdirSync(cli, { recursive: true });
    expect(detected(other)).toEqual([{ id: "antigravity", via: cli }]);
  });

  it("uses a relative T3CODE_HOME against the home directory and ignores ~/.t3 then", () => {
    const sandbox = makeSandbox();
    profile(join(sandbox.home, ".t3"), "ignored");
    const config = profile(join(sandbox.home, "apps", "t3"), "work");
    expect(profiles(sandbox, { T3CODE_HOME: "apps/t3" })).toEqual([config]);
    expect(detected(sandbox, { T3CODE_HOME: "apps/t3" })).toEqual([
      {
        id: "antigravity",
        via: `T3 Code profiles in ${providers(join(sandbox.home, "apps", "t3"))}`,
      },
    ]);
    expect(detected(sandbox, { T3CODE_HOME: "missing" })).toEqual([]);
  });

  it("uses an absolute T3CODE_HOME outside the home directory, walked from the filesystem root", () => {
    const sandbox = makeSandbox();
    const base = join(realpathSync(sandbox.root), "t3");
    const config = profile(base, "work");
    expect(profiles(sandbox, { T3CODE_HOME: base })).toEqual([config]);
    // A link above it, from the filesystem root down, stops discovery.
    const linked = join(realpathSync(sandbox.root), "t3-link");
    symlinkSync(base, linked);
    expect(profiles(sandbox, { T3CODE_HOME: linked })).toEqual([]);
  });

  it("lists only direct children whose profile and config folders are real directories, sorted", () => {
    const sandbox = makeSandbox();
    const base = join(sandbox.home, ".t3");
    const zeta = profile(base, "zeta");
    const alpha = profile(base, "alpha");
    const mid = profile(base, "Mid");
    // Not profiles: a file, a profile without config, a config that is a
    // file, a linked profile, a linked config, and a deeper folder.
    writeFileSync(join(providers(base), "notes.txt"), "x");
    mkdirSync(join(providers(base), "empty"));
    mkdirSync(join(providers(base), "file-config"));
    writeFileSync(join(providers(base), "file-config", "config"), "x");
    const outside = join(sandbox.root, "outside-profile");
    mkdirSync(join(outside, "config"), { recursive: true });
    symlinkSync(outside, join(providers(base), "linked"));
    mkdirSync(join(providers(base), "linked-config"));
    symlinkSync(join(outside, "config"), join(providers(base), "linked-config", "config"));
    mkdirSync(join(providers(base), "deep", "nested", "config"), { recursive: true });
    expect(profiles(sandbox)).toEqual([mid, alpha, zeta]);
  });

  it.each([
    ["~/.t3", (home: string) => join(home, ".t3")],
    ["userdata", (home: string) => join(home, ".t3", "userdata")],
    ["providers", (home: string) => join(home, ".t3", "userdata", "providers")],
    ["antigravity", (home: string) => providers(join(home, ".t3"))],
  ])("discovers nothing through a linked %s", (_, at) => {
    const sandbox = makeSandbox();
    const real = join(sandbox.root, "real-t3");
    profile(real, "default");
    const target = at(sandbox.home);
    mkdirSync(join(target, ".."), { recursive: true });
    // Point the link at the matching directory inside the real tree.
    const rel = target.slice(join(sandbox.home, ".t3").length);
    symlinkSync(join(real, rel), target);
    expect(profiles(sandbox)).toEqual([]);
    expect(detected(sandbox)).toEqual([]);
  });

  it("discovers nothing when a directory on the way is a file", () => {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, ".t3"));
    writeFileSync(join(sandbox.home, ".t3", "userdata"), "x");
    expect(profiles(sandbox)).toEqual([]);
  });

  it("derives a recorded profile path only from the current T3 Code home, one segment, and the exact file", () => {
    const sandbox = makeSandbox();
    const { ctx } = makeContext(sandbox);
    const dir = providers(join(sandbox.home, ".t3"));
    expect(
      recordedT3ConfigDir(ctx, join(dir, "a", "config", "mcp_config.json"), "mcp_config.json"),
    ).toBe(join(dir, "a", "config"));
    for (const path of [
      join(dir, "a", "config", "hooks.json"),
      join(dir, "a", "b", "config", "mcp_config.json"),
      join(dir, "config", "mcp_config.json"),
      join(dir, "..", "x", "config", "mcp_config.json"),
      join(sandbox.home, ".gemini", "config", "mcp_config.json"),
      "relative/a/config/mcp_config.json",
      `${dir}-other/a/config/mcp_config.json`,
    ]) {
      expect(recordedT3ConfigDir(ctx, path, "mcp_config.json"), path).toBeUndefined();
    }
  });
});
