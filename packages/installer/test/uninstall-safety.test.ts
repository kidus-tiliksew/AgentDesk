import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  read,
  readJson,
  type Sandbox,
  stubExecutable,
  write,
} from "./helpers.js";

// Review round 1 regressions: redirected skill-removal targets (P1) and
// unreadable configuration or a failed `claude mcp remove` (P2) must never be
// reported as a completed uninstall (AC-9.6).

afterEach(cleanupSandboxes);

interface Installed {
  sandbox: Sandbox;
  gateway: FakeGateway;
  clock: FakeClock;
}

async function installed(executables: string[]): Promise<Installed> {
  const sandbox = makeSandbox();
  for (const name of executables) stubExecutable(sandbox, name);
  // With no executables, ~/.claude.json alone detects Claude Code.
  if (executables.length === 0) write(join(sandbox.home, ".claude.json"), "{}\n");
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  const h = makeContext(sandbox, { gateway, clock });
  expect(await h.run(["install", "--yes"])).toBe(0);
  return { sandbox, gateway, clock };
}

/** The recovery records for connections whose revocation is not established. */
function unrevoked(sandbox: Sandbox): Record<string, string>[] {
  const state = readJson(join(sandbox.home, ".config", "agentdesk", "state.json"));
  return (state.unrevoked ?? []) as Record<string, string>[];
}

function recorded(sandbox: Sandbox): Record<string, Record<string, string>> {
  return readJson(join(sandbox.home, ".config", "agentdesk", "state.json")).harnesses as Record<
    string,
    Record<string, string>
  >;
}

/** A directory outside every owned location, holding an agentdesk folder with a marker. */
function external(sandbox: Sandbox): { skills: string; marker: string } {
  const skills = join(sandbox.root, "external", "skills");
  const marker = join(skills, "agentdesk", "keep.txt");
  write(marker, "external content\n");
  return { skills, marker };
}

describe("redirected skill folders (P1)", () => {
  it("refuses a skill folder that is a symbolic link and keeps the record", async () => {
    const { sandbox, gateway, clock } = await installed(["claude"]);
    const owned = join(sandbox.home, ".claude", "skills", "agentdesk");
    const { skills, marker } = external(sandbox);
    rmSync(owned, { recursive: true });
    symlinkSync(join(skills, "agentdesk"), owned);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.out).toContain(`Claude Code: removing the skill folder ${owned}`);
    expect(h.err.join("\n")).toContain(`${owned} is a symbolic link`);
    expect(read(marker)).toBe("external content\n");
    expect(recorded(sandbox)["claude-code"]?.skillPath).toBe(owned);
  });

  it("refuses a skill folder whose parent was redirected to another directory", async () => {
    const { sandbox, gateway, clock } = await installed(["claude"]);
    const parent = join(sandbox.home, ".claude", "skills");
    const { skills, marker } = external(sandbox);
    rmSync(parent, { recursive: true });
    symlinkSync(skills, parent);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${parent} is a symbolic link`);
    expect(read(marker)).toBe("external content\n");
    expect(recorded(sandbox)["claude-code"]?.skillPath).toBe(join(parent, "agentdesk"));
    expect(existsSync(statePath(h.ctx))).toBe(true);

    // Once the redirect is gone, a later uninstall finishes.
    rmSync(parent);
    const retry = makeContext(sandbox, { gateway, clock });
    expect(await retry.run(["uninstall"])).toBe(0);
    expect(read(marker)).toBe("external content\n");
    expect(existsSync(statePath(retry.ctx))).toBe(false);
  });

  it("refuses a Codex skill folder under a redirected parent", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    const parent = join(sandbox.home, ".codex", "skills");
    const { skills, marker } = external(sandbox);
    rmSync(parent, { recursive: true });
    symlinkSync(skills, parent);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(read(marker)).toBe("external content\n");
    expect(Object.keys(recorded(sandbox))).toEqual(["codex"]);
  });

  it("refuses a Cursor skill folder whose ~/.cursor was redirected", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const cursor = join(sandbox.home, ".cursor");
    const moved = join(sandbox.root, "moved-cursor");
    renameSync(cursor, moved);
    symlinkSync(moved, cursor);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${cursor} is a symbolic link`);
    expect(existsSync(join(moved, "skills", "agentdesk", "SKILL.md"))).toBe(true);
    expect(recorded(sandbox).cursor?.skillPath).toBe(join(cursor, "skills", "agentdesk"));
  });

  it("refuses to remove an owned Cursor folder through a redirected parent during install", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    stubExecutable(sandbox, "cursor-agent");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    expect(
      await makeContext(sandbox, { gateway, clock }).run(["install", "--yes", "--only", "cursor"]),
    ).toBe(0);
    const parent = join(sandbox.home, ".cursor", "skills");
    const { skills, marker } = external(sandbox);
    rmSync(parent, { recursive: true });
    symlinkSync(skills, parent);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(read(marker)).toBe("external content\n");
    expect(recorded(sandbox).cursor?.skillPath).toBe(join(parent, "agentdesk"));
  });
});

