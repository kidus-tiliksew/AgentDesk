import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath } from "../src/state.js";
import {
  cleanupSandboxes,
  FakeClock,
  FakeGateway,
  invocations,
  makeContext,
  makeSandbox,
  mode,
  read,
  readJson,
  type Sandbox,
  SERVER,
  skillContent,
  stubExecutable,
  write,
  writingInvocations,
} from "./helpers.js";

afterEach(cleanupSandboxes);

const CODEX_OTHER = '# mine\nmodel = "x"\n\n[mcp_servers.github]\ncommand = "gh"\n';

function setup(): { sandbox: Sandbox; gateway: FakeGateway; clock: FakeClock } {
  const sandbox = makeSandbox();
  stubExecutable(sandbox, "claude");
  stubExecutable(sandbox, "codex");
  stubExecutable(sandbox, "cursor-agent");
  write(join(sandbox.home, ".codex", "config.toml"), CODEX_OTHER);
  write(
    join(sandbox.home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { linear: { url: "l" } } }),
  );
  write(join(sandbox.home, ".claude", "skills", "other", "SKILL.md"), "other skill\n");
  const clock = new FakeClock();
  return { sandbox, clock, gateway: new FakeGateway(clock) };
}

describe("state file (component-installer §State, re-run, and uninstall)", () => {
  it("records server, connection ids, configuration, skill, and hook paths, and the Codex trust key with mode 0600 and no secret", async () => {
    const { sandbox, gateway, clock } = setup();
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    const file = statePath(h.ctx);
    expect(file).toBe(join(sandbox.home, ".config", "agentdesk", "state.json"));
    expect(mode(file)).toBe(0o600);
    expect(readJson(file)).toEqual({
      version: 1,
      server: SERVER,
      harnesses: {
        "claude-code": {
          server: SERVER,
          connectionId: gateway.issued[0]?.connectionId,
          configPath: join(sandbox.home, ".claude.json"),
          skillPath: join(sandbox.home, ".claude", "skills", "agentdesk"),
          skillRealPath: realpathSync(join(sandbox.home, ".claude", "skills", "agentdesk")),
          skillVersion: "1.0.0",
          hookPath: join(sandbox.home, ".claude", "settings.json"),
        },
        codex: {
          server: SERVER,
          connectionId: gateway.issued[1]?.connectionId,
          configPath: join(sandbox.home, ".codex", "config.toml"),
          skillPath: join(sandbox.home, ".codex", "skills", "agentdesk"),
          skillRealPath: realpathSync(join(sandbox.home, ".codex", "skills", "agentdesk")),
          skillVersion: "1.0.0",
          hookPath: join(sandbox.home, ".codex", "hooks.json"),
          codexTrustKey: `${realpathSync(join(sandbox.home, ".codex", "hooks.json"))}:session_start:0:0`,
        },
        cursor: {
          server: SERVER,
          connectionId: gateway.issued[2]?.connectionId,
          configPath: join(sandbox.home, ".cursor", "mcp.json"),
          hookPath: join(sandbox.home, ".cursor", "hooks.json"),
        },
      },
    });
    const text = read(file);
    for (const secret of [...gateway.deviceSecrets, ...gateway.issued.map((i) => i.token)]) {
      expect(text).not.toContain(secret);
    }
  });

  it("writes state under XDG_CONFIG_HOME when it is set", async () => {
    const { sandbox, gateway, clock } = setup();
    const xdg = join(sandbox.root, "xdg");
    const h = makeContext(sandbox, { gateway, clock, env: { XDG_CONFIG_HOME: xdg } });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(mode(join(xdg, "agentdesk", "state.json"))).toBe(0o600);
  });
});

