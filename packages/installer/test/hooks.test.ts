import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessById } from "../src/harnesses.js";
import {
  hookCommand,
  hookEvents,
  isInstallerCommand,
  planHookRemoval,
  shellQuote,
} from "../src/hooks.js";
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
    Stop: [{ hooks: [{ type: "command", command: "echo codex-stop", timeout: 5 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo codex-pre" }] }],
  },
};
const CURSOR_HOOKS = {
  version: 1,
  hooks: {
    sessionStart: [{ command: "echo cursor-mine" }],
    stop: [{ command: "echo stop" }],
    afterMCPExecution: [{ command: "echo after-mcp", timeout: 7 }],
    beforeShellExecution: [{ command: "echo shell" }],
  },
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

/** The command of a resume hook, `<executable> hook <event> --harness <id>`. */
function resumeCommand(
  sandbox: Sandbox,
  event: "stop" | "after-mcp",
  id: string,
  executable = sandbox.executable,
): string {
  return `${shellQuote(executable)} hook ${event} --harness ${id}`;
}

/** The Codex hooks.json the installer leaves when it starts from `CODEX_HOOKS`. */
function codexInstalled(sandbox: Sandbox, executable = sandbox.executable) {
  return {
    hooks: {
      ...CODEX_HOOKS.hooks,
      SessionStart: [
        ...CODEX_HOOKS.hooks.SessionStart,
        {
          matcher: MATCHER,
          hooks: [{ type: "command", command: commandFor(sandbox, "codex", executable) }],
        },
      ],
      Stop: [
        ...CODEX_HOOKS.hooks.Stop,
        {
          hooks: [
            {
              type: "command",
              command: resumeCommand(sandbox, "stop", "codex", executable),
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

/** The Cursor hooks.json the installer leaves when it starts from `CURSOR_HOOKS`. */
function cursorInstalled(sandbox: Sandbox, executable = sandbox.executable) {
  return {
    ...CURSOR_HOOKS,
    hooks: {
      ...CURSOR_HOOKS.hooks,
      sessionStart: [
        ...CURSOR_HOOKS.hooks.sessionStart,
        { command: commandFor(sandbox, "cursor", executable) },
      ],
      afterMCPExecution: [
        ...CURSOR_HOOKS.hooks.afterMCPExecution,
        { command: resumeCommand(sandbox, "after-mcp", "cursor", executable) },
      ],
      stop: [
        ...CURSOR_HOOKS.hooks.stop,
        {
          command: resumeCommand(sandbox, "stop", "cursor", executable),
          timeout: 3600,
          loop_limit: null,
        },
      ],
    },
  };
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

  it("names the resume hook commands, quoted like the session-start hook", () => {
    expect(hookCommand("/home/me/.local/bin/agentdesk", "codex", "stop")).toBe(
      "/home/me/.local/bin/agentdesk hook stop --harness codex",
    );
    expect(hookCommand("/home/me/My Apps/agentdesk", "cursor", "after-mcp")).toBe(
      "'/home/me/My Apps/agentdesk' hook after-mcp --harness cursor",
    );
    expect(
      isInstallerCommand(
        "'/home/me/My Apps/agentdesk' hook after-mcp --harness cursor",
        "cursor",
        "after-mcp",
      ),
    ).toBe(true);
  });

  it("tells the context, stop, and after-mcp commands and each harness apart", () => {
    const stop = "/opt/agentdesk hook stop --harness codex";
    expect(isInstallerCommand(stop, "codex", "stop")).toBe(true);
    expect(isInstallerCommand(stop, "codex", "session-start")).toBe(false);
    expect(isInstallerCommand(stop, "codex", "after-mcp")).toBe(false);
    expect(isInstallerCommand(stop, "cursor", "stop")).toBe(false);
    expect(isInstallerCommand("/opt/agentdesk context --harness codex", "codex", "stop")).toBe(
      false,
    );
    const afterMcp = "/opt/agentdesk hook after-mcp --harness cursor";
    expect(isInstallerCommand(afterMcp, "cursor", "after-mcp")).toBe(true);
    expect(isInstallerCommand(afterMcp, "cursor", "stop")).toBe(false);
    expect(isInstallerCommand("agentdesk hook stop --harness codex", "codex", "stop")).toBe(false);
    expect(
      isInstallerCommand("/opt/agentdesk.mjs hook stop --harness codex", "codex", "stop"),
    ).toBe(false);
    expect(
      isInstallerCommand("/opt/agentdesk hook stop --harness codex; rm x", "codex", "stop"),
    ).toBe(false);
    expect(
      isInstallerCommand("echo /opt/agentdesk hook stop --harness codex", "codex", "stop"),
    ).toBe(false);
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
    // Codex gets its Stop group and Cursor its afterMCPExecution and stop
    // entries; Claude Code gets no resume hook (DEC-15(3)).
    expect(readJson(f.codex)).toEqual(codexInstalled(sandbox));
    expect(readJson(f.cursor)).toEqual(cursorInstalled(sandbox));
    expect(Object.keys(readJson(f.claude).hooks as object).sort()).toEqual([
      "PreToolUse",
      "SessionStart",
    ]);
    // Each file was copied once, before the run's first edit, though Codex's
    // and Cursor's files gained several hooks and config.toml several tables.
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
    expect(h.out).toContain(`Codex: Stop hook written to ${f.codex}`);
    expect(h.out).toContain(`Cursor: afterMCPExecution hook written to ${f.cursor}`);
    expect(h.out).toContain(`Cursor: stop hook written to ${f.cursor}`);
    expect(
      h.out.filter((line) => line.startsWith("Claude Code:") && line.includes("Stop")),
    ).toEqual([]);
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
      hooks: {
        sessionStart: [{ command: commandFor(sandbox, "cursor") }],
        afterMCPExecution: [{ command: resumeCommand(sandbox, "after-mcp", "cursor") }],
        stop: [
          { command: resumeCommand(sandbox, "stop", "cursor"), timeout: 3600, loop_limit: null },
        ],
      },
    });
    // The exact text: a Stop entry keeps "loop_limit": null rather than dropping it.
    expect(read(f.cursor)).toContain('"timeout": 3600,\n        "loop_limit": null\n');
    expect(existsSync(`${f.claude}.agentdesk-backup`)).toBe(false);
    expect(existsSync(`${f.cursor}.agentdesk-backup`)).toBe(false);
  });

  it("creates Codex's hooks.json with the session-start group and a Stop group without a matcher", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    expect(await makeContext(sandbox).run(["install", "--yes"])).toBe(0);
    expect(readJson(files(sandbox).codex)).toEqual({
      hooks: {
        SessionStart: [
          { matcher: MATCHER, hooks: [{ type: "command", command: commandFor(sandbox, "codex") }] },
        ],
        Stop: [
          {
            hooks: [
              { type: "command", command: resumeCommand(sandbox, "stop", "codex"), timeout: 10 },
            ],
          },
        ],
      },
    });
  });

  it("writes the exact command with a quoted executable path", async () => {
    const { sandbox, f, clock, gateway } = setup();
    const executable = join(sandbox.root, "My Apps", "it's", "agentdesk");
    const h = makeContext(sandbox, { gateway, clock, executable });
    expect(await h.run(["install", "--yes", "--only", "cursor,codex"])).toBe(0);
    const quoted = `'${executable.replace("'", `'\\''`)}'`;
    const cursor = readJson(f.cursor).hooks as Record<string, { command: string }[]>;
    expect(cursor.sessionStart?.at(-1)?.command).toBe(`${quoted} context --harness cursor`);
    expect(cursor.afterMCPExecution?.at(-1)?.command).toBe(
      `${quoted} hook after-mcp --harness cursor`,
    );
    expect(cursor.stop?.at(-1)?.command).toBe(`${quoted} hook stop --harness cursor`);
    const codex = readJson(f.codex).hooks as Record<string, { hooks: { command: string }[] }[]>;
    expect(codex.Stop?.at(-1)?.hooks[0]?.command).toBe(`${quoted} hook stop --harness codex`);
    // The shell reads the quoted path back as the executable.
    const echoed = spawnSync("sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
    expect(echoed.stdout).toBe(executable);
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

  it("replaces the resume hooks in place on a re-run and on skill install, restoring their timeouts", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    // The user edits the installer's resume entries and adds their own after them.
    const codex = readJson(f.codex) as ReturnType<typeof codexInstalled>;
    const codexStop = codex.hooks.Stop[1]?.hooks[0] as Record<string, unknown>;
    codexStop.timeout = 30;
    codexStop.statusMessage = "mine";
    const laterStop = { hooks: [{ type: "command", command: "echo later-stop" }] };
    codex.hooks.Stop.push(laterStop as (typeof codex.hooks.Stop)[number]);
    write(f.codex, json(codex));
    const cursor = readJson(f.cursor) as { hooks: Record<string, Record<string, unknown>[]> };
    const cursorStop = cursor.hooks.stop?.[1] as Record<string, unknown>;
    cursorStop.timeout = 5;
    delete cursorStop.loop_limit;
    cursor.hooks.stop?.push({ command: "echo later-stop" });
    cursor.hooks.afterMCPExecution?.push({ command: "echo later-after" });
    write(f.cursor, json(cursor));

    const expectRefreshed = (executable: string) => {
      const codexNow = codexInstalled(sandbox, executable);
      const ours = codexNow.hooks.Stop[1]?.hooks[0] as Record<string, unknown>;
      ours.statusMessage = "mine";
      codexNow.hooks.Stop.push(laterStop as (typeof codexNow.hooks.Stop)[number]);
      expect(readJson(f.codex)).toEqual(codexNow);
      const cursorNow = cursorInstalled(sandbox, executable);
      expect(readJson(f.cursor)).toEqual({
        ...cursorNow,
        hooks: {
          ...cursorNow.hooks,
          stop: [...cursorNow.hooks.stop, { command: "echo later-stop" }],
          afterMCPExecution: [
            ...cursorNow.hooks.afterMCPExecution,
            { command: "echo later-after" },
          ],
        },
      });
    };

    const moved = join(sandbox.root, "moved", "agentdesk");
    expect(
      await makeContext(sandbox, { gateway, clock, executable: moved }).run(["install", "--yes"]),
    ).toBe(0);
    expectRefreshed(moved);

    const third = join(sandbox.root, "third", "agentdesk");
    write(`${f.codex}.agentdesk-backup`, "earlier backup\n");
    const before = read(f.codex);
    expect(
      await makeContext(sandbox, { gateway, clock, executable: third }).run(["skill", "install"]),
    ).toBe(0);
    expectRefreshed(third);
    // The skill install's own backup holds the file as that run found it.
    expect(read(`${f.codex}.agentdesk-backup`)).toBe(before);
    expect(read(`${f.claude}`)).not.toContain("hook stop");
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
    // An explicit null is a value of the wrong type, not an absent key.
    ["a Claude Code hooks value of null", "claude", '{"model": "opus", "hooks": null}\n'],
    ["a Claude Code SessionStart value of null", "claude", '{"hooks": {"SessionStart": null}}\n'],
    ["a Codex hooks value of null", "codex", '{"hooks": null}\n'],
    ["a Codex SessionStart value of null", "codex", '{"hooks": {"SessionStart": null}}\n'],
    ["a Cursor hooks value of null", "cursor", '{"version": 1, "hooks": null}\n'],
    [
      "a Cursor sessionStart value of null",
      "cursor",
      '{"version": 1, "hooks": {"sessionStart": null}}\n',
    ],
    // The resume hooks' events are checked before anything is written, too.
    ["a Codex Stop value that is not a list", "codex", '{"hooks": {"Stop": {"hooks": []}}}\n'],
    ["a Codex Stop value of null", "codex", '{"hooks": {"SessionStart": [], "Stop": null}}\n'],
    ["a Cursor stop value that is not a list", "cursor", '{"version": 1, "hooks": {"stop": {}}}\n'],
    ["a Cursor stop value of null", "cursor", '{"version": 1, "hooks": {"stop": null}}\n'],
    [
      "a Cursor afterMCPExecution value that is not a list",
      "cursor",
      '{"version": 1, "hooks": {"afterMCPExecution": "x"}}\n',
    ],
    [
      "a Cursor afterMCPExecution value of null",
      "cursor",
      '{"version": 1, "hooks": {"sessionStart": [], "afterMCPExecution": null}}\n',
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
    // No other hook file was written either.
    const originals = { claude: CLAUDE_SETTINGS, codex: CODEX_HOOKS, cursor: CURSOR_HOOKS };
    for (const other of ["claude", "codex", "cursor"] as const) {
      if (other !== which) expect(read(f[other])).toBe(json(originals[other]));
      expect(existsSync(`${f[other]}.agentdesk-backup`)).toBe(false);
    }
    expect(existsSync(join(sandbox.home, ".claude.json"))).toBe(false);
    expect(existsSync(statePath(h.ctx))).toBe(false);

    const skill = makeContext(sandbox, { gateway, clock });
    expect(await skill.run(["skill", "install"])).toBe(1);
    expect(read(f[which])).toBe(text);
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk"))).toBe(false);
    for (const other of ["claude", "codex", "cursor"] as const) {
      if (other !== which) expect(read(f[other])).toBe(json(originals[other]));
    }
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
      new RegExp(`; no AgentDesk session-start hook in ${f.claude}$`),
    );
    expect(h.out.find((l) => l.startsWith("Cursor:"))).toContain(
      `; hook file unreadable (${f.cursor} is not valid JSON.`,
    );
  });

  it("reports each resume hook beside the session-start hook, missing or unreadable", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const all = makeContext(sandbox, { gateway, clock });
    expect(await all.run(["status"])).toBe(0);
    expect(all.out.find((l) => l.startsWith("Cursor:"))).toMatch(
      new RegExp(
        `; session-start hook in ${f.cursor}; afterMCPExecution hook in ${f.cursor}; stop hook in ${f.cursor}$`,
      ),
    );
    expect(all.out.find((l) => l.startsWith("Codex:"))).toMatch(
      new RegExp(
        `; session-start hook in ${f.codex}, trust trusted; Stop hook in ${f.codex}, trust trusted$`,
      ),
    );

    // The user removes Cursor's stop entry and breaks Codex's Stop value.
    const cursor = readJson(f.cursor) as { hooks: Record<string, unknown[]> };
    cursor.hooks.stop = CURSOR_HOOKS.hooks.stop;
    write(f.cursor, json(cursor));
    const codex = readJson(f.codex) as { hooks: Record<string, unknown> };
    codex.hooks.Stop = { broken: true };
    write(f.codex, json(codex));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["status"])).toBe(0);
    expect(h.out.find((l) => l.startsWith("Cursor:"))).toMatch(
      new RegExp(
        `; session-start hook in ${f.cursor}; afterMCPExecution hook in ${f.cursor}; no AgentDesk stop hook in ${f.cursor}$`,
      ),
    );
    expect(h.out.find((l) => l.startsWith("Codex:"))).toMatch(
      new RegExp(
        `; session-start hook in ${f.codex}, trust trusted; Stop hook unreadable \\(${f.codex} has a hooks\\.Stop value that is not a list; it was not changed\\.\\)$`,
      ),
    );
    // Claude Code has no resume hook to report.
    expect(h.out.find((l) => l.startsWith("Claude Code:"))).toMatch(
      new RegExp(`; session-start hook in ${f.claude}$`),
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
    expect(h.out).toContain(`Codex: removing the session-start hook from ${f.codex}`);
    expect(h.out).toContain(`Codex: removing the Stop hook from ${f.codex}`);
    expect(h.out).toContain(`Cursor: removing the afterMCPExecution hook from ${f.cursor}`);
    expect(h.out).toContain(`Cursor: removing the stop hook from ${f.cursor}`);
    expect(h.out).toContain(`Codex: removing the AgentDesk hooks' trust from ${f.config}`);
    expect(existsSync(statePath(h.ctx))).toBe(false);
    // No hook file held a token at any point.
    for (const issued of gateway.issued) {
      for (const file of [f.claude, f.codex, f.cursor]) {
        expect(read(file)).not.toContain(issued.token);
        expect(read(`${file}.agentdesk-backup`)).not.toContain(issued.token);
      }
    }
    expectInstructionsUnchanged(sandbox);
  });

  it("removes the resume hooks' emptied groups and keeps a group that still holds another hook", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    // The user adds a handler to the installer's Stop group and a group after it.
    const codex = readJson(f.codex) as ReturnType<typeof codexInstalled>;
    const shared = { type: "command", command: "echo shared-stop" };
    codex.hooks.Stop[1]?.hooks.push(shared as (typeof codex.hooks.Stop)[number]["hooks"][number]);
    const laterStop = { hooks: [{ type: "command", command: "echo later-stop", timeout: 5 }] };
    codex.hooks.Stop.push(laterStop);
    write(f.codex, json(codex));
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(readJson(f.codex)).toEqual({
      hooks: {
        ...CODEX_HOOKS.hooks,
        Stop: [...CODEX_HOOKS.hooks.Stop, { hooks: [shared] }, laterStop],
      },
    });
    expect(read(f.cursor)).toBe(json(CURSOR_HOOKS));
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
      `Cursor: its hooks were not removed: ${f.cursor} is not valid JSON.`,
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

  it("keeps the record and changes nothing when a resume hook's event cannot be read", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const cursor = readJson(f.cursor) as { hooks: Record<string, unknown> };
    cursor.hooks.afterMCPExecution = "x";
    const broken = json(cursor);
    write(f.cursor, broken);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `Cursor: its hooks were not removed: ${f.cursor} has a hooks.afterMCPExecution value that is not a list`,
    );
    // The session-start and stop entries stay too: the file is refused as a whole.
    expect(read(f.cursor)).toBe(broken);
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, Record<string, string>>;
    expect(state.cursor).toMatchObject({
      hookPath: f.cursor,
      stopHookPath: f.cursor,
      afterMcpHookPath: f.cursor,
    });
  });

  it("removes only the session-start hook a record from before the resume hooks names", async () => {
    const { sandbox, f, clock, gateway } = setup();
    expect(
      await makeContext(sandbox, { gateway, clock }).run(["install", "--yes", "--only", "cursor"]),
    ).toBe(0);
    // An installer before the resume hooks wrote no resume entries and recorded none.
    const file = statePath(makeContext(sandbox).ctx);
    const state = readJson(file) as { harnesses: Record<string, Record<string, string>> };
    delete state.harnesses.cursor?.stopHookPath;
    delete state.harnesses.cursor?.afterMcpHookPath;
    write(file, json(state));
    const hooks = readJson(f.cursor) as { hooks: Record<string, unknown[]> };
    hooks.hooks.stop = CURSOR_HOOKS.hooks.stop;
    hooks.hooks.afterMCPExecution = CURSOR_HOOKS.hooks.afterMCPExecution;
    write(f.cursor, json(hooks));

    const status = makeContext(sandbox, { gateway, clock });
    expect(await status.run(["status"])).toBe(0);
    expect(status.out.find((l) => l.startsWith("Cursor:"))).toMatch(
      new RegExp(`; session-start hook in ${f.cursor}$`),
    );
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(read(f.cursor)).toBe(json(CURSOR_HOOKS));
  });

  it.each([
    ["stopHookPath", "cursor"],
    ["afterMcpHookPath", "cursor"],
    ["stopHookPath", "codex"],
  ] as const)("refuses a recorded %s for %s that is not the harness's own", async (field, id) => {
    const { sandbox, f, clock, gateway } = setup();
    expect(
      await makeContext(sandbox, { gateway, clock }).run(["install", "--yes", "--only", id]),
    ).toBe(0);
    const file = statePath(makeContext(sandbox).ctx);
    const state = readJson(file) as { harnesses: Record<string, Record<string, string>> };
    const elsewhere = join(sandbox.root, "elsewhere.json");
    write(elsewhere, json(id === "codex" ? codexInstalled(sandbox) : cursorInstalled(sandbox)));
    (state.harnesses[id] as Record<string, string>)[field] = elsewhere;
    write(file, json(state));
    const hookFile = id === "codex" ? f.codex : f.cursor;
    const before = read(hookFile);
    const configBefore = read(f.config);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`the recorded hook path ${elsewhere} is not ${hookFile}`);
    expect(read(hookFile)).toBe(before);
    expect(read(elsewhere)).toBe(
      json(id === "codex" ? codexInstalled(sandbox) : cursorInstalled(sandbox)),
    );
    expect(read(f.config)).toBe(configBefore);
    expect(gateway.revoked).toEqual([]);
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

describe("removal plan", () => {
  it("keys each moved hook by its event, so the same positions in SessionStart and Stop stay apart", () => {
    const sandbox = makeSandbox();
    const ctx = makeContext(sandbox).ctx;
    const codex = harnessById(ctx, "codex");
    const ours = (event: "context" | "hook stop") => ({
      type: "command",
      command: `/opt/agentdesk ${event} --harness codex`,
    });
    const user = (command: string) => ({ type: "command", command });
    const text = json({
      hooks: {
        SessionStart: [
          { matcher: MATCHER, hooks: [ours("context")] },
          { hooks: [user("echo a"), user("echo b")] },
        ],
        Stop: [
          { hooks: [user("echo shared"), ours("hook stop"), user("echo after")] },
          { hooks: [user("echo c")] },
        ],
        PreToolUse: [{ hooks: [user("echo untouched")] }],
      },
    });
    write(files(sandbox).codex, text);
    const removal = planHookRemoval(ctx, codex, hookEvents(codex));
    expect(removal?.removed).toEqual(["session-start", "stop"]);
    expect(removal?.original).toBe(text);
    expect(Object.fromEntries(removal?.moved ?? [])).toEqual({
      // The emptied SessionStart group goes, so the next group moves up.
      "session_start:1:0": "session_start:0:0",
      "session_start:1:1": "session_start:0:1",
      // The shared Stop group stays; the handler after ours moves within it.
      "stop:0:2": "stop:0:1",
    });
    expect(JSON.parse(removal?.text ?? "{}")).toEqual({
      hooks: {
        SessionStart: [{ hooks: [user("echo a"), user("echo b")] }],
        Stop: [{ hooks: [user("echo shared"), user("echo after")] }, { hooks: [user("echo c")] }],
        PreToolUse: [{ hooks: [user("echo untouched")] }],
      },
    });
  });

  it("plans only the events it is given, and leaves an absent event absent", () => {
    const sandbox = makeSandbox();
    const ctx = makeContext(sandbox).ctx;
    const cursor = harnessById(ctx, "cursor");
    const text = json({
      version: 1,
      hooks: {
        sessionStart: [{ command: "/opt/agentdesk context --harness cursor" }],
        stop: [{ command: "/opt/agentdesk hook stop --harness cursor", timeout: 3600 }],
      },
    });
    write(files(sandbox).cursor, text);
    const sessionOnly = hookEvents(cursor).filter((event) => event.id === "session-start");
    const removal = planHookRemoval(ctx, cursor, sessionOnly);
    expect(removal?.removed).toEqual(["session-start"]);
    expect(JSON.parse(removal?.text ?? "{}")).toEqual({
      version: 1,
      hooks: {
        sessionStart: [],
        stop: [{ command: "/opt/agentdesk hook stop --harness cursor", timeout: 3600 }],
      },
    });
    const all = planHookRemoval(ctx, cursor, hookEvents(cursor));
    expect(all?.removed).toEqual(["session-start", "stop"]);
    expect(JSON.parse(all?.text ?? "{}")).toEqual({
      version: 1,
      hooks: { sessionStart: [], stop: [] },
    });
  });
});

// component-installer §Standing guidance; DEC-24(1)-(2): Antigravity's
// hooks.json holds named hook objects at its top level, and the installer owns
// the object `agentdesk`, whose SessionStart holds one handler with a 30-second
// timeout. Antigravity runs the hook with no trust step.
describe("Antigravity's named hook", () => {
  const OTHER_HOOKS = {
    "lint-on-stop": { Stop: [{ type: "command", command: "echo lint", timeout: 5 }] },
    audit: { PreToolUse: [{ type: "command", command: "echo audit" }] },
  };
  /**
   * Instruction files no run may change (AC-10.4), Antigravity's own
   * GEMINI.md among them; none sits under ~/.codex, which would detect Codex.
   */
  const AGY_INSTRUCTIONS = {
    ".claude/CLAUDE.md": "# My Claude rules\n",
    "AGENTS.md": "# Home agents\n",
    ".gemini/GEMINI.md": "# My Gemini rules\n",
  };

  function agySetup(hooks?: string) {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "agy");
    const config = join(sandbox.home, ".gemini", "config");
    const file = join(config, "hooks.json");
    const mcp = join(config, "mcp_config.json");
    const skill = join(config, "skills", "agentdesk", "SKILL.md");
    if (hooks !== undefined) write(file, hooks);
    for (const [path, content] of Object.entries(AGY_INSTRUCTIONS))
      write(join(sandbox.home, path), content);
    const clock = new FakeClock();
    return { sandbox, file, mcp, skill, clock, gateway: new FakeGateway(clock) };
  }

  function owned(sandbox: Sandbox, executable = sandbox.executable) {
    return {
      SessionStart: [
        { type: "command", command: commandFor(sandbox, "antigravity", executable), timeout: 30 },
      ],
    };
  }

  function instructionsUnchanged(sandbox: Sandbox) {
    for (const [path, content] of Object.entries(AGY_INSTRUCTIONS)) {
      expect(read(join(sandbox.home, path))).toBe(content);
    }
  }

  it("writes the agentdesk object beside other named hooks and keeps them", async () => {
    const { sandbox, file, clock, gateway } = agySetup(json(OTHER_HOOKS));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(read(file)).toBe(json({ ...OTHER_HOOKS, agentdesk: owned(sandbox) }));
    expect(read(`${file}.agentdesk-backup`)).toBe(json(OTHER_HOOKS));
    expect(h.out).toContain(`Antigravity: session-start hook written to ${file}`);
    // No trust step: nothing names /hooks or trust for Antigravity.
    expect(h.output()).not.toMatch(/Antigravity:.*trust/);
    expect(read(file)).not.toContain(gateway.tokenFor("antigravity"));
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, Record<string, string>>;
    expect(state.antigravity?.hookPath).toBe(file);
    expect(Object.keys(state.antigravity ?? {})).not.toContain("codexTrustKey");
    instructionsUnchanged(sandbox);
  });

  it.each([
    ["is absent", undefined],
    ["is empty", ""],
  ])("creates the agentdesk object when hooks.json %s", async (_label, text) => {
    const { sandbox, file, clock, gateway } = agySetup(text);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    expect(read(file)).toBe(json({ agentdesk: owned(sandbox) }));
  });

  it("writes the exact command with a quoted executable path", async () => {
    const { sandbox, file, clock, gateway } = agySetup();
    const executable = join(sandbox.root, "my apps", "agentdesk");
    const h = makeContext(sandbox, { gateway, clock, executable });
    expect(await h.run(["install", "--yes"])).toBe(0);
    const command = `'${executable}' context --harness antigravity`;
    expect(readJson(file)).toEqual({
      agentdesk: { SessionStart: [{ type: "command", command, timeout: 30 }] },
    });
    expect(isInstallerCommand(command, "antigravity")).toBe(true);
    expect(isInstallerCommand(command, "cursor")).toBe(false);
  });

  it("reports the hook and skill unchanged on a re-run and leaves the files untouched", async () => {
    const { sandbox, file, mcp, skill, clock, gateway } = agySetup(json(OTHER_HOOKS));
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const before = { hooks: read(file), mcp: read(mcp), skill: read(skill) };
    write(`${file}.agentdesk-backup`, "earlier backup\n");
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.out).toContain("Antigravity: connection works; keeping it.");
    expect(h.out).toContain(`Antigravity: session-start hook unchanged in ${file}`);
    expect(h.out).toContain(`Antigravity: skill 1.0.0 unchanged in ${join(skill, "..")}`);
    expect(gateway.startRequests()).toHaveLength(1);
    expect({ hooks: read(file), mcp: read(mcp), skill: read(skill) }).toEqual(before);
    expect(read(`${file}.agentdesk-backup`)).toBe("earlier backup\n");
  });

  it("replaces an older command in place on a re-run and on skill install, with no duplicate", async () => {
    const { sandbox, file, clock, gateway } = agySetup();
    const older = "/opt/old/agentdesk";
    write(
      file,
      json({ first: OTHER_HOOKS.audit, agentdesk: owned(sandbox, older), last: OTHER_HOOKS.audit }),
    );
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.out).toContain(`Antigravity: session-start hook written to ${file}`);
    const expected = json({
      first: OTHER_HOOKS.audit,
      agentdesk: owned(sandbox),
      last: OTHER_HOOKS.audit,
    });
    expect(read(file)).toBe(expected);

    // skill install rewrites it again with the running executable.
    write(
      file,
      json({ first: OTHER_HOOKS.audit, agentdesk: owned(sandbox, older), last: OTHER_HOOKS.audit }),
    );
    const skill = makeContext(sandbox, { gateway, clock });
    expect(await skill.run(["skill", "install"])).toBe(0);
    expect(read(file)).toBe(expected);
  });

  const agyRefusals: [string, string][] = [
    ["malformed JSON", "{ not json"],
    ["a top-level list", "[]\n"],
    ["an agentdesk value that is not an object", '{"agentdesk": []}\n'],
    ["an agentdesk value of null", '{"agentdesk": null}\n'],
    ["an agentdesk event value that is not a list", '{"agentdesk": {"SessionStart": {}}}\n'],
    [
      "a foreign handler in agentdesk's SessionStart",
      json({ agentdesk: { SessionStart: [{ type: "command", command: "echo mine" }] } }),
    ],
    [
      "a foreign handler under another event in agentdesk",
      json({ agentdesk: { Stop: [{ type: "command", command: "echo mine" }] } }),
    ],
    [
      "another harness's command in agentdesk",
      json({
        agentdesk: {
          SessionStart: [
            { type: "command", command: "/usr/bin/agentdesk context --harness cursor" },
          ],
        },
      }),
    ],
    ["a handler that is not an object", '{"agentdesk": {"SessionStart": ["echo"]}}\n'],
  ];

  it.each(agyRefusals)("refuses %s before sign-in and changes nothing", async (_name, text) => {
    const { sandbox, file, mcp, skill, clock, gateway } = agySetup(text);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(file);
    expect(gateway.requests).toEqual([]);
    expect(read(file)).toBe(text);
    expect(existsSync(`${file}.agentdesk-backup`)).toBe(false);
    expect(existsSync(mcp)).toBe(false);
    expect(existsSync(statePath(h.ctx))).toBe(false);

    const again = makeContext(sandbox, { gateway, clock });
    expect(await again.run(["skill", "install"])).toBe(1);
    expect(read(file)).toBe(text);
    expect(existsSync(skill)).toBe(false);
  });

  it("names the foreign handler's fix in the refusal", async () => {
    const text = json({ agentdesk: { SessionStart: [{ type: "command", command: "echo mine" }] } });
    const { sandbox, file, clock, gateway } = agySetup(text);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `${file} has a handler in its agentdesk hook that AgentDesk did not write; it was not changed.`,
    );
  });

  it("reports the hook in status with no trust, and a hook removed by hand", async () => {
    const { sandbox, file, clock, gateway } = agySetup(json(OTHER_HOOKS));
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["status"])).toBe(0);
    const skillDir = join(sandbox.home, ".gemini", "config", "skills", "agentdesk");
    expect(h.out.find((l) => l.startsWith("Antigravity:"))).toMatch(
      new RegExp(
        `^Antigravity: connected; skill \\S+ at ${skillDir}; session-start hook in ${file}$`,
      ),
    );

    write(file, json(OTHER_HOOKS));
    const after = makeContext(sandbox, { gateway, clock });
    expect(await after.run(["status"])).toBe(0);
    expect(after.out.find((l) => l.startsWith("Antigravity:"))).toMatch(
      new RegExp(`; no AgentDesk session-start hook in ${file}$`),
    );
  });

  it("uninstall removes the agentdesk object whole and keeps other named hooks", async () => {
    const { sandbox, file, mcp, skill, clock, gateway } = agySetup(json(OTHER_HOOKS));
    write(mcp, json({ mcpServers: { linear: { serverUrl: "https://linear" } } }));
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const token = gateway.tokenFor("antigravity");
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(`Antigravity: removing the session-start hook from ${file}`);
    expect(gateway.revoked).toEqual([token]);
    expect(read(file)).toBe(json(OTHER_HOOKS));
    expect(readJson(mcp)).toEqual({ mcpServers: { linear: { serverUrl: "https://linear" } } });
    expect(existsSync(join(skill, ".."))).toBe(false);
    expect(existsSync(statePath(h.ctx))).toBe(false);
    instructionsUnchanged(sandbox);
  });

  it("uninstall removes an agentdesk object that holds no handler", async () => {
    const { sandbox, file, clock, gateway } = agySetup(json(OTHER_HOOKS));
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    write(file, json({ ...OTHER_HOOKS, agentdesk: { SessionStart: [] } }));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(`Antigravity: removing the AgentDesk hooks from ${file}`);
    expect(read(file)).toBe(json(OTHER_HOOKS));
  });

  it("refuses to remove an agentdesk object that gained a foreign handler, and keeps the record", async () => {
    const { sandbox, file, clock, gateway } = agySetup(json(OTHER_HOOKS));
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const ownedNow = owned(sandbox);
    const tampered = json({
      ...OTHER_HOOKS,
      agentdesk: {
        SessionStart: [...ownedNow.SessionStart, { type: "command", command: "echo mine" }],
      },
    });
    write(file, tampered);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `Antigravity: its hooks were not removed: ${file} has a handler in its agentdesk hook that AgentDesk did not write`,
    );
    expect(read(file)).toBe(tampered);
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, Record<string, string>>;
    expect(state.antigravity?.hookPath).toBe(file);
    // Once the handler moves to its own named hook, a later uninstall finishes.
    write(file, json({ ...OTHER_HOOKS, mine: { SessionStart: [{ command: "echo mine" }] } }));
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(readJson(file)).toEqual({
      ...OTHER_HOOKS,
      mine: { SessionStart: [{ command: "echo mine" }] },
    });
    expect(existsSync(statePath(h.ctx))).toBe(false);
  });

  it("plans the removal of the agentdesk object only", () => {
    const { sandbox, file } = agySetup();
    write(file, json({ ...OTHER_HOOKS, agentdesk: owned(sandbox) }));
    const { ctx } = makeContext(sandbox);
    const harness = harnessById(ctx, "antigravity");
    const removal = planHookRemoval(ctx, harness, hookEvents(harness));
    expect(removal?.removed).toEqual(["session-start"]);
    expect(removal?.moved.size).toBe(0);
    expect(removal?.text).toBe(json(OTHER_HOOKS));
    write(file, json(OTHER_HOOKS));
    expect(planHookRemoval(ctx, harness, hookEvents(harness))).toBeUndefined();
  });
});