describe("unreadable configuration and failed removal (P2)", () => {
  it("keeps the record and revokes nothing when ~/.claude.json is malformed and the CLI is absent", async () => {
    const { sandbox, gateway, clock } = await installed([]);
    const file = join(sandbox.home, ".claude.json");
    writeFileSync(file, "{ broken");
    const before = recorded(sandbox)["claude-code"];

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${file} is not valid JSON`);
    expect(h.err.join("\n")).toContain("Its connection was not revoked and its record was kept");
    expect(gateway.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(read(file)).toBe("{ broken");
    expect(recorded(sandbox)["claude-code"]).toEqual(before);
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk", "SKILL.md"))).toBe(true);
  });

  it("keeps the record when ~/.claude.json is malformed and the CLI is present", async () => {
    const { sandbox, gateway, clock } = await installed(["claude"]);
    const file = join(sandbox.home, ".claude.json");
    writeFileSync(file, "{ broken");
    const commands = invocations(sandbox).length;
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(invocations(sandbox)).toHaveLength(commands);
    expect(gateway.revoked).toEqual([]);
    expect(recorded(sandbox)["claude-code"]?.connectionId).toBe(gateway.issued[0]?.connectionId);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the record when ~/.claude.json cannot be read",
    async () => {
      const { sandbox, gateway, clock } = await installed([]);
      const file = join(sandbox.home, ".claude.json");
      chmodSync(file, 0o000);
      try {
        const h = makeContext(sandbox, { gateway, clock });
        expect(await h.run(["uninstall"])).toBe(1);
        expect(h.err.join("\n")).toContain(`${file} could not be read`);
        expect(gateway.revoked).toEqual([]);
        expect(recorded(sandbox)["claude-code"]?.connectionId).toBe(
          gateway.issued[0]?.connectionId,
        );
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );

  it("removes the entry from the file when claude mcp remove exits nonzero and leaves it", async () => {
    const { sandbox, gateway, clock } = await installed(["claude"]);
    const token = gateway.tokenFor("claude-code");
    const h = makeContext(sandbox, { gateway, clock, env: { FAKE_CLAUDE_REMOVE_FAIL: "1" } });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(gateway.revoked).toEqual([token]);
    expect(readJson(join(sandbox.home, ".claude.json")).mcpServers).toEqual({});
    expect(existsSync(statePath(h.ctx))).toBe(false);
  });

  it("fails and keeps the record when claude mcp remove exits nonzero and leaves the file unreadable", async () => {
    const { sandbox, gateway, clock } = await installed(["claude"]);
    const file = join(sandbox.home, ".claude.json");
    const h = makeContext(sandbox, { gateway, clock, env: { FAKE_CLAUDE_REMOVE_CORRUPT: "1" } });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain("claude mcp remove exited with status 1");
    expect(recorded(sandbox)["claude-code"]?.connectionId).toBe(gateway.issued[0]?.connectionId);
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk", "SKILL.md"))).toBe(true);

    // Restoring the backup lets a later uninstall finish; the revoked token answers 401.
    writeFileSync(file, read(`${file}.agentdesk-backup`));
    const retry = makeContext(sandbox, { gateway, clock });
    expect(await retry.run(["uninstall"])).toBe(0);
    expect(readJson(file).mcpServers).toEqual({});
    expect(existsSync(statePath(retry.ctx))).toBe(false);
  });

  it("keeps the record when Codex config.toml is malformed", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    const file = join(sandbox.home, ".codex", "config.toml");
    writeFileSync(file, `${read(file)}\nbroken = = 1\n`);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${file} is not valid TOML`);
    expect(gateway.revoked).toEqual([]);
    expect(Object.keys(recorded(sandbox))).toEqual(["codex"]);
  });

  it("status reports an unreadable configuration instead of a missing entry", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    const file = join(sandbox.home, ".cursor", "mcp.json");
    writeFileSync(file, "[]");
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["status"])).toBe(0);
    expect(h.out[1]).toContain("Cursor: configuration unreadable");
  });

  it("refuses install before sign-in when a recorded configuration is malformed", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    const file = join(sandbox.home, ".codex", "config.toml");
    writeFileSync(file, "broken = = 1\n");
    const starts = gateway.startRequests().length;
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(gateway.startRequests()).toHaveLength(starts);
    expect(read(file)).toBe("broken = = 1\n");
  });
});

