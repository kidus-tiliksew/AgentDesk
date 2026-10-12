import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupRegistry,
  removeCodexTableText,
  replaceCodexTable,
  setJsonMcpServer,
} from "../src/config.js";
import { InstallerError } from "../src/context.js";
import {
  allFiles,
  cleanupSandboxes,
  invocations,
  makeContext,
  makeSandbox,
  read,
  readJson,
  SERVER,
  stubExecutable,
  write,
} from "./helpers.js";

afterEach(cleanupSandboxes);

const TOKEN = "adc_example0000000000000000000000000";

const CODEX_BEFORE = `# Codex configuration
model = "gpt-6.1-sol"  # keep this comment

[mcp_servers.github]
command = "gh-mcp"
args = ["--stdio"]

`;
const CODEX_AFTER = `# trailing comment for [projects]
[projects."/work/repo"]
trust_level = "trusted"
`;

describe("Codex config.toml", () => {
  it("replaces only the agentdesk table and keeps every other byte", () => {
    const oldTable = `[mcp_servers.agentdesk]\nurl = "https://old.example/mcp"\nhttp_headers = { "Authorization" = "Bearer adc_old" }\n\n`;
    const next = replaceCodexTable(
      "config.toml",
      CODEX_BEFORE + oldTable + CODEX_AFTER,
      SERVER,
      TOKEN,
    );
    expect(next).toBe(
      `${CODEX_BEFORE}[mcp_servers.agentdesk]\nurl = "${SERVER}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\n\n${CODEX_AFTER}`,
    );
  });

  it("replaces the table's subtables too", () => {
    const text = `${CODEX_BEFORE}[mcp_servers.agentdesk]\nurl = "x"\n[mcp_servers.agentdesk.env]\nA = "b"\n${CODEX_AFTER}`;
    const next = replaceCodexTable("config.toml", text, SERVER, TOKEN);
    expect(next.startsWith(CODEX_BEFORE)).toBe(true);
    expect(next.endsWith(CODEX_AFTER)).toBe(true);
    expect(next).not.toContain("[mcp_servers.agentdesk.env]");
  });

  it("appends the table after a blank line when it is absent", () => {
    const next = replaceCodexTable("config.toml", 'model = "x"\n', SERVER, TOKEN);
    expect(next).toBe(
      `model = "x"\n\n[mcp_servers.agentdesk]\nurl = "${SERVER}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\n`,
    );
    // Removing it restores the original bytes.
    expect(removeCodexTableText("config.toml", next)).toBe('model = "x"\n');
  });

  it("keeps CRLF line endings", () => {
    const text =
      'model = "x"\r\n\r\n[mcp_servers.agentdesk]\r\nurl = "old"\r\n\r\n[other]\r\na = 1\r\n';
    const next = replaceCodexTable("config.toml", text, SERVER, TOKEN);
    expect(next).toBe(
      `model = "x"\r\n\r\n[mcp_servers.agentdesk]\r\nurl = "${SERVER}/mcp"\r\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\r\n\r\n[other]\r\na = 1\r\n`,
    );
  });

  it("does not mistake a header-like line inside a multi-line string for a table", () => {
    const text = `prompt = """\n[mcp_servers.agentdesk]\n"""\n`;
    const next = replaceCodexTable("config.toml", text, SERVER, TOKEN);
    expect(next.startsWith(text)).toBe(true);
  });

  it("refuses invalid TOML", () => {
    expect(() => replaceCodexTable("config.toml", "model = = 1\n", SERVER, TOKEN)).toThrow(
      InstallerError,
    );
  });

  it("refuses an agentdesk definition it cannot replace by lines", () => {
    const text = '[mcp_servers]\nagentdesk = { url = "x" }\n';
    expect(() => replaceCodexTable("config.toml", text, SERVER, TOKEN)).toThrow(/cannot replace/);
  });
});

describe("JSON configuration", () => {
  it("merges mcpServers.agentdesk and keeps unrelated entries", () => {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, "mcp.json");
    write(
      file,
      JSON.stringify({ theme: "dark", mcpServers: { other: { url: "https://other" } } }, null, 4),
    );
    setJsonMcpServer(file, { url: "u" }, new BackupRegistry());
    expect(readJson(file)).toEqual({
      theme: "dark",
      mcpServers: { other: { url: "https://other" }, agentdesk: { url: "u" } },
    });
    expect(read(file)).toContain('\n    "theme"');
  });

  it("refuses malformed JSON and leaves the file unchanged", () => {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, "mcp.json");
    write(file, "{ not json");
    expect(() => setJsonMcpServer(file, { url: "u" }, new BackupRegistry())).toThrow(
      /not valid JSON/,
    );
    expect(read(file)).toBe("{ not json");
    expect(existsSync(`${file}.agentdesk-backup`)).toBe(false);
  });
});

describe("backups", () => {
  it("copies a file once per run, before its first edit", () => {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, "mcp.json");
    write(file, '{"a":1}\n');
    const backups = new BackupRegistry();
    setJsonMcpServer(file, { url: "first" }, backups);
    setJsonMcpServer(file, { url: "second" }, backups);
    expect(read(`${file}.agentdesk-backup`)).toBe('{"a":1}\n');
    // A new run backs up again.
    setJsonMcpServer(file, { url: "third" }, new BackupRegistry());
    expect(readJson(`${file}.agentdesk-backup`).mcpServers).toEqual({
      agentdesk: { url: "second" },
    });
  });

  it("makes no backup of a file that did not exist", () => {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, "new.json");
    setJsonMcpServer(file, { url: "u" }, new BackupRegistry());
    expect(existsSync(`${file}.agentdesk-backup`)).toBe(false);
  });
});

