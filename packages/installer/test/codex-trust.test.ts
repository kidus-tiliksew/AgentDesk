import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCodexHooks } from "../src/codex-trust.js";
import { editCodexTrust } from "../src/config.js";
import { InstallerError } from "../src/context.js";
import { statePath } from "../src/state.js";
import {
  appServerMessages,
  cleanupSandboxes,
  codexHookHash,
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

// component-installer §Codex trust: after writing hooks.json, the installer
// asks `codex app-server` for the hook's key and hash and records them as
// `[hooks.state."<key>"] trusted_hash` in config.toml. The stub codex speaks
// the app-server JSON-RPC over stdio and interleaves notifications and a
// server request with its answers (test/fixtures/fake-harness.mjs).

const MATCHER = "startup|clear|compact";
const TRUST_STEP = "In Codex, run /hooks and trust the AgentDesk session-start hook.";
const STOP_STEP = "In Codex, run /hooks and trust the AgentDesk Stop hook.";
const CONFIG = `# mine\nmodel = "x"\n\n[hooks.state."elsewhere:session_start:0:0"] # theirs\ntrusted_hash = "sha256:abc"\n\n[mcp_servers.github]\ncommand = "gh"\n`;

function setup(env: Record<string, string> = {}, onPath = true) {
  const sandbox = makeSandbox();
  if (onPath) stubExecutable(sandbox, "codex");
  const codexHome = join(sandbox.home, ".codex");
  write(join(codexHome, "config.toml"), CONFIG);
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  const context = (extra: Record<string, string> = {}) =>
    makeContext(sandbox, { gateway, clock, env: { ...env, ...extra } });
  return {
    sandbox,
    clock,
    gateway,
    context,
    hooksFile: join(codexHome, "hooks.json"),
    config: join(codexHome, "config.toml"),
  };
}

function ourCommand(sandbox: Sandbox, executable = sandbox.executable): string {
  return `${executable} context --harness codex`;
}

function ourStop(sandbox: Sandbox, executable = sandbox.executable): string {
  return `${executable} hook stop --harness codex`;
}

type KeyEvent = "session_start" | "stop";

function keyOf(hooksFile: string, group: number, event: KeyEvent = "session_start"): string {
  return `${realpathSync(hooksFile)}:${event}:${group}:0`;
}

function hashOf(command: string, matcher = MATCHER): string {
  return codexHookHash(matcher, { type: "command", command });
}

/** The Stop hook's hash; a `timeout` of null hashes a handler without one. */
function stopHashOf(command: string, timeout: number | null = 10): string {
  const handler =
    timeout === null ? { type: "command", command } : { type: "command", command, timeout };
  return codexHookHash(undefined, handler, "stop");
}

function trustTable(key: string, hash: string): string {
  return `\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"\n`;
}

/** The two tables install records: the session-start hook's, then the Stop hook's. */
function ourTrust(
  sandbox: Sandbox,
  hooksFile: string,
  groups: { session: number; stop: number } = { session: 0, stop: 0 },
  executable = sandbox.executable,
): string {
  return (
    trustTable(keyOf(hooksFile, groups.session), hashOf(ourCommand(sandbox, executable))) +
    trustTable(keyOf(hooksFile, groups.stop, "stop"), stopHashOf(ourStop(sandbox, executable)))
  );
}

function mcpTable(gateway: FakeGateway): string {
  return `\n[mcp_servers.agentdesk]\nurl = "https://agentdesk.test/mcp"\nhttp_headers = { "Authorization" = "Bearer ${gateway.tokenFor("codex")}" }\n`;
}

function stateRecord(sandbox: Sandbox): Record<string, string> {
  const harnesses = readJson(statePath(makeContext(sandbox).ctx)).harnesses as Record<
    string,
    Record<string, string>
  >;
  return harnesses.codex ?? {};
}

interface HooksJson {
  hooks: { SessionStart: unknown[]; Stop: unknown[] };
}

/** Each listed hook as [command, key, trustStatus]. */
async function listed(sandbox: Sandbox): Promise<(string | undefined)[][]> {
  const list = await listCodexHooks(makeContext(sandbox).ctx);
  expect(list.kind).toBe("listed");
  return list.kind === "listed" ? list.hooks.map((x) => [x.command, x.key, x.trustStatus]) : [];
}

describe("trust recorded by install", () => {
  it("writes the reported key and hash of both hooks and keeps every other byte of config.toml", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    const h = context();
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(read(config)).toBe(CONFIG + mcpTable(gateway) + ourTrust(sandbox, hooksFile));
    expect(stateRecord(sandbox).codexTrustKey).toBe(keyOf(hooksFile, 0));
    expect(stateRecord(sandbox).codexStopTrustKey).toBe(keyOf(hooksFile, 0, "stop"));
    expect(h.out).toContain(
      `Codex: trust for the AgentDesk session-start hook recorded in ${config}`,
    );
    expect(h.out).toContain(`Codex: trust for the AgentDesk Stop hook recorded in ${config}`);
    // One exchange covers both hooks: initialize, initialized, then hooks/list for the home directory.
    expect(appServerMessages(sandbox)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agentdesk", version: "0.0.0-dev" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [sandbox.home] } },
    ]);
    // Codex now reports both hooks as trusted.
    expect(await listed(sandbox)).toEqual([
      [ourCommand(sandbox), keyOf(hooksFile, 0), "trusted"],
      [ourStop(sandbox), keyOf(hooksFile, 0, "stop"), "trusted"],
    ]);
    expect(read(config)).not.toContain("agentdesk-tmp");
    // config.toml was copied once, before the run's first edit.
    expect(read(`${config}.agentdesk-backup`)).toBe(CONFIG);
    for (const issued of gateway.issued) {
      expect(read(hooksFile)).not.toContain(issued.token);
      expect(read(`${config}.agentdesk-backup`)).not.toContain(issued.token);
      expect(h.output()).not.toContain(issued.token);
    }
  });

  it("uses CODEX_HOME for hooks.json and config.toml", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const codexHome = join(sandbox.root, "codex-home");
    const h = makeContext(sandbox, { env: { CODEX_HOME: codexHome } });
    expect(await h.run(["skill", "install"])).toBe(0);
    const hooksFile = join(codexHome, "hooks.json");
    expect(read(join(codexHome, "config.toml"))).toBe(ourTrust(sandbox, hooksFile).slice(1));
    expect(stateRecord(sandbox).codexStopTrustKey).toBe(keyOf(hooksFile, 0, "stop"));
    expect(existsSync(join(sandbox.home, ".codex"))).toBe(false);
  });

  it("replaces the recorded tables when both hooks' keys change", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    // The user puts a group before each of the installer's, which moves both keys.
    const hooks = readJson(hooksFile) as unknown as HooksJson;
    hooks.hooks.SessionStart.unshift({
      matcher: "resume",
      hooks: [{ type: "command", command: "echo first" }],
    });
    hooks.hooks.Stop.unshift({ hooks: [{ type: "command", command: "echo first-stop" }] });
    write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);

    expect(await context().run(["install", "--yes"])).toBe(0);
    expect(read(config)).toBe(
      CONFIG + mcpTable(gateway) + ourTrust(sandbox, hooksFile, { session: 1, stop: 1 }),
    );
    expect(stateRecord(sandbox).codexTrustKey).toBe(keyOf(hooksFile, 1));
    expect(stateRecord(sandbox).codexStopTrustKey).toBe(keyOf(hooksFile, 1, "stop"));
  });

  it("replaces only the Stop table when only the Stop hook's key changes", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const hooks = readJson(hooksFile) as unknown as HooksJson;
    hooks.hooks.Stop.unshift({ hooks: [{ type: "command", command: "echo first-stop" }] });
    write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    expect(await context().run(["skill", "install"])).toBe(0);
    expect(read(config)).toBe(
      CONFIG + mcpTable(gateway) + ourTrust(sandbox, hooksFile, { session: 0, stop: 1 }),
    );
    expect(stateRecord(sandbox).codexTrustKey).toBe(keyOf(hooksFile, 0));
    expect(stateRecord(sandbox).codexStopTrustKey).toBe(keyOf(hooksFile, 1, "stop"));
  });

  it("refreshes both hashes when the executable moves", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const moved = join(sandbox.root, "moved", "agentdesk");
    const h = makeContext(sandbox, { gateway, clock: new FakeClock(), executable: moved });
    expect(await h.run(["skill", "install"])).toBe(0);
    expect(read(config)).toBe(
      CONFIG + mcpTable(gateway) + ourTrust(sandbox, hooksFile, undefined, moved),
    );
    expect(await listed(sandbox)).toEqual([
      [ourCommand(sandbox, moved), keyOf(hooksFile, 0), "trusted"],
      [ourStop(sandbox, moved), keyOf(hooksFile, 0, "stop"), "trusted"],
    ]);
  });

  it("reports each hook's trustStatus in status", async () => {
    const { context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const trusted = context();
    expect(await trusted.run(["status"])).toBe(0);
    expect(trusted.out.find((l) => l.startsWith("Codex:"))).toMatch(
      new RegExp(
        `; session-start hook in ${hooksFile}, trust trusted; Stop hook in ${hooksFile}, trust trusted$`,
      ),
    );
    // Only the Stop hook's recorded hash changes, the last table in the file.
    write(
      config,
      read(config).replace(/trusted_hash = "sha256:[0-9a-f]+"\n$/, 'trusted_hash = "sha256:0"\n'),
    );
    const modified = context();
    expect(await modified.run(["status"])).toBe(0);
    expect(modified.out.find((l) => l.startsWith("Codex:"))).toMatch(
      /session-start hook in [^;]+, trust trusted; Stop hook in [^;]+, trust modified$/,
    );
    const unavailable = context({ FAKE_CODEX_APP_SERVER: "fail" });
    expect(await unavailable.run(["status"])).toBe(0);
    expect(unavailable.out.find((l) => l.startsWith("Codex:"))).toMatch(
      /session-start hook in [^;]+, trust could not be checked; confirm it in Codex's \/hooks; Stop hook in [^;]+, trust could not be checked; confirm it in Codex's \/hooks$/,
    );
    const missing = context({ FAKE_CODEX_APP_SERVER: "missing-stop" });
    expect(await missing.run(["status"])).toBe(0);
    expect(missing.out.find((l) => l.startsWith("Codex:"))).toMatch(
      /, trust trusted; Stop hook in [^;]+, trust could not be checked; confirm it in Codex's \/hooks$/,
    );
  });

  const fallbacks: [string, Record<string, string>, boolean, string][] = [
    ["codex is not on PATH", {}, false, "codex is not on PATH"],
    [
      "app-server exits nonzero",
      { FAKE_CODEX_APP_SERVER: "fail" },
      true,
      "codex app-server exited with status 2",
    ],
    [
      "app-server answers hooks/list with an error",
      { FAKE_CODEX_APP_SERVER: "error" },
      true,
      "codex app-server could not list hooks",
    ],
  ];

  it.each(fallbacks)(
    "prints the /hooks step for both hooks and exits 0 when %s",
    async (_name, env, onPath, reason) => {
      const { sandbox, gateway, context, config } = setup(env, onPath);
      const h = context();
      expect(await h.run(["install", "--yes"])).toBe(0);
      expect(h.out).toContain(
        `Codex: the AgentDesk session-start hook is not trusted yet (${reason}). ${TRUST_STEP}`,
      );
      expect(h.out).toContain(
        `Codex: the AgentDesk Stop hook is not trusted yet (${reason}). ${STOP_STEP}`,
      );
      expect(read(config)).toBe(CONFIG + mcpTable(gateway));
      expect(stateRecord(sandbox).codexTrustKey).toBeUndefined();
      expect(stateRecord(sandbox).codexStopTrustKey).toBeUndefined();
      expect(h.err).toEqual([]);
    },
  );

  const unlisted: [string, string, ("session" | "stop")[]][] = [
    ["the session-start hook is missing from the list", "missing", ["session"]],
    ["the Stop hook is missing from the list", "missing-stop", ["stop"]],
    ["both hooks are missing from the list", "missing-all", ["session", "stop"]],
    ["every hook's currentHash is malformed", "malformed", ["session", "stop"]],
    ["every hook comes from a source other than the user", "project", ["session", "stop"]],
  ];

  it.each(unlisted)(
    "writes no invented trust and prints the step for each hook it cannot use when %s",
    async (_name, mode, missing) => {
      const { sandbox, gateway, context, hooksFile, config } = setup({
        FAKE_CODEX_APP_SERVER: mode,
      });
      const h = context();
      expect(await h.run(["install", "--yes"])).toBe(0);
      const sessionLine = `Codex: the AgentDesk session-start hook is not trusted yet (codex does not list the AgentDesk session-start hook). ${TRUST_STEP}`;
      const stopLine = `Codex: the AgentDesk Stop hook is not trusted yet (codex does not list the AgentDesk Stop hook). ${STOP_STEP}`;
      let expected = CONFIG + mcpTable(gateway);
      if (missing.includes("session")) expect(h.out).toContain(sessionLine);
      else expected += trustTable(keyOf(hooksFile, 0), hashOf(ourCommand(sandbox)));
      if (missing.includes("stop")) expect(h.out).toContain(stopLine);
      else expected += trustTable(keyOf(hooksFile, 0, "stop"), stopHashOf(ourStop(sandbox)));
      if (!missing.includes("session")) expect(h.out).not.toContain(sessionLine);
      if (!missing.includes("stop")) expect(h.out).not.toContain(stopLine);
      expect(read(config)).toBe(expected);
      const record = stateRecord(sandbox);
      expect(record.codexTrustKey).toBe(
        missing.includes("session") ? undefined : keyOf(hooksFile, 0),
      );
      expect(record.codexStopTrustKey).toBe(
        missing.includes("stop") ? undefined : keyOf(hooksFile, 0, "stop"),
      );
      expect(h.err).toEqual([]);
    },
  );

  it("gives up after 10 seconds on the fake clock, stops app-server, and exits 0", async () => {
    const { sandbox, gateway, context, clock, config } = setup({ FAKE_CODEX_APP_SERVER: "hang" });
    const h = context();
    const run = h.run(["install", "--yes"]);
    // Wait until app-server has been asked for the hook list, then let 10 seconds pass.
    await vi.waitFor(
      () => {
        expect(appServerMessages(sandbox).some((m) => m.method === "hooks/list")).toBe(true);
        expect(clock.pendingTimers).toBe(1);
      },
      { timeout: 10_000 },
    );
    clock.advance(9_999);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(1);
    expect(await run).toBe(0);
    const reason = "codex app-server did not answer within 10 seconds";
    expect(h.out).toContain(
      `Codex: the AgentDesk session-start hook is not trusted yet (${reason}). ${TRUST_STEP}`,
    );
    expect(h.out).toContain(
      `Codex: the AgentDesk Stop hook is not trusted yet (${reason}). ${STOP_STEP}`,
    );
    expect(read(config)).toBe(CONFIG + mcpTable(gateway));
    const pid = Number(readFileSync(`${sandbox.log}.pids`, "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
  });

  it.each([
    ["session-start", "session_start", TRUST_STEP],
    ["Stop", "stop", STOP_STEP],
  ] as const)(
    "refuses a hooks.state definition lines cannot replace for the %s hook, keeping it, and exits 1",
    async (label, event, step) => {
      const { sandbox, gateway, context, hooksFile, config } = setup();
      // The key the hook will get, defined with a dotted key under [hooks.state].
      const key = `${realpathSync(join(sandbox.home, ".codex"))}/hooks.json:${event}:0:0`;
      const dotted = `${CONFIG}\n[hooks.state]\n${JSON.stringify(key)}.trusted_hash = "sha256:old"\n`;
      write(config, dotted);
      const h = context();
      expect(await h.run(["install", "--yes"])).toBe(1);
      expect(h.err.join("\n")).toContain(
        `Codex: the AgentDesk ${label} hook's trust was not recorded: ${config} defines hooks.state for the AgentDesk hook in a form the installer cannot replace; it was not changed. ${step}`,
      );
      expect(read(config)).toContain(`${JSON.stringify(key)}.trusted_hash = "sha256:old"\n`);
      expect(keyOf(hooksFile, 0, event)).toBe(key);
      // Both hooks' trust goes in one edit, so neither is recorded, and each
      // gets its own step.
      expect(h.err.join("\n")).toContain(
        `in a form the installer cannot replace; it was not changed. ${label === "Stop" ? TRUST_STEP : STOP_STEP}`,
      );
      expect(read(config)).toBe(dotted + mcpTable(gateway));
      const record = stateRecord(sandbox);
      expect(record.codexTrustKey).toBeUndefined();
      expect(record.codexStopTrustKey).toBeUndefined();
      expect(h.output()).not.toContain(gateway.tokenFor("codex"));
    },
  );
});

describe("editCodexTrust", () => {
  const file = "/home/me/.codex/config.toml";

  it("replaces only the target table's lines, in place, keeping comments and CRLF", () => {
    const text =
      '# top\r\n[hooks.state."k"]\r\ntrusted_hash = "sha256:old"\r\n# about next\r\n[other]\r\nx = 1\r\n';
    expect(editCodexTrust(file, text, new Map([["k", "sha256:new"]]), [])).toBe(
      '# top\r\n[hooks.state."k"]\r\ntrusted_hash = "sha256:new"\r\n# about next\r\n[other]\r\nx = 1\r\n',
    );
  });

  it("matches the header in any quoting and spacing", () => {
    const text = "[ hooks . state . 'k' ]\ntrusted_hash = \"sha256:old\"\n";
    expect(editCodexTrust(file, text, new Map([["k", "sha256:new"]]), [])).toBe(
      '[hooks.state."k"]\ntrusted_hash = "sha256:new"\n',
    );
  });

  it("removes a table with the blank line the installer added, and keeps other tables", () => {
    const text =
      'a = 1\n\n[hooks.state."keep"]\ntrusted_hash = "sha256:1"\n\n[hooks.state."drop"]\ntrusted_hash = "sha256:2"\n';
    expect(editCodexTrust(file, text, new Map(), ["drop"])).toBe(
      'a = 1\n\n[hooks.state."keep"]\ntrusted_hash = "sha256:1"\n',
    );
    expect(editCodexTrust(file, text, new Map(), ["absent"])).toBe(text);
  });

  it("removes several appended tables with their blank lines, in any order given", () => {
    const text =
      'a = 1\n\n[mcp_servers.agentdesk]\nurl = "u"\n\n[hooks.state."one"]\ntrusted_hash = "sha256:1"\n\n[hooks.state."two"]\ntrusted_hash = "sha256:2"\n';
    const expected = 'a = 1\n\n[mcp_servers.agentdesk]\nurl = "u"\n';
    expect(editCodexTrust(file, text, new Map(), ["one", "two"])).toBe(expected);
    expect(editCodexTrust(file, text, new Map(), ["two", "one"])).toBe(expected);
  });

  it("sets one key and removes another in one edit", () => {
    const text = '[hooks.state."old"]\ntrusted_hash = "sha256:1"\n';
    expect(editCodexTrust(file, text, new Map([["new", "sha256:2"]]), ["old"])).toBe(
      '[hooks.state."new"]\ntrusted_hash = "sha256:2"\n',
    );
  });

  it.each([
    ["an inline table", '[hooks]\nstate = { "k" = { trusted_hash = "sha256:1" } }\n'],
    ["a dotted key", '[hooks.state]\n"k".trusted_hash = "sha256:1"\n'],
  ])("refuses %s", (_name, text) => {
    expect(() => editCodexTrust(file, text, new Map([["k", "sha256:2"]]), [])).toThrow(
      InstallerError,
    );
    expect(() => editCodexTrust(file, text, new Map(), ["k"])).toThrow(InstallerError);
  });

  it("refuses text that is not TOML", () => {
    expect(() => editCodexTrust(file, "[broken", new Map([["k", "sha256:1"]]), [])).toThrow(
      `${file} is not valid TOML`,
    );
  });
});

describe("trust carried by uninstall", () => {
  const LATER = ["trusted", "modified", "untrusted"];

  /**
   * Installs, then appends three user groups after each of the installer's
   * SessionStart and Stop groups: trusted, modified, and untrusted. Both
   * events' later groups sit at the same positions, 1 to 3.
   */
  async function installWithLaterGroups(
    env: Record<string, string> = {},
    prepare: (fixture: ReturnType<typeof setup>) => void = () => {},
  ) {
    const fixture = setup();
    const { sandbox, context, hooksFile, config } = fixture;
    prepare(fixture);
    expect(await context().run(["install", "--yes"])).toBe(0);
    const hooks = readJson(hooksFile) as unknown as HooksJson;
    for (const name of LATER) {
      hooks.hooks.SessionStart.push({
        matcher: "resume",
        hooks: [{ type: "command", command: `echo ${name}` }],
      });
      hooks.hooks.Stop.push({ hooks: [{ type: "command", command: `echo ${name}`, timeout: 5 }] });
    }
    write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    write(
      config,
      read(config) +
        trustTable(keyOf(hooksFile, 1), hashOf("echo trusted", "resume")) +
        trustTable(keyOf(hooksFile, 2), "sha256:stale") +
        trustTable(keyOf(hooksFile, 1, "stop"), stopHashOf("echo trusted", 5)) +
        trustTable(keyOf(hooksFile, 2, "stop"), "sha256:stale-stop"),
    );
    const h = makeContext(sandbox, { gateway: fixture.gateway, clock: fixture.clock, env });
    return { ...fixture, h };
  }

  /** The listing and config.toml after uninstall carried trust in both events. */
  function expectCarried(hooksFile: string, config: string, list: (string | undefined)[][]) {
    expect(list).toEqual([
      ["echo trusted", keyOf(hooksFile, 0), "trusted"],
      ["echo modified", keyOf(hooksFile, 1), "modified"],
      ["echo untrusted", keyOf(hooksFile, 2), "modified"],
      ["echo trusted", keyOf(hooksFile, 0, "stop"), "trusted"],
      ["echo modified", keyOf(hooksFile, 1, "stop"), "modified"],
      ["echo untrusted", keyOf(hooksFile, 2, "stop"), "modified"],
    ]);
    // The installer's tables for the two 0 keys now hold the carried hashes,
    // in place; the MCP table before them is gone, and the user's tables for
    // the old keys are untouched.
    expect(read(config)).toBe(
      `${CONFIG}\n` +
        trustTable(keyOf(hooksFile, 0), hashOf("echo trusted", "resume")) +
        trustTable(keyOf(hooksFile, 0, "stop"), stopHashOf("echo trusted", 5)) +
        trustTable(keyOf(hooksFile, 1), hashOf("echo trusted", "resume")) +
        trustTable(keyOf(hooksFile, 2), "sha256:stale") +
        trustTable(keyOf(hooksFile, 1, "stop"), stopHashOf("echo trusted", 5)) +
        trustTable(keyOf(hooksFile, 2, "stop"), "sha256:stale-stop"),
    );
  }

  it("carries trust in both events to the new key of a later hook trusted with an unchanged hash only", async () => {
    const { sandbox, h, hooksFile, config } = await installWithLaterGroups();
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(`Codex: removing the session-start hook from ${hooksFile}`);
    expect(h.out).toContain(`Codex: removing the Stop hook from ${hooksFile}`);
    expectCarried(hooksFile, config, await listed(sandbox));
    expect(existsSync(statePath(h.ctx))).toBe(false);
  });

  it("never carries trust from one event to the same position in the other", async () => {
    const { sandbox, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    // One later group in each event, both moving from position 1:0 to 0:0;
    // only the Stop hook was trusted.
    const hooks = readJson(hooksFile) as unknown as HooksJson;
    hooks.hooks.SessionStart.push({ hooks: [{ type: "command", command: "echo same" }] });
    hooks.hooks.Stop.push({ hooks: [{ type: "command", command: "echo same" }] });
    write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    write(
      config,
      read(config) + trustTable(keyOf(hooksFile, 1, "stop"), stopHashOf("echo same", null)),
    );
    expect(await context().run(["uninstall"])).toBe(0);
    expect(await listed(sandbox)).toEqual([
      ["echo same", keyOf(hooksFile, 0), "untrusted"],
      ["echo same", keyOf(hooksFile, 0, "stop"), "trusted"],
    ]);
    // The session-start table, removed between others, leaves its blank line.
    expect(read(config)).toBe(
      `${CONFIG}\n\n` +
        trustTable(keyOf(hooksFile, 0, "stop"), stopHashOf("echo same", null)) +
        trustTable(keyOf(hooksFile, 1, "stop"), stopHashOf("echo same", null)),
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "restores hooks.json when the trust write fails, and a retry still carries the trust",
    async () => {
      // config.toml links into a directory the test can make read-only, so
      // its write fails after hooks.json has been rewritten.
      const readOnly = join(makeSandbox().root, "read-only");
      const { sandbox, h, hooksFile, config, gateway, clock } = await installWithLaterGroups(
        {},
        ({ config }) => {
          mkdirSync(readOnly);
          renameSync(config, join(readOnly, "config.toml"));
          symlinkSync(join(readOnly, "config.toml"), config);
        },
      );
      const hooksBefore = read(hooksFile);
      const configBefore = read(config);
      chmodSync(readOnly, 0o555);
      try {
        expect(await h.run(["uninstall"])).toBe(1);
      } finally {
        chmodSync(readOnly, 0o755);
      }
      expect(h.err.join("\n")).toContain("Codex: its hooks were not removed:");
      expect(h.out).toContain(`Codex: restored ${hooksFile}, because its trust was not updated.`);
      expect(read(hooksFile)).toBe(hooksBefore);
      expect(read(config)).toBe(configBefore);
      const record = stateRecord(sandbox);
      expect(record.hookPath).toBe(hooksFile);
      expect(record.stopHookPath).toBe(hooksFile);
      expect(record.codexTrustKey).toBe(keyOf(hooksFile, 0));
      expect(record.codexStopTrustKey).toBe(keyOf(hooksFile, 0, "stop"));

      // The retry finds the installer's hooks again and carries the trust in both events.
      const retry = makeContext(sandbox, { gateway, clock });
      expect(await retry.run(["uninstall"])).toBe(0);
      expectCarried(hooksFile, config, await listed(sandbox));
      expect(existsSync(statePath(retry.ctx))).toBe(false);
    },
  );

  it("warns that later hooks may need trusting again when app-server is unavailable", async () => {
    const { h, hooksFile, config } = await installWithLaterGroups({
      FAKE_CODEX_APP_SERVER: "fail",
    });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(
      `Codex: hooks listed after AgentDesk's in ${hooksFile} may need trusting again. In Codex, run /hooks and trust them.`,
    );
    const hooks = readJson(hooksFile) as unknown as HooksJson;
    expect(hooks.hooks.SessionStart).toHaveLength(3);
    expect(hooks.hooks.Stop).toHaveLength(3);
    // Both recorded tables are removed; no trust is invented for the moved hooks.
    expect(read(config)).not.toContain(`${JSON.stringify(keyOf(hooksFile, 0))}]`);
    expect(read(config)).not.toContain(`${JSON.stringify(keyOf(hooksFile, 0, "stop"))}]`);
  });

  it("does not start app-server when no later hook moves, and removes both recorded tables", async () => {
    const { sandbox, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const started = appServerMessages(sandbox).filter((m) => m.method === "initialize").length;
    const h = context();
    expect(await h.run(["uninstall"])).toBe(0);
    expect(appServerMessages(sandbox).filter((m) => m.method === "initialize")).toHaveLength(
      started,
    );
    expect(h.out).toContain(`Codex: removing the AgentDesk hooks' trust from ${config}`);
    expect(read(config)).toBe(CONFIG);
    expect(readJson(hooksFile)).toEqual({ hooks: { SessionStart: [], Stop: [] } });
  });
});
