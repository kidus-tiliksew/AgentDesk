import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_SUFFIX, tempPath } from "../src/defaults.js";
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

// Review round 3 sweep (DEC-24(1); component-installer §Harnesses, §Standing
// guidance, and §State, re-run, and uninstall). Every Antigravity file the
// installer reads or writes, the MCP configuration, the hook file, and
// SKILL.md, is tried at each position the installer touches: the file, its
// backup, and its temporary file. At each position the test puts a symbolic
// link to a file outside, a FIFO, or a directory, and then runs install,
// skill install, status, and uninstall. No run may read the planted path,
// change the outside file, or block on the FIFO. A second part checks that
// a handler in the `agentdesk` hook counts as the installer's own only when
// it is exactly the handler the installer writes.

// Every readFileSync call passes through this wrapper, so a test can tell
// whether the planted path was read.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const readSpy = vi.mocked(fs.readFileSync);

const writers: ChildProcess[] = [];

beforeEach(() => {
  readSpy.mockClear();
});
afterEach(() => {
  for (const writer of writers.splice(0)) writer.kill("SIGKILL");
  cleanupSandboxes();
});

function readUnder(path: string): string[] {
  const base = resolve(path);
  return readSpy.mock.calls
    .map(([p]) => resolve(String(p)))
    .filter((p) => p === base || p.startsWith(`${base}/`));
}

type Target = "mcp" | "hooks" | "skill";
type Position = "file" | "backup" | "temporary";
type Kind = "link" | "fifo" | "directory";

const TARGETS: Target[] = ["mcp", "hooks", "skill"];
const POSITIONS: Position[] = ["file", "backup", "temporary"];
const KINDS: Kind[] = ["link", "fifo", "directory"];

function agy() {
  const sandbox = makeSandbox();
  stubExecutable(sandbox, "agy");
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  const config = join(sandbox.home, ".gemini", "config");
  const files: Record<Target, string> = {
    mcp: join(config, "mcp_config.json"),
    hooks: join(config, "hooks.json"),
    skill: join(config, "skills", "agentdesk", "SKILL.md"),
  };
  // A user instruction file outside ~/.gemini/config that no run may read or change.
  const outside = join(sandbox.home, "AGENTS.md");
  write(outside, "# My agent rules\n");
  return { sandbox, clock, gateway, config, files, outside };
}

function positionPath(file: string, position: Position): string {
  if (position === "backup") return file + BACKUP_SUFFIX;
  if (position === "temporary") return tempPath(file);
  return file;
}

/**
 * Puts `kind` at `path`, replacing what is there. A FIFO gets a writer that
 * opens and closes it again and again while it exists, so every read that
 * should not happen returns at once instead of blocking the test run, and the
 * read detector reports it. The writer is killed after the test.
 */
function plant(path: string, kind: Kind, outside: string): void {
  fs.rmSync(path, { recursive: true, force: true });
  fs.mkdirSync(join(path, ".."), { recursive: true });
  if (kind === "link") fs.symlinkSync(outside, path);
  else if (kind === "directory") fs.mkdirSync(path);
  else {
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    const writer = spawn("sh", ["-c", 'while [ -p "$1" ]; do : > "$1"; done', "sh", path], {
      stdio: "ignore",
    });
    writers.push(writer);
  }
}

function kindOf(path: string): Kind | "file" | "absent" {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) return "link";
    if (stat.isFIFO()) return "fifo";
    if (stat.isDirectory()) return "directory";
    return "file";
  } catch {
    return "absent";
  }
}

const CASES = TARGETS.flatMap((target) =>
  POSITIONS.flatMap((position) => KINDS.map((kind) => [target, position, kind] as const)),
);

