import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempPath } from "../src/defaults.js";
import { statePath } from "../src/state.js";
import {
  allFiles,
  cleanupSandboxes,
  FakeClock,
  FakeGateway,
  type Harnessed,
  makeContext,
  makeSandbox,
  read,
  readJson,
  type Sandbox,
  SERVER,
  stubExecutable,
  write,
} from "./helpers.js";

// T3 Code Antigravity profiles (DEC-25(1); component-installer §Harnesses and
// §State, re-run, and uninstall; req-installation-and-agent-guidance AC-9.1,
// AC-9.4, AC-9.6, AC-9.9, AC-10.4). T3 Code runs `agy` with each profile's
// config directory, so the installer writes the same MCP entry and named hook
// `agentdesk` there as in ~/.gemini/config, and no skill: each profile links
// config/skills to ~/.gemini/config/skills.

// Every readFileSync call passes through this wrapper, so a test can tell
// whether a path behind a link was read.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const readSpy = vi.mocked(fs.readFileSync);

beforeEach(() => {
  readSpy.mockClear();
});
afterEach(cleanupSandboxes);

/** Whether readFileSync opened `dir` or anything under it since the test began. */
function readUnder(dir: string): string[] {
  const base = resolve(dir);
  return readSpy.mock.calls
    .map(([path]) => resolve(String(path)))
    .filter((path) => path === base || path.startsWith(`${base}/`));
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const OTHER_MCP = { mcpServers: { host: { serverUrl: "https://host.example" } } };
const OTHER_HOOKS = { host: { SessionStart: [{ type: "command", command: "echo host" }] } };
const INSTRUCTIONS = "# my instructions\n";

interface T3 {
  sandbox: Sandbox;
  clock: FakeClock;
  gateway: FakeGateway;
  /** T3 Code's home. */
  base: string;
  env: Record<string, string>;
  canonical: string;
  profile(name: string): string;
  /** Adds a profile as T3 Code creates it: an empty mcp_config.json and a linked skills folder. */
  addProfile(name: string): string;
  ctx(extra?: Partial<Parameters<typeof makeContext>[1]>): Harnessed;
}

/**
 * A sandbox with `agy` on PATH (unless `agy` is false) and T3 Code profiles
 * under `${T3CODE_HOME:-~/.t3}/userdata/providers/antigravity`.
 */
function t3(
  options: { profiles?: string[]; agy?: boolean; t3Home?: (sandbox: Sandbox) => string } = {},
): T3 {
  const sandbox = makeSandbox();
  if (options.agy !== false) stubExecutable(sandbox, "agy");
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  const env: Record<string, string> = {};
  let base = join(sandbox.home, ".t3");
  if (options.t3Home) {
    env.T3CODE_HOME = options.t3Home(sandbox);
    base = resolve(sandbox.home, env.T3CODE_HOME);
  }
  const canonical = join(sandbox.home, ".gemini", "config");
  const profile = (name: string) =>
    join(base, "userdata", "providers", "antigravity", name, "config");
  const addProfile = (name: string) => {
    const dir = profile(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "mcp_config.json"), "");
    fs.symlinkSync(join(canonical, "skills"), join(dir, "skills"));
    return dir;
  };
  for (const name of options.profiles ?? ["alpha", "beta"]) addProfile(name);
  return {
    sandbox,
    clock,
    gateway,
    base,
    env,
    canonical,
    profile,
    addProfile,
    ctx: (extra = {}) =>
      makeContext(sandbox, { gateway, clock, ...extra, env: { ...env, ...(extra.env ?? {}) } }),
  };
}

