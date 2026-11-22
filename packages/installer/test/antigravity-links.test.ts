import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statePath } from "../src/state.js";
import {
  cleanupSandboxes,
  FakeClock,
  FakeGateway,
  makeContext,
  makeSandbox,
  read,
  readJson,
  type Sandbox,
  stubExecutable,
  write,
} from "./helpers.js";

// DEC-24(1); component-installer §Harnesses and §State, re-run, and uninstall:
// Antigravity's setup stays in its user-level configuration under
// ~/.gemini/config. A symbolic link at the skill folder, at mcp_config.json or
// hooks.json, or at a directory above them is refused before the installer
// reads or writes through it, so a linked host application profile is never
// read or edited. The other harnesses keep writing through a linked file.

// Every readFileSync call in this file's runs, including the installer's own,
// passes through this wrapper, so a test can tell whether a path was read.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const readSpy = vi.mocked(fs.readFileSync);

beforeEach(() => {
  readSpy.mockClear();
});
afterEach(cleanupSandboxes);

/** The paths readFileSync opened since the test began. */
function readPaths(): string[] {
  return readSpy.mock.calls.map(([path]) => resolve(String(path)));
}

/** Whether readFileSync opened `dir` or anything under it. */
function readUnder(dir: string): string[] {
  const base = resolve(dir);
  return readPaths().filter((path) => path === base || path.startsWith(`${base}/`));
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A host application's profile outside ~/.gemini/config, as T3 Code keeps one. */
const PROFILE_MCP = { mcpServers: { host: { serverUrl: "https://host.example" } } };
const PROFILE_HOOKS = { host: { SessionStart: [{ type: "command", command: "echo host" }] } };

function agy() {
  const sandbox = makeSandbox();
  stubExecutable(sandbox, "agy");
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  const gemini = join(sandbox.home, ".gemini");
  const config = join(gemini, "config");
  const profile = join(sandbox.root, "host-app", "profile");
  return {
    sandbox,
    clock,
    gateway,
    gemini,
    config,
    profile,
    mcp: join(config, "mcp_config.json"),
    hooks: join(config, "hooks.json"),
    skill: join(config, "skills", "agentdesk"),
  };
}

/** Writes the host profile's files and returns their contents. */
function writeProfile(profile: string): { mcp: string; hooks: string } {
  const files = { mcp: json(PROFILE_MCP), hooks: json(PROFILE_HOOKS) };
  write(join(profile, "mcp_config.json"), files.mcp);
  write(join(profile, "hooks.json"), files.hooks);
  return files;
}

function expectProfileUnchanged(profile: string, files: { mcp: string; hooks: string }): void {
  expect(read(join(profile, "mcp_config.json"))).toBe(files.mcp);
  expect(read(join(profile, "hooks.json"))).toBe(files.hooks);
  expect(fs.readdirSync(profile).sort()).toEqual(["hooks.json", "mcp_config.json"]);
}

function recorded(sandbox: Sandbox): Record<string, Record<string, string>> {
  return readJson(join(sandbox.home, ".config", "agentdesk", "state.json")).harnesses as Record<
    string,
    Record<string, string>
  >;
}

describe("a symbolic link at the Antigravity skill folder", () => {
  it("is refused before its SKILL.md is read, and the MCP entry and hook are still written", async () => {
    const { sandbox, clock, gateway, mcp, hooks, skill } = agy();
    const target = join(sandbox.root, "external", "skills", "agentdesk");
    const h = makeContext(sandbox, { gateway, clock });
    // The target holds the very bytes the run would write, so a read of it
    // would also turn the skill message into "unchanged".
    write(join(target, "SKILL.md"), h.ctx.skill.content);
    fs.mkdirSync(join(skill, ".."), { recursive: true });
    fs.symlinkSync(target, skill);
    write(hooks, "{}\n");

    expect(await h.run(["install", "--yes"])).toBe(1);

    expect(h.err.join("\n")).toContain(
      `Antigravity: the skill was not written: ${skill} is a symbolic link; the installer does not write through it.`,
    );
    expect(readUnder(skill)).toEqual([]);
    expect(readUnder(target)).toEqual([]);
    // The detector sees the installer's reads: it saw the hook file read.
    expect(readPaths()).toContain(resolve(hooks));
    expect(h.output()).not.toContain("unchanged");
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(read(join(target, "SKILL.md"))).toBe(h.ctx.skill.content);
    expect(read(mcp)).toContain(gateway.tokenFor("antigravity"));
    expect(read(hooks)).toContain("context --harness antigravity");
    expect(recorded(sandbox).antigravity?.skillPath).toBeUndefined();
  });

  it("is refused on skill install before its SKILL.md is read", async () => {
    const { sandbox, clock, gateway, skill } = agy();
    const target = join(sandbox.root, "external", "skills", "agentdesk");
    write(join(target, "SKILL.md"), "linked skill\n");
    fs.mkdirSync(join(skill, ".."), { recursive: true });
    fs.symlinkSync(target, skill);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["skill", "install"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${skill} is a symbolic link`);
    expect(readUnder(target)).toEqual([]);
    expect(readUnder(skill)).toEqual([]);
    expect(read(join(target, "SKILL.md"))).toBe("linked skill\n");
  });

  it("is refused when a parent of the skill folder is redirected, with nothing written there", async () => {
    const { sandbox, clock, gateway, mcp, hooks, skill } = agy();
    const elsewhere = join(sandbox.root, "external", "skills");
    write(join(elsewhere, "agentdesk", "SKILL.md"), "elsewhere\n");
    fs.mkdirSync(join(skill, "..", ".."), { recursive: true });
    fs.symlinkSync(elsewhere, join(skill, ".."));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `Antigravity: the skill was not written: ${skill} is not inside`,
    );
    expect(h.err.join("\n")).toContain(`${join(skill, "..")} is a symbolic link`);
    expect(readUnder(elsewhere)).toEqual([]);
    expect(read(join(elsewhere, "agentdesk", "SKILL.md"))).toBe("elsewhere\n");
    expect(read(mcp)).toContain("Bearer ");
    expect(read(hooks)).toContain("context --harness antigravity");
  });
});

describe("Antigravity configuration paths that leave ~/.gemini/config", () => {
  it.each([
    ["mcp_config.json", "mcp"],
    ["hooks.json", "hooks"],
  ] as const)(
    "refuses a linked %s before sign-in, and never reads or writes the profile",
    async (name, which) => {
      const ctx = agy();
      const { sandbox, clock, gateway, config, profile } = ctx;
      const files = writeProfile(profile);
      fs.mkdirSync(config, { recursive: true });
      fs.symlinkSync(join(profile, name), ctx[which]);

      const h = makeContext(sandbox, { gateway, clock });
      expect(await h.run(["install", "--yes"])).toBe(1);
      expect(h.err.join("\n")).toContain(
        `${ctx[which]} is not inside ${config} (${ctx[which]} is a symbolic link, which the installer does not follow); it was not read or changed.`,
      );
      expect(gateway.requests).toEqual([]);
      expect(readUnder(profile)).toEqual([]);
      expectProfileUnchanged(profile, files);
      expect(fs.lstatSync(ctx[which]).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(`${ctx[which]}.agentdesk-backup`)).toBe(false);
      expect(fs.existsSync(statePath(h.ctx))).toBe(false);

      readSpy.mockClear();
      const skill = makeContext(sandbox, { gateway, clock });
      if (which === "hooks") {
        // skill install writes the hook too, so it refuses the same link.
        expect(await skill.run(["skill", "install"])).toBe(1);
        expect(readUnder(profile)).toEqual([]);
        expectProfileUnchanged(profile, files);
      }
    },
  );

  it.each([
    ["~/.gemini/config", (c: ReturnType<typeof agy>) => c.config],
    ["~/.gemini", (c: ReturnType<typeof agy>) => c.gemini],
  ])("refuses a redirected %s before sign-in", async (_label, redirected) => {
    const ctx = agy();
    const { sandbox, clock, gateway, profile } = ctx;
    const link = redirected(ctx);
    // The profile stands where the redirected directory leads.
    const target = link === ctx.config ? profile : join(sandbox.root, "host-app", "gemini");
    const files =
      link === ctx.config
        ? writeProfile(profile)
        : (() => {
            fs.mkdirSync(join(target, "antigravity-cli"), { recursive: true });
            return writeProfile(join(target, "config"));
          })();
    fs.mkdirSync(join(link, ".."), { recursive: true });
    fs.symlinkSync(target, link);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `${link} is a symbolic link, which the installer does not follow`,
    );
    expect(gateway.requests).toEqual([]);
    const profileDir = link === ctx.config ? profile : join(target, "config");
    expect(readUnder(profileDir)).toEqual([]);
    expectProfileUnchanged(profileDir, files);
  });

  it("refuses a hook file later replaced by a link on uninstall, keeping the record", async () => {
    const { sandbox, clock, gateway, mcp, hooks, profile } = agy();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const files = writeProfile(profile);
    fs.rmSync(hooks);
    fs.symlinkSync(join(profile, "hooks.json"), hooks);
    readSpy.mockClear();

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `Antigravity: its hooks were not removed: ${hooks} is not inside`,
    );
    expect(readUnder(profile)).toEqual([]);
    expectProfileUnchanged(profile, files);
    expect(recorded(sandbox).antigravity?.hookPath).toBe(hooks);
    // The connection was revoked, but its MCP entry stays for a retry.
    expect(read(mcp)).toContain("Bearer ");
  });

  it("refuses an MCP file later replaced by a link on uninstall, revoking nothing", async () => {
    const { sandbox, clock, gateway, mcp, profile } = agy();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const files = writeProfile(profile);
    fs.rmSync(mcp);
    fs.symlinkSync(join(profile, "mcp_config.json"), mcp);
    readSpy.mockClear();

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${mcp} is not inside`);
    expect(gateway.revoked).toEqual([]);
    expect(readUnder(profile)).toEqual([]);
    expectProfileUnchanged(profile, files);
    expect(recorded(sandbox).antigravity?.connectionId).toBe(gateway.issued[0]?.connectionId);

    const status = makeContext(sandbox, { gateway, clock });
    expect(await status.run(["status"])).toBe(0);
    expect(status.out.find((l) => l.startsWith("Antigravity:"))).toContain(
      `configuration unreadable (${mcp} is not inside`,
    );
  });

  it("keeps writing through a linked Cursor mcp.json, as before", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const target = join(sandbox.root, "dotfiles", "cursor-mcp.json");
    write(target, json({ mcpServers: { linear: { url: "https://linear" } } }));
    const file = join(sandbox.home, ".cursor", "mcp.json");
    fs.mkdirSync(join(file, ".."), { recursive: true });
    fs.symlinkSync(target, file);
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readJson(target).mcpServers).toEqual({
      linear: { url: "https://linear" },
      agentdesk: {
        url: expect.stringMatching(/\/mcp$/),
        headers: { Authorization: `Bearer ${h.gateway.tokenFor("cursor")}` },
      },
    });
  });
});