// Review round 2 regressions: a redirected harness base (P1) and a recorded
// connection whose local token is missing (P2).

describe("redirected harness bases (round 2 P1)", () => {
  it("refuses removal when ~/.codex itself was redirected after install", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    const base = join(sandbox.home, ".codex");
    const elsewhere = join(sandbox.root, "external-codex");
    write(join(elsewhere, "skills", "agentdesk", "keep.txt"), "external content\n");
    write(join(elsewhere, "config.toml"), read(join(base, "config.toml")));
    rmSync(base, { recursive: true });
    symlinkSync(elsewhere, base);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(read(join(elsewhere, "skills", "agentdesk", "keep.txt"))).toBe("external content\n");
    expect(recorded(sandbox).codex?.skillPath).toBe(join(base, "skills", "agentdesk"));
    expect(h.err.join("\n")).toContain("resolves to");
  });

  it("refuses removal when a custom CODEX_HOME base was redirected after install", async () => {
    const sandbox = makeSandbox();
    const codexHome = join(sandbox.root, "codex-home");
    write(join(codexHome, "config.toml"), "");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    const env = { CODEX_HOME: codexHome };
    expect(await makeContext(sandbox, { gateway, clock, env }).run(["install", "--yes"])).toBe(0);

    const elsewhere = join(sandbox.root, "external-codex-home");
    write(join(elsewhere, "skills", "agentdesk", "keep.txt"), "external content\n");
    write(join(elsewhere, "config.toml"), read(join(codexHome, "config.toml")));
    rmSync(codexHome, { recursive: true });
    symlinkSync(elsewhere, codexHome);

    const h = makeContext(sandbox, { gateway, clock, env });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(read(join(elsewhere, "skills", "agentdesk", "keep.txt"))).toBe("external content\n");
    expect(recorded(sandbox).codex?.skillPath).toBe(join(codexHome, "skills", "agentdesk"));
  });

  it("refuses removal when a directory above the Codex base was redirected after install", async () => {
    const sandbox = makeSandbox();
    const parent = join(sandbox.root, "tools");
    const codexHome = join(parent, "codex");
    write(join(codexHome, "config.toml"), "");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    const env = { CODEX_HOME: codexHome };
    expect(await makeContext(sandbox, { gateway, clock, env }).run(["install", "--yes"])).toBe(0);

    const elsewhere = join(sandbox.root, "external-tools");
    write(join(elsewhere, "codex", "skills", "agentdesk", "keep.txt"), "external content\n");
    write(join(elsewhere, "codex", "config.toml"), read(join(codexHome, "config.toml")));
    rmSync(parent, { recursive: true });
    symlinkSync(elsewhere, parent);

    const h = makeContext(sandbox, { gateway, clock, env });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(read(join(elsewhere, "codex", "skills", "agentdesk", "keep.txt"))).toBe(
      "external content\n",
    );
  });

  it("refuses Claude Code skill removal when the home directory was redirected after install", async () => {
    const { sandbox, gateway, clock } = await installed(["claude"]);
    // Move the whole home elsewhere and leave a symlink at the old path.
    const moved = join(sandbox.root, "moved-home");
    renameSync(sandbox.home, moved);
    symlinkSync(moved, sandbox.home);
    const marker = join(moved, ".claude", "skills", "agentdesk", "keep.txt");
    write(marker, "external content\n");

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(read(marker)).toBe("external content\n");
    expect(recorded(sandbox)["claude-code"]?.skillPath).toBe(
      join(sandbox.home, ".claude", "skills", "agentdesk"),
    );
  });
});