function entry(token: string, server = SERVER) {
  return { url: `${server}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}

function hooks(t: T3) {
  return {
    SessionStart: [
      {
        type: "command",
        command: `${t.sandbox.executable} context --harness antigravity`,
        timeout: 30,
      },
    ],
    Stop: [
      {
        type: "command",
        command: `${t.sandbox.executable} hook stop --harness antigravity`,
        timeout: 3600,
      },
    ],
  };
}

function antigravityRecord(t: T3): Record<string, unknown> {
  const state = readJson(statePath(t.ctx().ctx)) as {
    harnesses: Record<string, Record<string, unknown>>;
  };
  return state.harnesses.antigravity ?? {};
}

/** Each file under `dir` with its content and inode, to show a run wrote nothing there. */
function snapshot(dir: string): Record<string, { text: string; ino: number }> {
  return Object.fromEntries(
    allFiles(dir).map((file) => [file, { text: read(file), ino: fs.statSync(file).ino }]),
  );
}

describe("install across T3 Code profiles (AC-9.1, AC-9.4, AC-9.9)", () => {
  it("writes the same MCP entry and named hook into ~/.gemini/config and every profile, keeping other entries and writing no profile skill", async () => {
    const t = t3();
    const alpha = t.profile("alpha");
    const beta = t.profile("beta");
    write(join(alpha, "mcp_config.json"), json(OTHER_MCP));
    write(join(alpha, "hooks.json"), json(OTHER_HOOKS));
    write(join(alpha, "GEMINI.md"), INSTRUCTIONS);
    write(join(t.sandbox.home, "CLAUDE.md"), INSTRUCTIONS);
    write(join(t.sandbox.home, "AGENTS.md"), INSTRUCTIONS);
    const h = t.ctx();
    expect(await h.run(["install", "--yes"])).toBe(0);
    const token = t.gateway.tokenFor("antigravity");
    expect(t.gateway.startRequests().map((r) => r.body)).toEqual([
      { machine_name: "devbox-1", harnesses: ["antigravity"] },
    ]);

    expect(readJson(join(t.canonical, "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });
    expect(readJson(join(alpha, "mcp_config.json"))).toEqual({
      mcpServers: { ...OTHER_MCP.mcpServers, agentdesk: entry(token) },
    });
    expect(readJson(join(beta, "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });
    expect(readJson(join(t.canonical, "hooks.json"))).toEqual({ agentdesk: hooks(t) });
    expect(readJson(join(alpha, "hooks.json"))).toEqual({ ...OTHER_HOOKS, agentdesk: hooks(t) });
    expect(readJson(join(beta, "hooks.json"))).toEqual({ agentdesk: hooks(t) });

    // One skill, in ~/.gemini/config; each profile's skills folder is still
    // T3 Code's link and nothing else was added to the profile.
    expect(fs.existsSync(join(t.canonical, "skills", "agentdesk", "SKILL.md"))).toBe(true);
    for (const dir of [alpha, beta]) {
      expect(fs.lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(true);
      expect(
        fs
          .readdirSync(dir)
          .filter((name) => !name.endsWith(".agentdesk-backup"))
          .sort(),
      ).toEqual(
        (dir === alpha
          ? ["GEMINI.md", "hooks.json", "mcp_config.json", "skills"]
          : ["hooks.json", "mcp_config.json", "skills"]
        ).sort(),
      );
    }
    expect(read(join(alpha, "GEMINI.md"))).toBe(INSTRUCTIONS);
    expect(read(join(t.sandbox.home, "CLAUDE.md"))).toBe(INSTRUCTIONS);
    expect(read(join(t.sandbox.home, "AGENTS.md"))).toBe(INSTRUCTIONS);

    expect(antigravityRecord(t)).toMatchObject({
      extraConfigPaths: [join(alpha, "mcp_config.json"), join(beta, "mcp_config.json")],
      extraHookPaths: [join(alpha, "hooks.json"), join(beta, "hooks.json")],
    });
    expect(h.out).toContain(
      `Antigravity (T3 Code profile alpha): MCP entry written to ${join(alpha, "mcp_config.json")}`,
    );
    expect(h.out).toContain(
      `Antigravity (T3 Code profile beta): Stop hook written to ${join(beta, "hooks.json")}`,
    );
    expect(h.output()).not.toContain(token);
    expect(read(statePath(h.ctx))).not.toContain(token);
  });

  it("writes nothing and makes no backup on an unchanged re-run", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    for (const file of allFiles(t.sandbox.root)) {
      if (file.endsWith(".agentdesk-backup")) fs.rmSync(file);
    }
    // An old modification time shows an in-place write of the same bytes too.
    const old = new Date("2001-02-03T04:05:06Z");
    const managed = [t.canonical, t.profile("alpha"), t.profile("beta")].flatMap((dir) => [
      join(dir, "mcp_config.json"),
      join(dir, "hooks.json"),
    ]);
    for (const file of managed) fs.utimesSync(file, old, old);
    const before = snapshot(join(t.base, "userdata"));
    const inodes = managed.map((file) => fs.statSync(file).ino);
    const h = t.ctx();
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(t.gateway.startRequests()).toHaveLength(1);
    expect(snapshot(join(t.base, "userdata"))).toEqual(before);
    expect(managed.map((file) => fs.statSync(file).ino)).toEqual(inodes);
    for (const file of managed) {
      expect(fs.statSync(file).mtime.getTime(), file).toBe(old.getTime());
    }
    expect(allFiles(t.sandbox.root).filter((f) => f.endsWith(".agentdesk-backup"))).toEqual([]);
    const alpha = t.profile("alpha");
    expect(h.out).toContain(
      `Antigravity (T3 Code profile alpha): MCP entry unchanged in ${join(alpha, "mcp_config.json")}`,
    );
    expect(h.out).toContain(
      `Antigravity (T3 Code profile alpha): session-start hook unchanged in ${join(alpha, "hooks.json")}`,
    );
  });

  it("sets up a profile created after install on a re-run, with no new sign-in", async () => {
    const t = t3({ profiles: ["alpha"] });
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const token = t.gateway.tokenFor("antigravity");
    const gamma = t.addProfile("gamma");
    const h = t.ctx();
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(t.gateway.startRequests()).toHaveLength(1);
    expect(h.out).toContain("Antigravity: connection works; keeping it.");
    expect(readJson(join(gamma, "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });
    expect(readJson(join(gamma, "hooks.json"))).toEqual({ agentdesk: hooks(t) });
    expect(antigravityRecord(t)).toMatchObject({
      extraConfigPaths: [
        join(t.profile("alpha"), "mcp_config.json"),
        join(gamma, "mcp_config.json"),
      ],
      extraHookPaths: [join(t.profile("alpha"), "hooks.json"), join(gamma, "hooks.json")],
    });
  });

  it("writes every profile with the new connection before it revokes the old one on a --server change", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const oldToken = t.gateway.tokenFor("antigravity");
    const other = "https://other.test";
    const h = t.ctx();
    const files = [
      join(t.canonical, "mcp_config.json"),
      join(t.profile("alpha"), "mcp_config.json"),
      join(t.profile("beta"), "mcp_config.json"),
    ];
    const atRevocation: string[][] = [];
    const fetch = h.ctx.fetch;
    h.ctx.fetch = async (input, init) => {
      if (init?.method === "DELETE") atRevocation.push(files.map((file) => read(file)));
      return fetch(input, init);
    };
    expect(await h.run(["install", "--yes", "--server", other])).toBe(0);
    const newToken = t.gateway.tokenFor("antigravity");
    expect(newToken).not.toBe(oldToken);
    expect(t.gateway.revoked).toEqual([oldToken]);
    // When the old connection was revoked, every file already held the new one.
    expect(atRevocation).toHaveLength(1);
    for (const text of atRevocation[0] ?? []) {
      expect(JSON.parse(text)).toEqual({ mcpServers: { agentdesk: entry(newToken, other) } });
    }
    // Each backup holds what the file held before this run, never the new token.
    for (const file of files) {
      const backup = read(`${file}.agentdesk-backup`);
      expect(backup).toContain(oldToken);
      expect(backup).not.toContain(newToken);
    }
    expect(h.output()).not.toContain(newToken);
    expect(h.output()).not.toContain(oldToken);
  });

  it("revokes the new connection and writes no profile when ~/.gemini/config/mcp_config.json cannot be written", async () => {
    const t = t3();
    const outside = join(t.sandbox.root, "outside.json");
    write(outside, json(OTHER_MCP));
    const before = snapshot(join(t.base, "userdata"));
    const h = t.ctx();
    const fetch = h.ctx.fetch;
    h.ctx.fetch = async (input, init) => {
      // After the pre-flight checks passed, the file becomes a link.
      if (String(input).endsWith("/device/poll")) {
        fs.mkdirSync(t.canonical, { recursive: true });
        fs.rmSync(join(t.canonical, "mcp_config.json"), { force: true });
        fs.symlinkSync(outside, join(t.canonical, "mcp_config.json"));
      }
      return fetch(input, init);
    };
    expect(await h.run(["install", "--yes"])).toBe(1);
    const token = t.gateway.tokenFor("antigravity");
    expect(t.gateway.revoked).toEqual([token]);
    expect(h.err.join("\n")).toContain("its MCP entry in");
    expect(read(outside)).toBe(json(OTHER_MCP));
    expect(snapshot(join(t.base, "userdata"))).toEqual(before);
    const record = antigravityRecord(t);
    expect(record.connectionId).toBeUndefined();
    expect(record.extraConfigPaths).toBeUndefined();
    expect(record.extraHookPaths).toBeUndefined();
  });

  it("keeps the connection and records the profiles written when a later profile write fails, exiting with status 1", async () => {
    const t = t3();
    const alpha = t.profile("alpha");
    const beta = t.profile("beta");
    const outside = join(t.sandbox.root, "outside.json");
    write(outside, json(OTHER_MCP));
    const h = t.ctx();
    const fetch = h.ctx.fetch;
    h.ctx.fetch = async (input, init) => {
      if (String(input).endsWith("/device/poll")) {
        fs.rmSync(join(beta, "mcp_config.json"));
        fs.symlinkSync(outside, join(beta, "mcp_config.json"));
      }
      return fetch(input, init);
    };
    expect(await h.run(["install", "--yes"])).toBe(1);
    const token = t.gateway.tokenFor("antigravity");
    expect(t.gateway.revoked).toEqual([]);
    expect(readJson(join(t.canonical, "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });
    expect(readJson(join(alpha, "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });
    expect(read(outside)).toBe(json(OTHER_MCP));
    expect(h.err.join("\n")).toContain(
      `Antigravity (T3 Code profile beta): its MCP entry in ${join(beta, "mcp_config.json")} was not written`,
    );
    const record = antigravityRecord(t);
    expect(record.connectionId).toBe(t.gateway.issued[0]?.connectionId);
    expect(record.extraConfigPaths).toEqual([join(alpha, "mcp_config.json")]);

    // Once the link is gone, a re-run keeps the connection and fills in beta.
    fs.rmSync(join(beta, "mcp_config.json"));
    const retry = t.ctx();
    expect(await retry.run(["install", "--yes"])).toBe(0);
    expect(t.gateway.startRequests()).toHaveLength(1);
    expect(readJson(join(beta, "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });
    expect(antigravityRecord(t).extraConfigPaths).toEqual([
      join(alpha, "mcp_config.json"),
      join(beta, "mcp_config.json"),
    ]);
  });

  it("refreshes the hooks in every profile on skill install without touching any MCP entry or writing a profile skill", async () => {
    const t = t3({ agy: false });
    const alpha = t.profile("alpha");
    write(join(alpha, "hooks.json"), json(OTHER_HOOKS));
    const h = t.ctx();
    expect(await h.run(["skill", "install"])).toBe(0);
    expect(t.gateway.requests).toEqual([]);
    for (const name of ["alpha", "beta"]) {
      expect(read(join(t.profile(name), "mcp_config.json"))).toBe("");
      expect(fs.lstatSync(join(t.profile(name), "skills")).isSymbolicLink()).toBe(true);
    }
    expect(fs.existsSync(join(t.canonical, "mcp_config.json"))).toBe(false);
    expect(readJson(join(alpha, "hooks.json"))).toEqual({ ...OTHER_HOOKS, agentdesk: hooks(t) });
    expect(readJson(join(t.profile("beta"), "hooks.json"))).toEqual({ agentdesk: hooks(t) });
    expect(fs.existsSync(join(t.canonical, "skills", "agentdesk", "SKILL.md"))).toBe(true);
    const record = antigravityRecord(t);
    expect(record.extraHookPaths).toEqual([
      join(alpha, "hooks.json"),
      join(t.profile("beta"), "hooks.json"),
    ]);
    expect(record.extraConfigPaths).toBeUndefined();
  });

  it("drops a recorded profile whose files are gone and keeps one outside the current T3 Code home", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    fs.rmSync(join(t.profile("beta"), ".."), { recursive: true });
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const alpha = t.profile("alpha");
    expect(antigravityRecord(t)).toMatchObject({
      extraConfigPaths: [join(alpha, "mcp_config.json")],
      extraHookPaths: [join(alpha, "hooks.json")],
    });

    // With T3CODE_HOME moved, the old profile still exists, so it stays
    // recorded beside the new one.
    const moved = join(t.sandbox.home, "t3-moved");
    const other = join(moved, "userdata", "providers", "antigravity", "delta", "config");
    fs.mkdirSync(other, { recursive: true });
    expect(await t.ctx({ env: { T3CODE_HOME: moved } }).run(["install", "--yes"])).toBe(0);
    expect(antigravityRecord(t)).toMatchObject({
      extraConfigPaths: [join(alpha, "mcp_config.json"), join(other, "mcp_config.json")].sort(),
      extraHookPaths: [join(alpha, "hooks.json"), join(other, "hooks.json")].sort(),
    });
  });

  it("supports a relative T3CODE_HOME and an absolute one outside the home directory", async () => {
    const relativeHome = t3({ t3Home: () => "apps/t3" });
    expect(relativeHome.base).toBe(join(relativeHome.sandbox.home, "apps", "t3"));
    expect(await relativeHome.ctx().run(["install", "--yes"])).toBe(0);
    const token = relativeHome.gateway.tokenFor("antigravity");
    expect(readJson(join(relativeHome.profile("alpha"), "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(token) },
    });

    const outside = t3({ t3Home: (sandbox) => join(fs.realpathSync(sandbox.root), "t3") });
    expect(await outside.ctx().run(["install", "--yes"])).toBe(0);
    const outsideToken = outside.gateway.tokenFor("antigravity");
    expect(readJson(join(outside.profile("beta"), "hooks.json"))).toEqual({
      agentdesk: hooks(outside),
    });
    expect(readJson(join(outside.profile("beta"), "mcp_config.json"))).toEqual({
      mcpServers: { agentdesk: entry(outsideToken) },
    });
    expect(await outside.ctx().run(["uninstall"])).toBe(0);
    expect(readJson(join(outside.profile("beta"), "mcp_config.json"))).toEqual({ mcpServers: {} });
    expect(readJson(join(outside.profile("beta"), "hooks.json"))).toEqual({});
  });
});

describe("refusals before sign-in", () => {
  /** Each case plants a link and returns the planted path. */
  function linkCases(): [string, (t: T3, outside: string) => string][] {
    const profileFile = (name: string) => (t: T3) => join(t.profile("alpha"), name);
    const cases: [string, (t: T3, outside: string) => string][] = [];
    const link = (outside: string, path: string) => {
      fs.rmSync(path, { force: true });
      fs.symlinkSync(outside, path);
      return path;
    };
    for (const name of ["mcp_config.json", "hooks.json"]) {
      cases.push([`a linked ${name}`, (t, outside) => link(outside, profileFile(name)(t))]);
      cases.push([
        `a linked ${name}.agentdesk-backup`,
        (t, outside) => link(outside, `${profileFile(name)(t)}.agentdesk-backup`),
      ]);
      cases.push([
        `a linked temporary file beside ${name}`,
        (t, outside) => link(outside, tempPath(profileFile(name)(t))),
      ]);
    }
    return cases;
  }

  it.each(linkCases())("refuses %s in a profile with nothing read or changed", async (_, plant) => {
    const t = t3();
    const outside = join(t.sandbox.root, "outside.json");
    write(outside, json(OTHER_MCP));
    const planted = plant(t, outside);
    const h = t.ctx();
    expect(await h.run(["install", "--yes"])).toBe(1);
    // Neither the link nor its destination was opened for reading.
    expect(readUnder(planted)).toEqual([]);
    expect(readUnder(outside)).toEqual([]);
    expect(t.gateway.requests).toEqual([]);
    expect(h.err.join("\n")).toContain(t.profile("alpha"));
    expect(read(outside)).toBe(json(OTHER_MCP));
    expect(fs.existsSync(join(t.canonical, "mcp_config.json"))).toBe(false);
    expect(fs.existsSync(statePath(h.ctx))).toBe(false);
  });

  const malformed: [string, string, string][] = [
    ["mcp_config.json", "{not json", "is not valid JSON"],
    ["mcp_config.json", json({ mcpServers: [] }), "mcpServers value that is not an object"],
    ["hooks.json", "{not json", "is not valid JSON"],
    ["hooks.json", json({ agentdesk: [] }), "agentdesk hook that is not an object"],
    [
      "hooks.json",
      json({
        agentdesk: { SessionStart: [{ type: "command", command: "echo mine", timeout: 30 }] },
      }),
      "is not exactly the handler AgentDesk writes",
    ],
  ];

  it.each(malformed)(
    "refuses a profile %s holding %j before sign-in",
    async (name, content, why) => {
      const t = t3();
      const file = join(t.profile("beta"), name);
      write(file, content);
      const h = t.ctx();
      expect(await h.run(["install", "--yes"])).toBe(1);
      expect(t.gateway.requests).toEqual([]);
      expect(h.err.join("\n")).toContain(why);
      expect(read(file)).toBe(content);
    },
  );

  // `skill install` reads no MCP file, so only the hook cases apply to it.
  it.each(malformed.filter(([name]) => name === "hooks.json"))(
    "refuses a profile %s holding %j on skill install before any hook is written",
    async (name, content, why) => {
      const t = t3();
      const file = join(t.profile("beta"), name);
      write(file, content);
      const h = t.ctx();
      expect(await h.run(["skill", "install"])).toBe(1);
      expect(h.err.join("\n")).toContain(why);
      expect(read(file)).toBe(content);
      expect(fs.existsSync(join(t.profile("alpha"), "hooks.json"))).toBe(false);
      expect(fs.existsSync(join(t.canonical, "hooks.json"))).toBe(false);
    },
  );

  it("does not discover or write a profile behind a linked directory", async () => {
    const t = t3({ profiles: [] });
    const elsewhere = join(t.sandbox.root, "elsewhere");
    const linked = join(elsewhere, "providers", "antigravity", "alpha", "config");
    write(join(linked, "mcp_config.json"), json(OTHER_MCP));
    fs.mkdirSync(join(t.base), { recursive: true });
    fs.symlinkSync(elsewhere, join(t.base, "userdata"));
    const h = t.ctx();
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(readUnder(elsewhere)).toEqual([]);
    expect(readUnder(join(t.base, "userdata"))).toEqual([]);
    expect(read(join(linked, "mcp_config.json"))).toBe(json(OTHER_MCP));
    expect(fs.readdirSync(linked)).toEqual(["mcp_config.json"]);
    expect(antigravityRecord(t).extraConfigPaths).toBeUndefined();
  });
});

describe("status", () => {
  it("reports matching, missing, out-of-sync, unreadable, and unconfigured profiles without a token", async () => {
    const t = t3({ profiles: ["alpha", "beta", "gamma", "delta"] });
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const token = t.gateway.tokenFor("antigravity");
    const alpha = t.profile("alpha");
    const beta = t.profile("beta");
    const gamma = t.profile("gamma");
    const delta = t.profile("delta");
    // beta: out of sync; gamma: unreadable; delta: deleted; epsilon: new.
    write(join(beta, "mcp_config.json"), json({ mcpServers: { agentdesk: entry("stale-token") } }));
    write(join(beta, "hooks.json"), json({}));
    write(join(gamma, "mcp_config.json"), "{not json");
    write(join(gamma, "hooks.json"), "{not json");
    fs.rmSync(join(delta, ".."), { recursive: true });
    const epsilon = t.addProfile("epsilon");
    const h = t.ctx();
    expect(await h.run(["status"])).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain(
      `Antigravity (T3 Code profile alpha): MCP entry in ${join(alpha, "mcp_config.json")} matches ${join(t.canonical, "mcp_config.json")}`,
    );
    expect(out).toContain(
      `Antigravity (T3 Code profile alpha): session-start hook and Stop hook in ${join(alpha, "hooks.json")}`,
    );
    expect(out).toContain(
      `Antigravity (T3 Code profile beta): MCP entry in ${join(beta, "mcp_config.json")} is out of sync with ${join(t.canonical, "mcp_config.json")}. Run: agentdesk install`,
    );
    expect(out).toContain(
      `Antigravity (T3 Code profile beta): no AgentDesk session-start hook or Stop hook in ${join(beta, "hooks.json")}. Run: agentdesk install`,
    );
    expect(out).toContain("Antigravity (T3 Code profile gamma): MCP file unreadable (");
    expect(out).toContain("Antigravity (T3 Code profile gamma): hook file unreadable (");
    expect(out).toContain(
      `Antigravity (T3 Code profile delta): MCP file missing (${join(delta, "mcp_config.json")})`,
    );
    expect(out).toContain(
      `Antigravity (T3 Code profile delta): hook file missing (${join(delta, "hooks.json")})`,
    );
    expect(out).toContain(
      `Antigravity (T3 Code profile epsilon): detected in ${epsilon} but not set up. Run: agentdesk install`,
    );
    expect(out).not.toContain("profile alpha): detected");
    expect(h.output()).not.toContain(token);
    expect(h.output()).not.toContain("stale-token");
  });

  it("reports a linked profile file as unreadable without reading it", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const outside = join(t.sandbox.root, "outside.json");
    write(outside, json(OTHER_MCP));
    const file = join(t.profile("alpha"), "mcp_config.json");
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    readSpy.mockClear();
    const h = t.ctx();
    expect(await h.run(["status"])).toBe(0);
    expect(h.out.join("\n")).toContain(
      `Antigravity (T3 Code profile alpha): MCP file unreadable (${file} was not read or changed, because ${file} is a symbolic link`,
    );
    expect(readUnder(outside)).toEqual([]);
  });

  it("reports detected profiles when Antigravity is not set up", async () => {
    const none = t3({ agy: false });
    const h = none.ctx();
    expect(await h.run(["status"])).toBe(0);
    expect(h.out).toEqual([
      "AgentDesk is not installed on this machine. Run: agentdesk install",
      `Antigravity (T3 Code profile alpha): detected in ${none.profile("alpha")} but not set up. Run: agentdesk install`,
      `Antigravity (T3 Code profile beta): detected in ${none.profile("beta")} but not set up. Run: agentdesk install`,
    ]);

    // Another harness is installed, and Antigravity is not.
    const other = t3({ agy: false });
    stubExecutable(other.sandbox, "cursor-agent");
    expect(await other.ctx().run(["install", "--yes", "--only", "cursor"])).toBe(0);
    const status = other.ctx();
    expect(await status.run(["status"])).toBe(0);
    expect(status.out).toContain(
      `Antigravity (T3 Code profile beta): detected in ${other.profile("beta")} but not set up. Run: agentdesk install`,
    );
  });
});

describe("uninstall (AC-9.6)", () => {
  it("removes the AgentDesk entries from ~/.gemini/config and every recorded profile, keeps other entries, and skips a deleted profile", async () => {
    const t = t3({ profiles: ["alpha", "beta", "gamma"] });
    const alpha = t.profile("alpha");
    write(join(alpha, "mcp_config.json"), json(OTHER_MCP));
    write(join(alpha, "hooks.json"), json(OTHER_HOOKS));
    write(join(alpha, "GEMINI.md"), INSTRUCTIONS);
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const token = t.gateway.tokenFor("antigravity");
    fs.rmSync(join(t.profile("gamma"), ".."), { recursive: true });
    const h = t.ctx();
    expect(await h.run(["uninstall"])).toBe(0);
    expect(t.gateway.revoked).toEqual([token]);
    expect(readJson(join(alpha, "mcp_config.json"))).toEqual(OTHER_MCP);
    expect(readJson(join(alpha, "hooks.json"))).toEqual(OTHER_HOOKS);
    expect(read(join(alpha, "GEMINI.md"))).toBe(INSTRUCTIONS);
    expect(readJson(join(t.profile("beta"), "mcp_config.json"))).toEqual({ mcpServers: {} });
    expect(readJson(join(t.profile("beta"), "hooks.json"))).toEqual({});
    expect(readJson(join(t.canonical, "mcp_config.json"))).toEqual({ mcpServers: {} });
    expect(fs.existsSync(join(t.canonical, "skills", "agentdesk"))).toBe(false);
    expect(fs.lstatSync(join(alpha, "skills")).isSymbolicLink()).toBe(true);
    expect(h.out).toContain(
      `Antigravity (T3 Code profile gamma): ${join(t.profile("gamma"), "mcp_config.json")} no longer exists; skipped.`,
    );
    expect(h.out).toContain(
      `Antigravity (T3 Code profile beta): removing the MCP entry from ${join(t.profile("beta"), "mcp_config.json")}`,
    );
    expect(fs.existsSync(statePath(h.ctx))).toBe(false);
    expect(h.output()).not.toContain(token);
  });

  it("revokes with a recorded profile's token when ~/.gemini/config/mcp_config.json holds none", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const token = t.gateway.tokenFor("antigravity");
    write(join(t.canonical, "mcp_config.json"), json({ mcpServers: {} }));
    const h = t.ctx();
    expect(await h.run(["uninstall"])).toBe(0);
    expect(t.gateway.revoked).toEqual([token]);
    expect(h.out).toContain(
      `Antigravity: revoking its connection with the token in ${join(t.profile("alpha"), "mcp_config.json")}`,
    );
    expect(readJson(join(t.profile("alpha"), "mcp_config.json"))).toEqual({ mcpServers: {} });
    expect(fs.existsSync(statePath(h.ctx))).toBe(false);
    expect(h.output()).not.toContain(token);
  });

  it("keeps a recovery record when no profile holds a token for the recorded server", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const connectionId = t.gateway.issued[0]?.connectionId;
    write(join(t.canonical, "mcp_config.json"), json({ mcpServers: {} }));
    // One profile names another server; its token is never sent there or here.
    write(
      join(t.profile("alpha"), "mcp_config.json"),
      json({ mcpServers: { agentdesk: entry("foreign-token", "https://elsewhere.test") } }),
    );
    write(join(t.profile("beta"), "mcp_config.json"), json({ mcpServers: {} }));
    const h = t.ctx();
    expect(await h.run(["uninstall"])).toBe(1);
    expect(t.gateway.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(h.err.join("\n")).toContain(`connection ${connectionId} at ${SERVER} is not revoked`);
    const state = readJson(statePath(h.ctx)) as { unrevoked: { connectionId: string }[] };
    expect(state.unrevoked.map((u) => u.connectionId)).toEqual([connectionId]);
    expect(h.output()).not.toContain("foreign-token");
  });

  it("revokes only with a profile token the server names as the recorded connection", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const first = t.gateway.tokenFor("antigravity");
    // The connection is replaced, so the first token is revoked and the state
    // records the second connection.
    t.gateway.refused.add(first);
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const second = t.gateway.tokenFor("antigravity");
    const connectionId = t.gateway.issued.at(-1)?.connectionId;
    expect(antigravityRecord(t).connectionId).toBe(connectionId);
    expect(t.gateway.revoked).toEqual([first]);
    // A partial rotation left the revoked token in alpha; beta holds the live one.
    write(join(t.canonical, "mcp_config.json"), json({ mcpServers: {} }));
    write(
      join(t.profile("alpha"), "mcp_config.json"),
      json({ mcpServers: { agentdesk: entry(first) } }),
    );
    write(
      join(t.profile("beta"), "mcp_config.json"),
      json({ mcpServers: { agentdesk: entry(second) } }),
    );
    const h = t.ctx();
    expect(await h.run(["uninstall"])).toBe(0);
    expect(t.gateway.revoked).toEqual([first, second]);
    const deletes = t.gateway.requests.filter((r) => r.method === "DELETE");
    expect(deletes.at(-1)?.authorization).toBe(`Bearer ${second}`);
    expect(deletes.filter((r) => r.authorization === `Bearer ${first}`)).toHaveLength(1);
    expect(h.out).toContain(
      `Antigravity: revoking its connection with the token in ${join(t.profile("beta"), "mcp_config.json")}`,
    );
    expect(fs.existsSync(statePath(h.ctx))).toBe(false);
  });

  it("keeps a recovery record when a profile token belongs to another live connection", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const connectionId = t.gateway.issued[0]?.connectionId;
    const other = {
      harness: "antigravity",
      connectionId: "conn_other",
      token: `adc_other${"o".repeat(32)}`,
    };
    t.gateway.issued.push(other);
    write(join(t.canonical, "mcp_config.json"), json({ mcpServers: {} }));
    write(
      join(t.profile("alpha"), "mcp_config.json"),
      json({ mcpServers: { agentdesk: entry(other.token) } }),
    );
    write(join(t.profile("beta"), "mcp_config.json"), json({ mcpServers: {} }));
    const h = t.ctx();
    expect(await h.run(["uninstall"])).toBe(1);
    expect(t.gateway.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(t.gateway.revoked).toEqual([]);
    const state = readJson(statePath(h.ctx)) as { unrevoked: { connectionId: string }[] };
    expect(state.unrevoked.map((u) => u.connectionId)).toEqual([connectionId]);
    expect(h.output()).not.toContain(other.token);
  });

  /** Each case plants a refusal and returns the step that undoes only that change. */
  const refusals: [string, (t: T3, outside: string) => () => void, string][] = [
    [
      "a stray recorded path",
      (t) => {
        const file = statePath(t.ctx().ctx);
        const state = readJson(file) as { harnesses: { antigravity: Record<string, unknown> } };
        const recorded = state.harnesses.antigravity.extraConfigPaths;
        state.harnesses.antigravity.extraConfigPaths = [join(t.sandbox.home, "mcp_config.json")];
        write(file, JSON.stringify(state));
        return () => {
          const now = readJson(file) as { harnesses: { antigravity: Record<string, unknown> } };
          now.harnesses.antigravity.extraConfigPaths = recorded;
          write(file, JSON.stringify(now));
        };
      },
      "is not a mcp_config.json in a profile's config directory",
    ],
    [
      "a linked profile MCP file",
      (t, outside) => {
        const file = join(t.profile("beta"), "mcp_config.json");
        const original = read(file);
        fs.rmSync(file);
        fs.symlinkSync(outside, file);
        return () => {
          fs.rmSync(file);
          write(file, original);
        };
      },
      "is a symbolic link",
    ],
    [
      "a linked profile directory",
      (t, outside) => {
        const dir = join(t.profile("beta"), "..");
        const saved = join(t.sandbox.root, "beta-saved");
        fs.renameSync(dir, saved);
        const fake = join(outside, "..", "fake-profile");
        fs.mkdirSync(join(fake, "config"), { recursive: true });
        fs.symlinkSync(fake, dir);
        return () => {
          fs.rmSync(dir);
          fs.renameSync(saved, dir);
        };
      },
      "is a symbolic link",
    ],
    [
      "a malformed profile hook file",
      (t) => {
        const file = join(t.profile("beta"), "hooks.json");
        const original = read(file);
        write(file, "{not json");
        return () => write(file, original);
      },
      "is not valid JSON",
    ],
    [
      "a foreign handler in a profile's agentdesk hook",
      (t) => {
        const file = join(t.profile("beta"), "hooks.json");
        const original = read(file);
        const data = readJson(file) as { agentdesk: { Stop: unknown[] } };
        data.agentdesk.Stop.push({ type: "command", command: "echo mine", timeout: 3600 });
        write(file, json(data));
        return () => write(file, original);
      },
      "is not exactly the handler AgentDesk writes",
    ],
  ];

  it.each(refusals)(
    "refuses %s, revoking and removing nothing, and a retry finishes once it is fixed",
    async (_, plant, why) => {
      const t = t3();
      expect(await t.ctx().run(["install", "--yes"])).toBe(0);
      const token = t.gateway.tokenFor("antigravity");
      const outside = join(t.sandbox.root, "outside", "outside.json");
      write(outside, json(OTHER_MCP));
      const stateFile = statePath(t.ctx().ctx);
      const undo = plant(t, outside);
      const stateText = read(stateFile);
      const canonical = read(join(t.canonical, "mcp_config.json"));
      const alpha = read(join(t.profile("alpha"), "mcp_config.json"));
      const h = t.ctx();
      expect(await h.run(["uninstall"])).toBe(1);
      expect(h.err.join("\n")).toContain(why);
      expect(h.err.join("\n")).toContain("its record was kept");
      expect(t.gateway.revoked).toEqual([]);
      expect(readJson(stateFile)).toEqual(JSON.parse(stateText));
      expect(read(join(t.canonical, "mcp_config.json"))).toBe(canonical);
      expect(read(join(t.profile("alpha"), "mcp_config.json"))).toBe(alpha);
      expect(read(outside)).toBe(json(OTHER_MCP));
      expect(h.output()).not.toContain(token);

      // Undo only the planted change; beta keeps the entries the installer wrote.
      undo();
      expect(read(join(t.profile("beta"), "mcp_config.json"))).toContain(token);
      expect(readJson(join(t.profile("beta"), "hooks.json"))).toEqual({ agentdesk: hooks(t) });
      const retry = t.ctx();
      expect(await retry.run(["uninstall"])).toBe(0);
      expect(t.gateway.revoked).toEqual([token]);
      for (const name of ["alpha", "beta"]) {
        expect(readJson(join(t.profile(name), "mcp_config.json"))).toEqual({ mcpServers: {} });
        expect(readJson(join(t.profile(name), "hooks.json"))).toEqual({});
      }
      expect(fs.existsSync(stateFile)).toBe(false);
    },
  );

  it("keeps the remaining paths recorded when a profile removal fails partway", async () => {
    const t = t3();
    expect(await t.ctx().run(["install", "--yes"])).toBe(0);
    const beta = join(t.profile("beta"), "mcp_config.json");
    // A temporary entry that is not a link passes the checks but stops the write.
    write(tempPath(beta), "");
    const h = t.ctx();
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`its MCP entry in ${beta} not removed`);
    const record = antigravityRecord(t);
    expect(record.extraConfigPaths).toEqual([beta]);
    expect(record.extraHookPaths).toBeUndefined();
    expect(readJson(join(t.profile("alpha"), "mcp_config.json"))).toEqual({ mcpServers: {} });

    fs.rmSync(tempPath(beta));
    const retry = t.ctx();
    expect(await retry.run(["uninstall"])).toBe(0);
    expect(readJson(beta)).toEqual({ mcpServers: {} });
    expect(fs.existsSync(statePath(retry.ctx))).toBe(false);
  });
});
