import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESSES } from "../src/harnesses.js";
import { skillVersionOf } from "../src/skill.js";
import { statePath } from "../src/state.js";
import {
  cleanupSandboxes,
  makeContext,
  makeSandbox,
  read,
  readJson,
  SKILL_FILE,
  stubExecutable,
  write,
} from "./helpers.js";

afterEach(cleanupSandboxes);

/** The user's own instruction files, which no run may change (AC-10.4). */
const INSTRUCTIONS = {
  ".claude/CLAUDE.md": "# My Claude rules\n",
  ".codex/AGENTS.md": "# My Codex rules\n",
};

const claudeSkill = (home: string) => join(home, ".claude", "skills", "agentdesk", "SKILL.md");
const codexSkill = (home: string) => join(home, ".codex", "skills", "agentdesk", "SKILL.md");
const cursorSkill = (home: string) => join(home, ".cursor", "skills", "agentdesk", "SKILL.md");

describe("skill version", () => {
  it("reads metadata.version from the published skill", () => {
    expect(skillVersionOf(readFileSync(SKILL_FILE, "utf8"))).toBe("2.3.0");
  });

  it("returns undefined without frontmatter or version", () => {
    expect(skillVersionOf("# no frontmatter\n")).toBeUndefined();
    expect(skillVersionOf("---\nname: x\n---\n")).toBeUndefined();
  });
});

describe("skill placement (component-installer §Harnesses)", () => {
  it("writes the Claude Code and Codex skills and no Cursor skill when both are installed", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "codex");
    stubExecutable(sandbox, "cursor-agent");
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(read(claudeSkill(sandbox.home))).toBe(read(SKILL_FILE));
    expect(read(codexSkill(sandbox.home))).toBe(read(SKILL_FILE));
    expect(existsSync(cursorSkill(sandbox.home))).toBe(false);
    expect(statSync(claudeSkill(sandbox.home)).mode & 0o777).toBe(0o644);
    expect(h.out).toContain(
      "Cursor: loads the AgentDesk skill from the Claude Code or Codex skill folder.",
    );
  });

  it("writes no Cursor skill when the run installs the Claude Code skill only", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "cursor-agent");
    expect(await makeContext(sandbox).run(["install", "--yes"])).toBe(0);
    expect(existsSync(claudeSkill(sandbox.home))).toBe(true);
    expect(existsSync(cursorSkill(sandbox.home))).toBe(false);
  });

  it("writes no Cursor skill when the run installs the Codex skill only", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    stubExecutable(sandbox, "cursor-agent");
    expect(await makeContext(sandbox).run(["install", "--yes"])).toBe(0);
    expect(existsSync(codexSkill(sandbox.home))).toBe(true);
    expect(existsSync(cursorSkill(sandbox.home))).toBe(false);
  });

  it("writes the Cursor skill when the run installs neither the Claude Code nor the Codex skill", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "cursor-agent");
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes", "--only", "cursor"])).toBe(0);
    expect(read(cursorSkill(sandbox.home))).toBe(read(SKILL_FILE));
    expect(existsSync(claudeSkill(sandbox.home))).toBe(false);
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, { skillPath?: string }>;
    expect(state.cursor?.skillPath).toBe(join(sandbox.home, ".cursor", "skills", "agentdesk"));
  });

  it("removes the Cursor skill it owned once a later run installs the Claude Code skill", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "cursor-agent");
    const first = makeContext(sandbox);
    expect(await first.run(["install", "--yes", "--only", "cursor"])).toBe(0);
    const second = makeContext(sandbox, { gateway: first.gateway, clock: first.clock });
    expect(await second.run(["install", "--yes"])).toBe(0);
    expect(existsSync(join(sandbox.home, ".cursor", "skills", "agentdesk"))).toBe(false);
    expect(existsSync(claudeSkill(sandbox.home))).toBe(true);
    const state = readJson(statePath(second.ctx)).harnesses as Record<
      string,
      { skillPath?: string }
    >;
    expect(state.cursor?.skillPath).toBeUndefined();
  });

  it("writes the MCP entry and reports no skill for a harness without skills (AC-9.2)", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const harnesses = HARNESSES.map((h) =>
      h.id === "cursor" ? { ...h, supportsSkills: false } : h,
    );
    const h = makeContext(sandbox, { harnesses });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(readJson(join(sandbox.home, ".cursor", "mcp.json")).mcpServers).toHaveProperty(
      "agentdesk",
    );
    expect(existsSync(join(sandbox.home, ".cursor", "skills"))).toBe(false);
    expect(h.out).toContain("Cursor: does not support skills, so no skill was installed.");
    // The session-start and resume hooks are written all the same; the
    // guidance omits the skill line.
    expect(readJson(join(sandbox.home, ".cursor", "hooks.json"))).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command: `${sandbox.executable} context --harness cursor` }],
        afterMCPExecution: [{ command: `${sandbox.executable} hook after-mcp --harness cursor` }],
        stop: [
          {
            command: `${sandbox.executable} hook stop --harness cursor`,
            timeout: 3600,
            loop_limit: null,
          },
        ],
      },
    });
  });
});