describe("missing local token (round 2 P2)", () => {
  function unresolvedAssertions(
    h: ReturnType<typeof makeContext>,
    sandbox: Sandbox,
    gateway: FakeGateway,
    id: string,
  ) {
    const issued = gateway.issued.find((i) => i.harness === id);
    // The connection id and server move to a recovery record; no token is stored.
    expect(unrevoked(sandbox)).toEqual([
      expect.objectContaining({
        harness: id,
        connectionId: issued?.connectionId,
        server: "https://agentdesk.test",
      }),
    ]);
    expect(read(join(sandbox.home, ".config", "agentdesk", "state.json"))).not.toContain(
      issued?.token ?? "",
    );
    expect(gateway.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    const err = h.err.join("\n");
    expect(err).toContain(`${issued?.connectionId}`);
    expect(err).toContain("Settings → Connections");
    expect(err).toContain("agentdesk uninstall --forget-unrevoked");
  }

  it("keeps the connection record and exits 1 when the MCP entry is gone", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    write(join(sandbox.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    unresolvedAssertions(h, sandbox, gateway, "cursor");
    expect(existsSync(statePath(h.ctx))).toBe(true);
  });

  it("keeps the connection record and exits 1 when the Authorization header is missing", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    write(
      join(sandbox.home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { agentdesk: { url: "https://agentdesk.test/mcp", headers: {} } },
      }),
    );
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    unresolvedAssertions(h, sandbox, gateway, "cursor");
  });

  it("keeps the connection record and exits 1 when the Authorization header cannot be parsed", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    const file = join(sandbox.home, ".codex", "config.toml");
    write(file, read(file).replace(/"Bearer [^"]+"/, '"Token not-a-bearer value"'));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    unresolvedAssertions(h, sandbox, gateway, "codex");
  });

  it("forgets an unresolved record only with --forget-unrevoked, and says so", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    write(join(sandbox.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const connectionId = gateway.issued[0]?.connectionId;
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(1);
    // A second plain uninstall still refuses to forget it.
    const again = makeContext(sandbox, { gateway, clock });
    expect(await again.run(["uninstall"])).toBe(1);
    expect(unrevoked(sandbox).map((u) => u.connectionId)).toEqual([connectionId]);

    const forget = makeContext(sandbox, { gateway, clock });
    expect(await forget.run(["uninstall", "--forget-unrevoked"])).toBe(0);
    expect(forget.out.join("\n")).toContain(`Forgot connection ${connectionId}`);
    expect(existsSync(statePath(forget.ctx))).toBe(false);
  });

  it("keeps a recovery record on install for a recorded connection without a local token", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    const oldConnection = gateway.issued[0]?.connectionId;
    write(join(sandbox.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const h = makeContext(sandbox, { gateway, clock });
    // The run is not fully complete while the old connection is unresolved.
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `connection ${oldConnection} at https://agentdesk.test is not revoked`,
    );
    expect(h.err.join("\n")).toContain("Settings → Connections");
    expect(h.err.join("\n")).toContain(`agentdesk forget ${oldConnection}`);
    expect(unrevoked(sandbox).map((u) => u.connectionId)).toEqual([oldConnection]);
    expect(gateway.startRequests()).toHaveLength(2);
  });

  it("does not forget a connection whose revocation failed at the server, even with --forget-unrevoked", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    gateway.deleteStatus.set(gateway.tokenFor("codex"), 503);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall", "--forget-unrevoked"])).toBe(1);
    expect(recorded(sandbox).codex?.connectionId).toBe(gateway.issued[0]?.connectionId);
  });
});

// component-installer §State, re-run, and uninstall: uninstall removes
// component-resume's `resume` directory beside the state file, under the same
// refusal rules as a skill folder.