describe("MCP entries written by install", () => {
  it("calls claude mcp remove, then claude mcp add with the header, at user scope", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    write(join(sandbox.home, ".claude.json"), '{"numStartups":3}\n');
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    const token = h.gateway.tokenFor("claude-code");
    expect(invocations(sandbox)).toEqual([
      { name: "claude", args: ["mcp", "remove", "--scope", "user", "agentdesk"] },
      {
        name: "claude",
        args: [
          "mcp",
          "add",
          "--scope",
          "user",
          "--transport",
          "http",
          "agentdesk",
          `${SERVER}/mcp`,
          "--header",
          `Authorization: Bearer ${token}`,
        ],
      },
    ]);
    // The stub echoed the header; none of its output reached the user.
    expect(h.output()).not.toContain(token);
    expect(h.output()).not.toContain("Added HTTP MCP server");
    // The backup holds the file as it was before the run.
    expect(read(join(sandbox.home, ".claude.json.agentdesk-backup"))).toBe('{"numStartups":3}\n');
  });

  it("reports a failed claude mcp add without its output or arguments", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "claude");
    const h = makeContext(sandbox, { env: { FAKE_CLAUDE_FAIL: "1" } });
    expect(await h.run(["install", "--yes"])).toBe(1);
    const token = h.gateway.tokenFor("claude-code");
    expect(h.err.join("\n")).toContain("claude mcp add exited with status 3");
    expect(h.output()).not.toContain(token);
    expect(h.output()).not.toContain("[redacted]");
    // The unused connection was revoked.
    expect(h.gateway.revoked).toEqual([token]);
  });

  it("writes mcpServers.agentdesk into ~/.claude.json when the claude CLI is absent", async () => {
    const sandbox = makeSandbox();
    write(
      join(sandbox.home, ".claude.json"),
      JSON.stringify(
        { projects: { "/w": {} }, mcpServers: { other: { type: "stdio", command: "x" } } },
        null,
        2,
      ),
    );
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    const token = h.gateway.tokenFor("claude-code");
    expect(readJson(join(sandbox.home, ".claude.json"))).toEqual({
      projects: { "/w": {} },
      mcpServers: {
        other: { type: "stdio", command: "x" },
        agentdesk: {
          type: "http",
          url: `${SERVER}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
  });

  it("writes the Codex table and keeps the rest of config.toml", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const file = join(sandbox.home, ".codex", "config.toml");
    write(file, CODEX_BEFORE + CODEX_AFTER);
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    const token = h.gateway.tokenFor("codex");
    expect(read(file)).toBe(
      `${CODEX_BEFORE + CODEX_AFTER}\n[mcp_servers.agentdesk]\nurl = "${SERVER}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n`,
    );
    expect(read(`${file}.agentdesk-backup`)).toBe(CODEX_BEFORE + CODEX_AFTER);
    // codex itself was never run: Codex is configured through its file.
    expect(invocations(sandbox)).toEqual([]);
  });

  it("writes CODEX_HOME/config.toml when CODEX_HOME is set", async () => {
    const sandbox = makeSandbox();
    const codexHome = join(sandbox.root, "codex-home");
    mkdirSync(codexHome);
    const h = makeContext(sandbox, { env: { CODEX_HOME: codexHome } });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(read(join(codexHome, "config.toml"))).toContain("[mcp_servers.agentdesk]");
    expect(existsSync(join(codexHome, "skills", "agentdesk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sandbox.home, ".codex"))).toBe(false);
  });

  it("merges ~/.cursor/mcp.json and keeps unrelated servers", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const file = join(sandbox.home, ".cursor", "mcp.json");
    write(file, JSON.stringify({ mcpServers: { linear: { url: "https://linear" } } }, null, 2));
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    const token = h.gateway.tokenFor("cursor");
    expect(readJson(file)).toEqual({
      mcpServers: {
        linear: { url: "https://linear" },
        agentdesk: { url: `${SERVER}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      },
    });
  });

  it("refuses a malformed Cursor mcp.json before sign-in and leaves it unchanged", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "cursor-agent");
    const file = join(sandbox.home, ".cursor", "mcp.json");
    write(file, "{ broken");
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(read(file)).toBe("{ broken");
    expect(h.err.join("\n")).toContain("is not valid JSON");
    expect(h.gateway.requests).toEqual([]);
    expect(existsSync(`${file}.agentdesk-backup`)).toBe(false);
  });

  it("creates new configuration files with mode 0600 and no backup holds a token from the run", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    stubExecutable(sandbox, "cursor-agent");
    write(join(sandbox.home, ".claude.json"), "{}\n");
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);
    const tokens = h.gateway.issued.map((i) => i.token);
    expect(tokens).toHaveLength(3);
    const backups = allFiles(sandbox.home).filter((f) => f.endsWith(".agentdesk-backup"));
    expect(backups.length).toBeGreaterThan(0);
    for (const backup of backups) {
      const content = readFileSync(backup, "utf8");
      for (const token of tokens) expect(content).not.toContain(token);
    }
    const toml = join(sandbox.home, ".codex", "config.toml");
    expect(statSync(toml).mode & 0o777).toBe(0o600);
    expect(statSync(join(sandbox.home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o600);
  });
});