describe("every Antigravity path refuses a link, a FIFO, or a directory", () => {
  it.each(CASES)("install with the %s %s as a %s", async (target, position, kind) => {
    const { sandbox, clock, gateway, files, outside } = agy();
    const path = positionPath(files[target], position);
    plant(path, kind, outside);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(path);
    if (target === "skill") {
      // The skill comes after sign-in; the MCP entry and hook are written.
      expect(h.err.join("\n")).toContain("Antigravity: the skill was not written:");
      expect(read(files.hooks)).toContain("context --harness antigravity");
    } else {
      // The MCP and hook files are read before sign-in, so nothing happens.
      expect(gateway.requests).toEqual([]);
      expect(fs.existsSync(statePath(h.ctx))).toBe(false);
    }
    expect(readUnder(path)).toEqual([]);
    expect(kindOf(path)).toBe(kind);
    expect(read(outside)).toBe("# My agent rules\n");
  });

  it.each(CASES.filter(([target]) => target !== "mcp"))(
    "skill install with the %s %s as a %s",
    async (target, position, kind) => {
      const { sandbox, clock, gateway, files, outside } = agy();
      const path = positionPath(files[target], position);
      plant(path, kind, outside);

      const h = makeContext(sandbox, { gateway, clock });
      expect(await h.run(["skill", "install"])).toBe(1);
      expect(h.err.join("\n")).toContain(path);
      expect(readUnder(path)).toEqual([]);
      expect(kindOf(path)).toBe(kind);
      expect(read(outside)).toBe("# My agent rules\n");
    },
  );

  it.each(CASES)("status after install with the %s %s as a %s", async (target, position, kind) => {
    const { sandbox, clock, gateway, files, outside } = agy();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const path = positionPath(files[target], position);
    plant(path, kind, outside);
    readSpy.mockClear();

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["status"])).toBe(0);
    const line = h.out.find((l) => l.startsWith("Antigravity:")) ?? "";
    const label = {
      mcp: "configuration unreadable (",
      hooks: "hook file unreadable (",
      skill: "skill not read (",
    }[target];
    expect(line).toContain(label);
    expect(line).toContain(path);
    expect(readUnder(path)).toEqual([]);
    expect(kindOf(path)).toBe(kind);
    expect(read(outside)).toBe("# My agent rules\n");
  });

  it.each(CASES)(
    "uninstall after install with the %s %s as a %s",
    async (target, position, kind) => {
      const { sandbox, clock, gateway, files, outside } = agy();
      expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
      const path = positionPath(files[target], position);
      plant(path, kind, outside);
      readSpy.mockClear();

      const h = makeContext(sandbox, { gateway, clock });
      if (target === "skill") {
        // Uninstall removes the owned skill folder whole without reading it:
        // the folder itself must be a real directory at its recorded location,
        // and removing an entry inside it never follows that entry.
        expect(await h.run(["uninstall"])).toBe(0);
        expect(kindOf(join(files.skill, ".."))).toBe("absent");
      } else {
        expect(await h.run(["uninstall"])).toBe(1);
        expect(h.err.join("\n")).toContain(path);
        expect(kindOf(path)).toBe(kind);
        const state = readJson(statePath(h.ctx)).harnesses as Record<string, unknown>;
        expect(state.antigravity).toBeDefined();
      }
      expect(readUnder(path)).toEqual([]);
      expect(read(outside)).toBe("# My agent rules\n");
    },
  );
});

