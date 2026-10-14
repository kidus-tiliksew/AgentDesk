import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookCommand, isInstallerCommand, shellQuote } from "../src/hooks.js";
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

afterEach(cleanupSandboxes);

// component-installer §Standing guidance: each harness's session-start hook,
// written under the JSON merge, refusal, and backup rules of §Harnesses.

const MATCHER = "startup|clear|compact";

const CLAUDE_SETTINGS = {
  model: "opus",
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }],
  },
};
const CODEX_HOOKS = {
  hooks: {
    SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: "echo codex-mine" }] }],
  },
};
const CURSOR_HOOKS = {
  version: 1,
  hooks: { sessionStart: [{ command: "echo cursor-mine" }], stop: [{ command: "echo stop" }] },
};
const CODEX_CONFIG =
  '# mine\nmodel = "x"\n\n[hooks.state."elsewhere:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n';

/** The user's own instruction files, which no run may change (AC-10.4). */
const INSTRUCTIONS = {
  ".claude/CLAUDE.md": "# My Claude rules\n",
  ".codex/AGENTS.md": "# My Codex rules\n",
  "AGENTS.md": "# Home agents\n",
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface Files {
  claude: string;
  codex: string;
  cursor: string;
  config: string;
}

function files(sandbox: Sandbox): Files {
  return {
    claude: join(sandbox.home, ".claude", "settings.json"),
    codex: join(sandbox.home, ".codex", "hooks.json"),
    cursor: join(sandbox.home, ".cursor", "hooks.json"),
    config: join(sandbox.home, ".codex", "config.toml"),
  };
}

function setup() {
  const sandbox = makeSandbox();
  stubExecutable(sandbox, "claude");
  stubExecutable(sandbox, "codex");
  stubExecutable(sandbox, "cursor-agent");
  const f = files(sandbox);
  write(f.claude, json(CLAUDE_SETTINGS));
  write(f.codex, json(CODEX_HOOKS));
  write(f.cursor, json(CURSOR_HOOKS));
  write(f.config, CODEX_CONFIG);
  for (const [path, content] of Object.entries(INSTRUCTIONS))
    write(join(sandbox.home, path), content);
  const clock = new FakeClock();
  return { sandbox, f, clock, gateway: new FakeGateway(clock) };
}

function commandFor(sandbox: Sandbox, id: string, executable = sandbox.executable): string {
  return `${shellQuote(executable)} context --harness ${id}`;
}

function expectInstructionsUnchanged(sandbox: Sandbox): void {
  for (const [path, content] of Object.entries(INSTRUCTIONS)) {
    expect(read(join(sandbox.home, path))).toBe(content);
  }
}

describe("hook command", () => {
  it("names the executable unquoted when every character is safe", () => {
    expect(hookCommand("/home/me/.local/bin/agentdesk", "codex")).toBe(
      "/home/me/.local/bin/agentdesk context --harness codex",
    );
  });

  it("single-quotes a path with other characters, and the shell reads it back", () => {
    const path = "/home/me/My Apps/it's $here/agentdesk";
    const command = hookCommand(path, "claude-code");
    expect(command).toBe(
      `'/home/me/My Apps/it'\\''s $here/agentdesk' context --harness claude-code`,
    );
    const echoed = spawnSync("sh", ["-c", `printf '%s' ${shellQuote(path)}`], { encoding: "utf8" });
    expect(echoed.stdout).toBe(path);
    expect(isInstallerCommand(command, "claude-code")).toBe(true);
  });

  it("recognizes only an absolute path ending in /agentdesk with this harness's id", () => {
    expect(isInstallerCommand("/opt/agentdesk context --harness codex", "codex")).toBe(true);
    expect(isInstallerCommand("/opt/agentdesk context --harness codex", "cursor")).toBe(false);
    expect(isInstallerCommand("agentdesk context --harness codex", "codex")).toBe(false);
    expect(isInstallerCommand("/opt/agentdesk.mjs context --harness codex", "codex")).toBe(false);
    expect(isInstallerCommand("/opt/agentdesk context --harness codex; rm x", "codex")).toBe(false);
    expect(isInstallerCommand("echo /opt/agentdesk context --harness codex", "codex")).toBe(false);
  });
});

describe("hooks written by install", () => {
  it("adds one hook per harness and keeps every other key, group, and hook", async () => {
    const { sandbox, f, clock, gateway } = setup();
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(readJson(f.claude)).toEqual({
      ...CLAUDE_SETTINGS,
      hooks: {
        ...CLAUDE_SETTINGS.hooks,
        SessionStart: [
          ...CLAUDE_SETTINGS.hooks.SessionStart,
          {
            matcher: MATCHER,
            hooks: [{ type: "command", command: commandFor(sandbox, "claude-code") }],
          },
        ],
      },
    });
    expect(readJson(f.codex)).toEqual({
      hooks: {
        SessionStart: [
          ...CODEX_HOOKS.hooks.SessionStart,
          { matcher: MATCHER, hooks: [{ type: "command", command: commandFor(sandbox, "codex") }] },
        ],
      },
    });
    expect(readJson(f.cursor)).toEqual({
      ...CURSOR_HOOKS,
      hooks: {
        ...CURSOR_HOOKS.hooks,
        sessionStart: [
          ...CURSOR_HOOKS.hooks.sessionStart,
          { command: commandFor(sandbox, "cursor") },
        ],
      },
    });
    // Each file was copied once, before the run's first edit.
    expect(read(`${f.claude}.agentdesk-backup`)).toBe(json(CLAUDE_SETTINGS));
    expect(read(`${f.codex}.agentdesk-backup`)).toBe(json(CODEX_HOOKS));
    expect(read(`${f.cursor}.agentdesk-backup`)).toBe(json(CURSOR_HOOKS));
    expect(read(`${f.config}.agentdesk-backup`)).toBe(CODEX_CONFIG);
    // No hook file, and no output, holds a token.
    for (const issued of gateway.issued) {
      for (const file of [f.claude, f.codex, f.cursor])
        expect(read(file)).not.toContain(issued.token);
      expect(h.output()).not.toContain(issued.token);
    }
    expect(h.out).toContain(`Claude Code: session-start hook written to ${f.claude}`);
    expect(h.out.at(-1)).toBe(
      "AgentDesk is installed. Start a new agent session: a session that is already running has not loaded the AgentDesk guidance.",
    );
    expectInstructionsUnchanged(sandbox);
  });

  it("creates missing hook files, Cursor's with version 1", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "cursor-agent");
    expect(await makeContext(sandbox).run(["install", "--yes"])).toBe(0);
    const f = files(sandbox);
    expect(readJson(f.claude)).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: MATCHER,
            hooks: [{ type: "command", command: commandFor(sandbox, "claude-code") }],
          },
        ],
      },
    });
    expect(readJson(f.cursor)).toEqual({
      version: 1,
      hooks: { sessionStart: [{ command: commandFor(sandbox, "cursor") }] },
    });
    expect(existsSync(`${f.claude}.agentdesk-backup`)).toBe(false);
  });

  it("writes the exact command with a quoted executable path", async () => {
    const { sandbox, f, clock, gateway } = setup();
    const executable = join(sandbox.root, "My Apps", "it's", "agentdesk");
    const h = makeContext(sandbox, { gateway, clock, executable });
    expect(await h.run(["install", "--yes", "--only", "cursor"])).toBe(0);
    const hooks = readJson(f.cursor).hooks as { sessionStart: { command: string }[] };
    expect(hooks.sessionStart.at(-1)?.command).toBe(
      `'${executable.replace("'", `'\\''`)}' context --harness cursor`,
    );
  });

  it("replaces its hook in place on a re-run and on skill install, keeping its group's position", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    // The user adds a group after the installer's.
    const later = { matcher: "resume", hooks: [{ type: "command", command: "echo later" }] };
    const settings = readJson(f.claude) as typeof CLAUDE_SETTINGS;
    settings.hooks.SessionStart.push(later);
    write(f.claude, json(settings));

    const moved = join(sandbox.root, "moved", "agentdesk");
    const again = makeContext(sandbox, { gateway, clock, executable: moved });
    expect(await again.run(["install", "--yes"])).toBe(0);
    const expected = (command: string) => ({
      ...CLAUDE_SETTINGS,
      hooks: {
        ...CLAUDE_SETTINGS.hooks,
        SessionStart: [
          ...CLAUDE_SETTINGS.hooks.SessionStart,
          { matcher: MATCHER, hooks: [{ type: "command", command }] },
          later,
        ],
      },
    });
    expect(readJson(f.claude)).toEqual(expected(commandFor(sandbox, "claude-code", moved)));

    const third = join(sandbox.root, "third", "agentdesk");
    const skill = makeContext(sandbox, { gateway, clock, executable: third });
    expect(await skill.run(["skill", "install"])).toBe(0);
    expect(readJson(f.claude)).toEqual(expected(commandFor(sandbox, "claude-code", third)));
    const cursor = readJson(f.cursor).hooks as { sessionStart: unknown[] };
    expect(cursor.sessionStart).toEqual([
      ...CURSOR_HOOKS.hooks.sessionStart,
      { command: commandFor(sandbox, "cursor", third) },
    ]);
    expectInstructionsUnchanged(sandbox);
  });

  it("leaves an unchanged hook file untouched on a re-run", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const before = {
      claude: read(f.claude),
      codex: read(f.codex),
      cursor: read(f.cursor),
      config: read(f.config),
    };
    write(`${f.claude}.agentdesk-backup`, "earlier backup\n");
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    expect({
      claude: read(f.claude),
      codex: read(f.codex),
      cursor: read(f.cursor),
      config: read(f.config),
    }).toEqual(before);
    expect(read(`${f.claude}.agentdesk-backup`)).toBe("earlier backup\n");
  });

  const refusals: [string, keyof Files, string][] = [
    ["malformed Claude Code settings", "claude", "{ not json"],
    ["a Claude Code hooks value that is not an object", "claude", '{"hooks": []}\n'],
    ["a Codex SessionStart value that is not a list", "codex", '{"hooks": {"SessionStart": {}}}\n'],
    [
      "a Cursor sessionStart value that is not a list",
      "cursor",
      '{"version": 1, "hooks": {"sessionStart": "x"}}\n',
    ],
  ];

  it.each(refusals)("refuses %s before sign-in and changes nothing", async (_name, which, text) => {
    const { sandbox, f, clock, gateway } = setup();
    write(f[which], text);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(f[which]);
    expect(gateway.startRequests()).toEqual([]);
    expect(read(f[which])).toBe(text);
    expect(read(f.config)).toBe(CODEX_CONFIG);
    expect(existsSync(join(sandbox.home, ".claude.json"))).toBe(false);
    expect(existsSync(statePath(h.ctx))).toBe(false);

    const skill = makeContext(sandbox, { gateway, clock });
    expect(await skill.run(["skill", "install"])).toBe(1);
    expect(read(f[which])).toBe(text);
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses an unreadable hook file before sign-in",
    async () => {
      const { sandbox, f, clock, gateway } = setup();
      chmodSync(f.codex, 0o000);
      try {
        const h = makeContext(sandbox, { gateway, clock });
        expect(await h.run(["install", "--yes"])).toBe(1);
        expect(h.err.join("\n")).toContain(`${f.codex} could not be read`);
        expect(gateway.startRequests()).toEqual([]);
      } finally {
        chmodSync(f.codex, 0o644);
      }
      expect(read(f.codex)).toBe(json(CODEX_HOOKS));
    },
  );
});

describe("hooks in status", () => {
  it("reports a hook removed by hand and an unreadable hook file", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    write(f.claude, json(CLAUDE_SETTINGS));
    write(f.cursor, "{ broken");
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["status"])).toBe(0);
    expect(h.out.find((l) => l.startsWith("Claude Code:"))).toMatch(
      new RegExp(`; no AgentDesk hook in ${f.claude}$`),
    );
    expect(h.out.find((l) => l.startsWith("Cursor:"))).toContain(
      `; hook file unreadable (${f.cursor} is not valid JSON.`,
    );
  });
});

describe("hooks removed by uninstall (AC-9.6)", () => {
  it("removes each hook and its emptied group, and the recorded trust, keeping everything else", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    expect(await makeContext(sandbox, { gateway, clock }).run(["skill", "install"])).toBe(0);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(read(f.claude)).toBe(json(CLAUDE_SETTINGS));
    expect(read(f.codex)).toBe(json(CODEX_HOOKS));
    expect(read(f.cursor)).toBe(json(CURSOR_HOOKS));
    expect(read(f.config)).toBe(CODEX_CONFIG);
    expect(h.out).toContain(`Claude Code: removing the session-start hook from ${f.claude}`);
    expect(h.out).toContain(`Codex: removing the AgentDesk hook's trust from ${f.config}`);
    expect(existsSync(statePath(h.ctx))).toBe(false);
    expectInstructionsUnchanged(sandbox);
  });

  it("keeps a group that still holds another hook", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(
      await makeContext(sandbox, { gateway, clock }).run([
        "install",
        "--yes",
        "--only",
        "claude-code",
      ]),
    ).toBe(0);
    const settings = readJson(f.claude) as typeof CLAUDE_SETTINGS;
    settings.hooks.SessionStart[1]?.hooks.push({ type: "command", command: "echo shared" });
    write(f.claude, json(settings));
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(readJson(f.claude)).toEqual({
      ...CLAUDE_SETTINGS,
      hooks: {
        ...CLAUDE_SETTINGS.hooks,
        SessionStart: [
          ...CLAUDE_SETTINGS.hooks.SessionStart,
          { matcher: MATCHER, hooks: [{ type: "command", command: "echo shared" }] },
        ],
      },
    });
  });

  it("keeps the record and exits 1 when a hook file cannot be parsed", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    write(f.cursor, "{ broken");
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `Cursor: its session-start hook was not removed: ${f.cursor} is not valid JSON.`,
    );
    expect(read(f.cursor)).toBe("{ broken");
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, Record<string, string>>;
    expect(Object.keys(state)).toEqual(["cursor"]);
    expect(state.cursor?.hookPath).toBe(f.cursor);
    // Once the file is fixed, a later uninstall finishes.
    write(f.cursor, json(CURSOR_HOOKS));
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(existsSync(statePath(h.ctx))).toBe(false);
  });

  it("refuses a recorded hook path that is not the harness's own", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(
      await makeContext(sandbox, { gateway, clock }).run(["install", "--yes", "--only", "cursor"]),
    ).toBe(0);
    const file = statePath(makeContext(sandbox).ctx);
    const state = readJson(file) as { harnesses: Record<string, Record<string, string>> };
    const elsewhere = join(sandbox.root, "elsewhere.json");
    (state.harnesses.cursor as Record<string, string>).hookPath = elsewhere;
    write(file, json(state));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`the recorded hook path ${elsewhere} is not ${f.cursor}`);
    expect((readJson(f.cursor).hooks as { sessionStart: unknown[] }).sessionStart).toHaveLength(2);
  });
});