describe("the resume directory", () => {
  /** Fills `resume/` the way the waiter and the Cursor hooks leave it. */
  function fillResume(dir: string): void {
    write(join(dir, "claims", "dec_1"), "");
    write(join(dir, "waiters", "dec_2"), "123\n");
    write(join(dir, "cursor", "conv_1", "dec_3"), "");
  }

  // The sandbox home sits under the system's temporary directory, which on
  // macOS is reached through the /var symbolic link: directories above the
  // home directory are not checked, so an ordinary home is accepted.
  it("is removed with its contents, printed first, keeping its siblings", async () => {
    const { sandbox, gateway, clock } = await installed(["codex", "cursor-agent"]);
    const base = join(sandbox.home, ".config", "agentdesk");
    const dir = join(base, "resume");
    fillResume(dir);
    write(join(base, "notes.txt"), "mine\n");
    write(join(sandbox.home, ".config", "other", "keep.txt"), "keep\n");

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(`Removing the resume directory ${dir}`);
    const removing = h.out.indexOf(`Removing the resume directory ${dir}`);
    expect(removing).toBeLessThan(h.out.indexOf(`Removed ${statePath(h.ctx)}`));
    expect(existsSync(dir)).toBe(false);
    expect(read(join(base, "notes.txt"))).toBe("mine\n");
    expect(read(join(sandbox.home, ".config", "other", "keep.txt"))).toBe("keep\n");
    expect(existsSync(statePath(h.ctx))).toBe(false);
  });

  it("is found under XDG_CONFIG_HOME", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    // A base outside the home directory is checked from the filesystem root,
    // so the test uses the resolved temporary directory.
    const root = realpathSync(sandbox.root);
    const env = { XDG_CONFIG_HOME: join(root, "xdg") };
    expect(await makeContext(sandbox, { gateway, clock, env }).run(["install", "--yes"])).toBe(0);
    const dir = join(root, "xdg", "agentdesk", "resume");
    fillResume(dir);
    // A resume directory under ~/.config is not this installation's.
    const other = join(sandbox.home, ".config", "agentdesk", "resume", "claims", "dec_9");
    write(other, "");
    const h = makeContext(sandbox, { gateway, clock, env });
    expect(await h.run(["uninstall"])).toBe(0);
    expect(h.out).toContain(`Removing the resume directory ${dir}`);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("is not followed through a symbolic link inside it", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    const dir = join(sandbox.home, ".config", "agentdesk", "resume");
    fillResume(dir);
    const { skills, marker } = external(sandbox);
    symlinkSync(skills, join(dir, "cursor", "linked"));
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(read(marker)).toBe("external content\n");
  });

  it("refuses a resume directory that is a symbolic link, keeping the state for a retry", async () => {
    const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
    const dir = join(sandbox.home, ".config", "agentdesk", "resume");
    const { skills, marker } = external(sandbox);
    symlinkSync(skills, dir);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.out).toContain(`Removing the resume directory ${dir}`);
    expect(h.err.join("\n")).toContain(
      `The resume directory was not removed: ${dir} is not a resume directory the installer owns (${dir} is a symbolic link); it was not removed.`,
    );
    expect(read(marker)).toBe("external content\n");
    // Everything else is gone; the state stays so a later uninstall retries.
    expect(readJson(statePath(h.ctx))).toEqual({
      version: 1,
      server: "https://agentdesk.test",
      harnesses: {},
    });
    expect(gateway.revoked).toHaveLength(1);
    const status = makeContext(sandbox, { gateway, clock });
    expect(await status.run(["status"])).toBe(0);
    expect(status.out).toEqual([
      "AgentDesk is not installed on this machine. Run: agentdesk install",
    ]);

    rmSync(dir);
    fillResume(dir);
    const retry = makeContext(sandbox, { gateway, clock });
    expect(await retry.run(["uninstall"])).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(statePath(retry.ctx))).toBe(false);
    expect(read(marker)).toBe("external content\n");
  });

  it("refuses a resume directory under a redirected agentdesk directory", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    // ~/.config/agentdesk is a link to a directory elsewhere, which holds the state too.
    const elsewhere = join(sandbox.root, "elsewhere-agentdesk");
    write(join(elsewhere, "resume", "claims", "dec_1"), "");
    write(join(sandbox.home, ".config", ".keep"), "");
    symlinkSync(elsewhere, join(sandbox.home, ".config", "agentdesk"));
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain(
      `${join(sandbox.home, ".config", "agentdesk")} is a symbolic link`,
    );
    expect(existsSync(join(elsewhere, "resume", "claims", "dec_1"))).toBe(true);
    expect(existsSync(join(elsewhere, "state.json"))).toBe(true);
  });

  it("is left in place, with the state, while a harness is kept for a retry", async () => {
    const { sandbox, gateway, clock } = await installed(["codex"]);
    const dir = join(sandbox.home, ".config", "agentdesk", "resume");
    fillResume(dir);
    gateway.deleteStatus.set(gateway.tokenFor("codex"), 503);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall"])).toBe(1);
    expect(existsSync(join(dir, "claims", "dec_1"))).toBe(true);
    expect(h.out.join("\n")).not.toContain("Removing the resume directory");

    gateway.deleteStatus.clear();
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the state and exits 1 when the resume directory cannot be removed",
    async () => {
      const { sandbox, gateway, clock } = await installed(["cursor-agent"]);
      const dir = join(sandbox.home, ".config", "agentdesk", "resume");
      fillResume(dir);
      const claims = join(dir, "claims");
      chmodSync(claims, 0o555);
      let code: number;
      const h = makeContext(sandbox, { gateway, clock });
      try {
        code = await h.run(["uninstall"]);
      } finally {
        chmodSync(claims, 0o755);
      }
      expect(code).toBe(1);
      expect(h.err.join("\n")).toContain(
        `The resume directory was not removed: ${dir} could not be removed`,
      );
      expect(existsSync(statePath(h.ctx))).toBe(true);

      const retry = makeContext(sandbox, { gateway, clock });
      expect(await retry.run(["uninstall"])).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(statePath(retry.ctx))).toBe(false);
    },
  );

  /**
   * Installs Cursor with the state under `base`, fills the resume directory,
   * then moves `redirected` (base itself or a directory above it) elsewhere
   * and leaves a symbolic link at its path. Uninstall reads the state through
   * the link, so only the ownership walk can refuse the destination.
   */
  async function redirectedBase(
    sandbox: Sandbox,
    env: Record<string, string>,
    base: string,
    redirected: string,
  ) {
    stubExecutable(sandbox, "cursor-agent");
    const clock = new FakeClock();
    const gateway = new FakeGateway(clock);
    expect(await makeContext(sandbox, { gateway, clock, env }).run(["install", "--yes"])).toBe(0);
    fillResume(join(base, "agentdesk", "resume"));
    const moved = `${redirected}-moved`;
    renameSync(redirected, moved);
    symlinkSync(moved, redirected);
    // The same files, seen at the link's destination.
    const external = join(moved, base.slice(redirected.length));
    const marker = join(external, "agentdesk", "resume", "claims", "dec_1");
    const state = join(external, "agentdesk", "state.json");
    expect(existsSync(marker)).toBe(true);

    const h = makeContext(sandbox, { gateway, clock, env });
    expect(await h.run(["uninstall"])).toBe(1);
    const dir = join(base, "agentdesk", "resume");
    expect(h.out).toContain(`Removing the resume directory ${dir}`);
    expect(h.err.join("\n")).toContain(
      `The resume directory was not removed: ${dir} is not a resume directory the installer owns (${redirected} is a symbolic link`,
    );
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(join(external, "agentdesk", "resume", "waiters", "dec_2"))).toBe(true);
    // The state stays for a retry, with nothing left to revoke.
    expect(readJson(state)).toEqual({
      version: 1,
      server: "https://agentdesk.test",
      harnesses: {},
    });

    // Once the redirect is corrected, a later uninstall finishes.
    rmSync(redirected);
    renameSync(moved, redirected);
    const retry = makeContext(sandbox, { gateway, clock, env });
    expect(await retry.run(["uninstall"])).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(base, "agentdesk", "state.json"))).toBe(false);
  }

  it("refuses a resume directory under a redirected ~/.config, keeping the state for a retry", async () => {
    const sandbox = makeSandbox();
    const base = join(sandbox.home, ".config");
    await redirectedBase(sandbox, {}, base, base);
  });

  it("refuses a resume directory under a redirected XDG_CONFIG_HOME, keeping the state for a retry", async () => {
    const sandbox = makeSandbox();
    const base = join(realpathSync(sandbox.root), "xdg");
    await redirectedBase(sandbox, { XDG_CONFIG_HOME: base }, base, base);
  });

  it("refuses a resume directory when a directory above a custom base was redirected, keeping the state for a retry", async () => {
    const sandbox = makeSandbox();
    const tools = join(realpathSync(sandbox.root), "tools");
    const base = join(tools, "config");
    await redirectedBase(sandbox, { XDG_CONFIG_HOME: base }, base, tools);
  });
});