describe("Antigravity folders that are not directories", () => {
  it.each([
    ["~/.gemini/config is a regular file", (s: Sandbox) => join(s.home, ".gemini", "config")],
    ["~/.gemini is a regular file", (s: Sandbox) => join(s.home, ".gemini")],
  ])("refuses install before sign-in when %s", async (_label, at) => {
    const { sandbox, clock, gateway } = agy();
    write(at(sandbox), "not a folder\n");
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${at(sandbox)} is not a directory`);
    expect(gateway.requests).toEqual([]);
    expect(read(at(sandbox))).toBe("not a folder\n");
  });

  it.each(["fifo", "file"] as const)(
    "refuses the skill when its folder is a %s, and reads nothing there",
    async (kind) => {
      const { sandbox, clock, gateway, files, outside } = agy();
      const folder = join(files.skill, "..");
      if (kind === "file") write(folder, "not a folder\n");
      else plant(folder, "fifo", outside);
      const h = makeContext(sandbox, { gateway, clock });
      expect(await h.run(["install", "--yes"])).toBe(1);
      expect(h.err.join("\n")).toContain(`${folder} is not a directory`);
      expect(readUnder(folder)).toEqual([]);
    },
  );
});

// The installer's handler is exactly {"type": "command", "command":
// "<agentdesk> context --harness antigravity", "timeout": 30}. Anything else
// in the `agentdesk` object is refused by install before sign-in and by
// uninstall, and the file stays unchanged.
describe("Antigravity handlers that differ from the installer's exact handler", () => {
  function command(sandbox: Sandbox): string {
    return `${sandbox.executable} context --harness antigravity`;
  }

  const MALFORMED: [string, (cmd: string) => unknown][] = [
    ["a timeout given as a string", (cmd) => ({ type: "command", command: cmd, timeout: "30" })],
    ["another timeout", (cmd) => ({ type: "command", command: cmd, timeout: 60 })],
    ["no timeout", (cmd) => ({ type: "command", command: cmd })],
    ["a timeout of null", (cmd) => ({ type: "command", command: cmd, timeout: null })],
    ["no type", (cmd) => ({ command: cmd, timeout: 30 })],
    ["another type", (cmd) => ({ type: "prompt", command: cmd, timeout: 30 })],
    ["an extra matcher", (cmd) => ({ type: "command", command: cmd, timeout: 30, matcher: "*" })],
    [
      "an extra enabled flag",
      (cmd) => ({ type: "command", command: cmd, timeout: 30, enabled: false }),
    ],
    ["extra command arguments", (cmd) => ({ type: "command", command: `${cmd} --x`, timeout: 30 })],
    [
      "a command that is not a string",
      () => ({ type: "command", command: ["agentdesk"], timeout: 30 }),
    ],
    ["a null handler", () => null],
    ["a list handler", (cmd) => [cmd]],
  ];

  const objects: [string, (sandbox: Sandbox) => unknown][] = [
    ...MALFORMED.map(([label, handler]): [string, (sandbox: Sandbox) => unknown] => [
      `a handler with ${label}`,
      (sandbox) => ({ SessionStart: [handler(command(sandbox))] }),
    ]),
    ["an event the installer does not write, even empty", () => ({ Stop: [] })],
    ["an event value that is an object", () => ({ SessionStart: {} })],
  ];

  function json(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  it.each(objects)("install refuses %s before sign-in", async (_label, owned) => {
    const { sandbox, clock, gateway, files } = agy();
    const text = json({ other: { Stop: [] }, agentdesk: owned(sandbox) });
    write(files.hooks, text);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(files.hooks);
    expect(gateway.requests).toEqual([]);
    expect(read(files.hooks)).toBe(text);
    expect(fs.existsSync(`${files.hooks}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it.each(objects)("uninstall refuses %s and leaves the file unchanged", async (_label, owned) => {
    const { sandbox, clock, gateway, files } = agy();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const text = json({ other: { Stop: [] }, agentdesk: owned(sandbox) });
    write(files.hooks, text);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`Antigravity: its hooks were not removed: ${files.hooks}`);
    expect(read(files.hooks)).toBe(text);
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, { hookPath?: string }>;
    expect(state.antigravity?.hookPath).toBe(files.hooks);
  });

  it("owns the exact handler from an older executable path and replaces it", async () => {
    const { sandbox, clock, gateway, files } = agy();
    write(
      files.hooks,
      json({
        agentdesk: {
          SessionStart: [
            {
              timeout: 30,
              command: "/opt/old/agentdesk context --harness antigravity",
              type: "command",
            },
          ],
        },
      }),
    );
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    expect(readJson(files.hooks)).toEqual({
      agentdesk: { SessionStart: [{ type: "command", command: command(sandbox), timeout: 30 }] },
    });
  });
});