describe("re-run (AC-9.4)", () => {
  it("keeps every working connection, shows no code, and rewrites the skill at the current version", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(
      await makeContext(sandbox, {
        gateway,
        clock,
        skill: { content: skillContent("1.0.0"), version: "1.0.0" },
      }).run(["install", "--yes"]),
    ).toBe(0);
    const before = {
      claude: read(join(sandbox.home, ".claude.json")),
      codex: read(join(sandbox.home, ".codex", "config.toml")),
      cursor: read(join(sandbox.home, ".cursor", "mcp.json")),
    };
    const startsBefore = gateway.startRequests().length;
    const commandsBefore = writingInvocations(sandbox).length;

    const again = makeContext(sandbox, {
      gateway,
      clock,
      skill: { content: skillContent("1.1.0"), version: "1.1.0" },
    });
    expect(await again.run(["install", "--yes"])).toBe(0);
    expect(gateway.startRequests()).toHaveLength(startsBefore);
    expect(again.out.join("\n")).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect(again.out).toContain(
      "Every selected harness is already connected. No sign-in is needed.",
    );
    expect(read(join(sandbox.home, ".claude.json"))).toBe(before.claude);
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toBe(before.codex);
    expect(read(join(sandbox.home, ".cursor", "mcp.json"))).toBe(before.cursor);
    expect(writingInvocations(sandbox)).toHaveLength(commandsBefore);
    expect(read(join(sandbox.home, ".claude", "skills", "agentdesk", "SKILL.md"))).toBe(
      skillContent("1.1.0"),
    );
    expect(read(join(sandbox.home, ".codex", "skills", "agentdesk", "SKILL.md"))).toBe(
      skillContent("1.1.0"),
    );
    const state = readJson(statePath(again.ctx)).harnesses as Record<
      string,
      { skillVersion?: string }
    >;
    expect(state["claude-code"]?.skillVersion).toBe("1.1.0");
    // The connection checks presented each harness's own token.
    const checks = gateway.requests.filter(
      (r) => r.path === "/device/connection" && r.method === "GET",
    );
    expect(checks.map((r) => r.authorization)).toEqual(
      gateway.issued.map((i) => `Bearer ${i.token}`),
    );
  });

  it("restores a skill file that was edited by hand", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const skill = join(sandbox.home, ".claude", "skills", "agentdesk", "SKILL.md");
    writeFileSync(skill, "edited\n");
    const again = makeContext(sandbox, { gateway, clock });
    expect(await again.run(["install", "--yes"])).toBe(0);
    expect(read(skill)).toBe(again.ctx.skill.content);
  });

  it("signs in only the harness whose connection check fails", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const codexOld = gateway.tokenFor("codex");
    const claudeBefore = read(join(sandbox.home, ".claude.json"));
    const cursorBefore = read(join(sandbox.home, ".cursor", "mcp.json"));
    gateway.refused.add(codexOld);

    const again = makeContext(sandbox, { gateway, clock });
    expect(await again.run(["install", "--yes"])).toBe(0);
    const starts = gateway.startRequests();
    expect(starts).toHaveLength(2);
    expect(starts[1]?.body).toEqual({ machine_name: "devbox-1", harnesses: ["codex"] });
    const codexNew = gateway.tokenFor("codex");
    expect(codexNew).not.toBe(codexOld);
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toContain(codexNew);
    expect(read(join(sandbox.home, ".claude.json"))).toBe(claudeBefore);
    expect(read(join(sandbox.home, ".cursor", "mcp.json"))).toBe(cursorBefore);
    expect(again.out).toContain("Codex: connection check was refused; signing in again.");
    // The new backup holds the old token, never the new one.
    expect(read(join(sandbox.home, ".codex", "config.toml.agentdesk-backup"))).not.toContain(
      codexNew,
    );
  });

  it("signs every harness in again at a new --server and revokes the old connections", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const oldTokens = gateway.issued.map((i) => i.token);
    const again = makeContext(sandbox, { gateway, clock });
    expect(await again.run(["install", "--yes", "--server", "https://other.example"])).toBe(0);
    const starts = gateway.startRequests();
    expect(starts[1]?.url).toBe("https://other.example/device/start");
    expect(starts[1]?.body).toMatchObject({ harnesses: ["claude-code", "codex", "cursor"] });
    expect(readJson(statePath(again.ctx)).server).toBe("https://other.example");
    const deletes = gateway.requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.url)).toEqual(oldTokens.map(() => `${SERVER}/device/connection`));
    expect(gateway.revoked).toEqual(oldTokens);
  });

  it("keeps the recorded server on a re-run without --server", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(
      await makeContext(sandbox, { gateway, clock }).run([
        "install",
        "--yes",
        "--server",
        "https://self.example",
      ]),
    ).toBe(0);
    const again = makeContext(sandbox, { gateway, clock });
    expect(await again.run(["install", "--yes"])).toBe(0);
    expect(gateway.startRequests()).toHaveLength(1);
    expect(again.out).toContain("AgentDesk server: https://self.example");
  });
});

describe("state from an installer without hooks", () => {
  it("reads a record without hook fields, and a re-run adds the hook and Codex trust", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const file = statePath(makeContext(sandbox).ctx);
    const state = readJson(file) as { harnesses: Record<string, Record<string, string>> };
    for (const record of Object.values(state.harnesses)) {
      delete record.hookPath;
      delete record.codexTrustKey;
    }
    write(file, JSON.stringify(state));
    write(join(sandbox.home, ".claude", "settings.json"), "{}\n");

    const status = makeContext(sandbox, { gateway, clock });
    expect(await status.run(["status"])).toBe(0);
    expect(status.out.join("\n")).not.toContain("hook");

    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const after = readJson(file) as { harnesses: Record<string, Record<string, string>> };
    expect(after.harnesses["claude-code"]?.hookPath).toBe(
      join(sandbox.home, ".claude", "settings.json"),
    );
    expect(after.harnesses.codex?.codexTrustKey).toMatch(/hooks\.json:session_start:0:0$/);
    expect(gateway.startRequests()).toHaveLength(1);
  });
});