describe("agentdesk skill install (REQ-3)", () => {
  it("installs the skill and the hooks for every detected harness without signing in", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "codex");
    for (const [path, content] of Object.entries(INSTRUCTIONS))
      write(join(sandbox.home, path), content);
    const h = makeContext(sandbox);
    expect(await h.run(["skill", "install"])).toBe(0);
    expect(h.gateway.requests).toEqual([]);
    expect(read(claudeSkill(sandbox.home))).toBe(read(SKILL_FILE));
    expect(read(codexSkill(sandbox.home))).toBe(read(SKILL_FILE));
    expect(existsSync(join(sandbox.home, ".claude.json"))).toBe(false);
    const state = readJson(statePath(h.ctx));
    expect(state.harnesses).toEqual({
      "claude-code": {
        skillPath: join(sandbox.home, ".claude", "skills", "agentdesk"),
        skillRealPath: realpathSync(join(sandbox.home, ".claude", "skills", "agentdesk")),
        skillVersion: "1.0.0",
        hookPath: join(sandbox.home, ".claude", "settings.json"),
      },
      codex: {
        skillPath: join(sandbox.home, ".codex", "skills", "agentdesk"),
        skillRealPath: realpathSync(join(sandbox.home, ".codex", "skills", "agentdesk")),
        skillVersion: "1.0.0",
        hookPath: join(sandbox.home, ".codex", "hooks.json"),
        stopHookPath: join(sandbox.home, ".codex", "hooks.json"),
        codexTrustKey: `${realpathSync(join(sandbox.home, ".codex", "hooks.json"))}:session_start:0:0`,
        codexStopTrustKey: `${realpathSync(join(sandbox.home, ".codex", "hooks.json"))}:stop:0:0`,
      },
    });
    expect(
      (readJson(join(sandbox.home, ".codex", "hooks.json")).hooks as Record<string, unknown>).Stop,
    ).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `${sandbox.executable} hook stop --harness codex`,
            timeout: 10,
          },
        ],
      },
    ]);
    expect(h.out).toContain(
      "Start a new agent session: a session that is already running has not loaded the updated skill and guidance.",
    );
    // A waiter the resume hooks started left claims beside the state file.
    const resume = join(sandbox.home, ".config", "agentdesk", "resume");
    write(join(resume, "claims", "dec_1"), "");

    // Uninstall removes a skill-only installation without calling the gateway.
    const removal = makeContext(sandbox);
    expect(await removal.run(["uninstall"])).toBe(0);
    expect(removal.gateway.requests).toEqual([]);
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk"))).toBe(false);
    expect(readJson(join(sandbox.home, ".claude", "settings.json"))).toEqual({
      hooks: { SessionStart: [] },
    });
    expect(readJson(join(sandbox.home, ".codex", "hooks.json"))).toEqual({
      hooks: { SessionStart: [], Stop: [] },
    });
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toBe("");
    expect(removal.out).toContain(`Removing the resume directory ${resume}`);
    expect(existsSync(resume)).toBe(false);
    expect(existsSync(statePath(h.ctx))).toBe(false);
    for (const [path, content] of Object.entries(INSTRUCTIONS)) {
      expect(read(join(sandbox.home, path))).toBe(content);
    }
  });

  it("writes the Cursor skill when Cursor is the only detected harness", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor");
    expect(await makeContext(sandbox).run(["skill", "install"])).toBe(0);
    expect(read(cursorSkill(sandbox.home))).toBe(read(SKILL_FILE));
  });
});
