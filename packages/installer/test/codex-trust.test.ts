import { readFileSync, realpathSync } from "node:fs";
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

function ourCommand(sandbox: Sandbox): string {
  return `${sandbox.executable} context --harness codex`;
}

function keyOf(hooksFile: string, group: number): string {
  return `${realpathSync(hooksFile)}:session_start:${group}:0`;
}

function hashOf(command: string, matcher = MATCHER): string {
  return codexHookHash(matcher, { type: "command", command });
}

function trustTable(key: string, hash: string): string {
  return `\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"\n`;
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

describe("trust recorded by install", () => {
  it("writes the reported key and hash and keeps every other byte of config.toml", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    const h = context();
    expect(await h.run(["install", "--yes"])).toBe(0);
    const key = keyOf(hooksFile, 0);
    expect(read(config)).toBe(
      CONFIG + mcpTable(gateway) + trustTable(key, hashOf(ourCommand(sandbox))),
    );
    expect(stateRecord(sandbox).codexTrustKey).toBe(key);
    expect(h.out).toContain(`Codex: trust for the AgentDesk hook recorded in ${config}`);
    // The exchange: initialize, initialized, then hooks/list for the home directory.
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
    // Codex now reports the hook as trusted.
    const listed = await listCodexHooks(h.ctx);
    expect(listed.kind === "listed" && listed.hooks.map((x) => x.trustStatus)).toEqual(["trusted"]);
    expect(read(config)).not.toContain("agentdesk-tmp");
    for (const issued of gateway.issued) expect(read(hooksFile)).not.toContain(issued.token);
  });

  it("uses CODEX_HOME for hooks.json and config.toml", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const codexHome = join(sandbox.root, "codex-home");
    const h = makeContext(sandbox, { env: { CODEX_HOME: codexHome } });
    expect(await h.run(["skill", "install"])).toBe(0);
    const hooksFile = join(codexHome, "hooks.json");
    expect(read(join(codexHome, "config.toml"))).toBe(
      trustTable(keyOf(hooksFile, 0), hashOf(ourCommand(sandbox))).slice(1),
    );
  });

  it("replaces the recorded table when the hook's key changes", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    // The user puts a group before the installer's, which moves its key.
    const hooks = readJson(hooksFile) as { hooks: { SessionStart: unknown[] } };
    hooks.hooks.SessionStart.unshift({
      matcher: "resume",
      hooks: [{ type: "command", command: "echo first" }],
    });
    write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);

    expect(await context().run(["install", "--yes"])).toBe(0);
    expect(read(config)).toBe(
      CONFIG + mcpTable(gateway) + trustTable(keyOf(hooksFile, 1), hashOf(ourCommand(sandbox))),
    );
    expect(stateRecord(sandbox).codexTrustKey).toBe(keyOf(hooksFile, 1));
  });

  it("refreshes the hash when the executable moves", async () => {
    const { sandbox, gateway, context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const moved = join(sandbox.root, "moved", "agentdesk");
    const h = makeContext(sandbox, { gateway, clock: new FakeClock(), executable: moved });
    expect(await h.run(["skill", "install"])).toBe(0);
    expect(read(config)).toBe(
      CONFIG +
        mcpTable(gateway) +
        trustTable(keyOf(hooksFile, 0), hashOf(`${moved} context --harness codex`)),
    );
  });

  it("reports trustStatus in status", async () => {
    const { context, hooksFile, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const trusted = context();
    expect(await trusted.run(["status"])).toBe(0);
    expect(trusted.out.find((l) => l.startsWith("Codex:"))).toMatch(
      new RegExp(`; hook in ${hooksFile}, trust trusted$`),
    );
    write(
      config,
      read(config).replace(/trusted_hash = "sha256:[0-9a-f]+"\n$/, 'trusted_hash = "sha256:0"\n'),
    );
    const modified = context();
    expect(await modified.run(["status"])).toBe(0);
    expect(modified.out.find((l) => l.startsWith("Codex:"))).toMatch(/, trust modified$/);
    const unavailable = context({ FAKE_CODEX_APP_SERVER: "fail" });
    expect(await unavailable.run(["status"])).toBe(0);
    expect(unavailable.out.find((l) => l.startsWith("Codex:"))).toMatch(
      /, trust could not be checked; confirm it in Codex's \/hooks$/,
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
      "the hook is missing from the list",
      { FAKE_CODEX_APP_SERVER: "missing" },
      true,
      "codex does not list the AgentDesk hook",
    ],
  ];

  it.each(fallbacks)(
    "prints the /hooks step and exits 0 when %s",
    async (_name, env, onPath, reason) => {
      const { sandbox, gateway, context, config } = setup(env, onPath);
      const h = context();
      expect(await h.run(["install", "--yes"])).toBe(0);
      expect(h.out).toContain(
        `Codex: the AgentDesk hook is not trusted yet (${reason}). ${TRUST_STEP}`,
      );
      expect(read(config)).toBe(CONFIG + mcpTable(gateway));
      expect(stateRecord(sandbox).codexTrustKey).toBeUndefined();
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
    expect(h.out).toContain(
      `Codex: the AgentDesk hook is not trusted yet (codex app-server did not answer within 10 seconds). ${TRUST_STEP}`,
    );
    expect(read(config)).toBe(CONFIG + mcpTable(gateway));
    const pid = Number(readFileSync(`${sandbox.log}.pids`, "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
  });

  it("refuses a hooks.state definition lines cannot replace, keeping it, and exits 1", async () => {
    const { sandbox, context, hooksFile, config } = setup();
    // The key the hook will get, defined with a dotted key under [hooks.state].
    const key = `${realpathSync(join(sandbox.home, ".codex"))}/hooks.json:session_start:0:0`;
    const dotted = `${CONFIG}\n[hooks.state]\n${JSON.stringify(key)}.trusted_hash = "sha256:old"\n`;
    write(config, dotted);
    const h = context();
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `Codex: the AgentDesk hook's trust was not recorded: ${config} defines hooks.state for the AgentDesk hook in a form the installer cannot replace; it was not changed. ${TRUST_STEP}`,
    );
    expect(read(config)).toContain(`${JSON.stringify(key)}.trusted_hash = "sha256:old"\n`);
    expect(keyOf(hooksFile, 0)).toBe(key);
  });
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
  /** Installs, then appends three user groups after the installer's: trusted, modified, untrusted. */
  async function installWithLaterGroups(env: Record<string, string> = {}) {
    const fixture = setup();
    const { sandbox, context, hooksFile, config } = fixture;
    expect(await context().run(["install", "--yes"])).toBe(0);
    const hooks = readJson(hooksFile) as { hooks: { SessionStart: unknown[] } };
    const later = ["echo trusted", "echo modified", "echo untrusted"];
    for (const command of later) {
      hooks.hooks.SessionStart.push({ matcher: "resume", hooks: [{ type: "command", command }] });
    }
    write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    const before = read(config);
    write(
      config,
      before +
        trustTable(keyOf(hooksFile, 1), hashOf("echo trusted", "resume")) +
        trustTable(keyOf(hooksFile, 2), "sha256:stale"),
    );
    const h = makeContext(sandbox, { gateway: fixture.gateway, clock: fixture.clock, env });
    return { ...fixture, h, later };
  }

  it("carries trust to the new key of a later hook trusted with an unchanged hash only", async () => {
    const { sandbox, h, hooksFile, config } = await installWithLaterGroups();
    expect(await h.run(["uninstall"])).toBe(0);
    const listed = await listCodexHooks(makeContext(sandbox).ctx);
    expect(listed.kind).toBe("listed");
    const status =
      listed.kind === "listed" ? listed.hooks.map((x) => [x.command, x.key, x.trustStatus]) : [];
    expect(status).toEqual([
      ["echo trusted", keyOf(hooksFile, 0), "trusted"],
      ["echo modified", keyOf(hooksFile, 1), "modified"],
      ["echo untrusted", keyOf(hooksFile, 2), "modified"],
    ]);
    // The installer's table for key 0 now holds the carried hash, in place; the
    // MCP table before it is gone, and the user's tables for the old keys are untouched.
    expect(read(config)).toBe(
      `${CONFIG}\n` +
        trustTable(keyOf(hooksFile, 0), hashOf("echo trusted", "resume")) +
        trustTable(keyOf(hooksFile, 1), hashOf("echo trusted", "resume")) +
        trustTable(keyOf(hooksFile, 2), "sha256:stale"),
    );
  });

  it("warns that later hooks may need trusting again when app-server is unavailable", async () => {
    const { h, hooksFile } = await installWithLaterGroups({ FAKE_CODEX_APP_SERVER: "fail" });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(
      `Codex: hooks listed after AgentDesk's in ${hooksFile} may need trusting again. In Codex, run /hooks and trust them.`,
    );
    expect((readJson(hooksFile).hooks as { SessionStart: unknown[] }).SessionStart).toHaveLength(3);
  });

  it("does not start app-server when no later hook moves", async () => {
    const { sandbox, context, config } = setup();
    expect(await context().run(["install", "--yes"])).toBe(0);
    const started = appServerMessages(sandbox).filter((m) => m.method === "initialize").length;
    expect(await context().run(["uninstall"])).toBe(0);
    expect(appServerMessages(sandbox).filter((m) => m.method === "initialize")).toHaveLength(
      started,
    );
    expect(read(config)).toBe(CONFIG);
  });
});