describe("status", () => {
  it("prints each recorded harness, its connection check, its skill version, and its hook", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    gateway.refused.add(gateway.tokenFor("codex"));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["status"])).toBe(0);
    expect(h.out).toEqual([
      `AgentDesk server: ${SERVER}`,
      `Claude Code: connected; skill 2.0.0 at ${join(sandbox.home, ".claude", "skills", "agentdesk")}; hook in ${join(sandbox.home, ".claude", "settings.json")}`,
      `Codex: not connected (the server refused its token); skill 2.0.0 at ${join(sandbox.home, ".codex", "skills", "agentdesk")}; hook in ${join(sandbox.home, ".codex", "hooks.json")}, trust trusted`,
      `Cursor: connected; skill loaded from the Claude Code or Codex folder; hook in ${join(sandbox.home, ".cursor", "hooks.json")}`,
    ]);
    expect(h.output()).not.toContain("adc_");
  });

  it("says when nothing is installed", async () => {
    const h = makeContext(makeSandbox());
    expect(await h.run(["status"])).toBe(0);
    expect(h.out).toEqual(["AgentDesk is not installed on this machine. Run: agentdesk install"]);
  });
});

describe("uninstall (AC-9.6)", () => {
  it("revokes each connection, removes entries and owned skills, keeps other content, and deletes state", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const tokens = gateway.issued.map((i) => i.token);
    const commandsBefore = invocations(sandbox).length;

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(0);
    const deletes = gateway.requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.authorization)).toEqual(tokens.map((t) => `Bearer ${t}`));
    expect(gateway.revoked).toEqual(tokens);
    expect(invocations(sandbox).slice(commandsBefore)).toEqual([
      { name: "claude", args: ["mcp", "remove", "--scope", "user", "agentdesk"] },
    ]);
    expect(readJson(join(sandbox.home, ".claude.json")).mcpServers).toEqual({});
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toBe(CODEX_OTHER);
    expect(readJson(join(sandbox.home, ".cursor", "mcp.json"))).toEqual({
      mcpServers: { linear: { url: "l" } },
    });
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk"))).toBe(false);
    expect(existsSync(join(sandbox.home, ".codex", "skills", "agentdesk"))).toBe(false);
    expect(read(join(sandbox.home, ".claude", "skills", "other", "SKILL.md"))).toBe(
      "other skill\n",
    );
    expect(existsSync(statePath(h.ctx))).toBe(false);
    expect(h.output()).not.toContain("adc_");
  });

  it("removes the Claude entry from ~/.claude.json when the CLI is absent", async () => {
    const sandbox = makeSandbox();
    write(join(sandbox.home, ".claude.json"), JSON.stringify({ keep: true }));
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(
      await makeContext(sandbox, { gateway: h.gateway, clock: h.clock }).run(["uninstall"]),
    ).toBe(0);
    expect(readJson(join(sandbox.home, ".claude.json"))).toEqual({ keep: true, mcpServers: {} });
  });

  it("keeps a harness whose revocation fails and reports it", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const codexToken = gateway.tokenFor("codex");
    gateway.deleteStatus.set(codexToken, 503);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      "Codex: its connection could not be revoked (the server answered 503)",
    );
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toContain(codexToken);
    expect(existsSync(join(sandbox.home, ".codex", "skills", "agentdesk", "SKILL.md"))).toBe(true);
    const state = readJson(statePath(h.ctx));
    expect(Object.keys(state.harnesses as object)).toEqual(["codex"]);
    expect(mode(statePath(h.ctx))).toBe(0o600);
    expect(h.output()).not.toContain(codexToken);

    // A later uninstall finishes the job.
    gateway.deleteStatus.delete(codexToken);
    const retry = makeContext(sandbox, { gateway, clock });
    expect(await retry.run(["uninstall"])).toBe(0);
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toBe(CODEX_OTHER);
    expect(existsSync(statePath(retry.ctx))).toBe(false);
  });

  it("refuses to remove a recorded path that is not the installer's location", async () => {
    const { sandbox, gateway, clock } = setup();
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const file = join(sandbox.home, ".config", "agentdesk", "state.json");
    const state = readJson(file) as { harnesses: Record<string, Record<string, string>> };
    const elsewhere = join(sandbox.root, "precious");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    (state.harnesses["claude-code"] as Record<string, string>).skillPath = elsewhere;
    writeFileSync(file, JSON.stringify(state));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`the recorded skill path ${elsewhere} is not`);
    expect(read(join(elsewhere, "keep.txt"))).toBe("keep");
    expect(readJson(join(sandbox.home, ".claude.json")).mcpServers).toHaveProperty("agentdesk");
    expect(Object.keys(readJson(file).harnesses as object)).toEqual(["claude-code"]);
  });

  it("reports nothing to do without state", async () => {
    const h = makeContext(makeSandbox());
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.gateway.requests).toEqual([]);
  });

  it("leaves the state directory private", async () => {
    const { sandbox, gateway, clock } = setup();
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(statSync(join(sandbox.home, ".config", "agentdesk")).mode & 0o077).toBe(0);
  });
});
