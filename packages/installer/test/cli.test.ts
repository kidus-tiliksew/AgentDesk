import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath } from "../src/state.js";
import {
  cleanupSandboxes,
  makeContext,
  makeSandbox,
  read,
  readJson,
  type Sandbox,
  stubExecutable,
} from "./helpers.js";

afterEach(cleanupSandboxes);

function allThree(): Sandbox {
  const sandbox = makeSandbox();
  stubExecutable(sandbox, "claude");
  stubExecutable(sandbox, "codex");
  stubExecutable(sandbox, "cursor-agent");
  return sandbox;
}

describe("selection (AC-9.1)", () => {
  it("lists every detected harness as selected and --yes keeps all without a prompt", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox, { answers: [] });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.out).toContain("  1. [x] Claude Code (claude on PATH)");
    expect(h.out).toContain("  2. [x] Codex (codex on PATH)");
    expect(h.out).toContain("  3. [x] Cursor (cursor-agent on PATH)");
    expect(h.gateway.startRequests()[0]?.body).toEqual({
      machine_name: "devbox-1",
      harnesses: ["claude-code", "codex", "cursor"],
    });
  });

  it("installs for every harness when the user presses Enter", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox, { answers: [""] });
    expect(await h.run(["install"])).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(h.gateway.startRequests()[0]?.body).toMatchObject({
      harnesses: ["claude-code", "codex", "cursor"],
    });
  });

  it("leaves out a harness the user deselects", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox, { answers: ["2"] });
    expect(await h.run(["install"])).toBe(0);
    expect(h.gateway.startRequests()[0]?.body).toMatchObject({
      harnesses: ["claude-code", "cursor"],
    });
    expect(existsSync(join(sandbox.home, ".codex", "config.toml"))).toBe(false);
    expect(Object.keys(readJson(statePath(h.ctx)).harnesses as object)).toEqual([
      "claude-code",
      "cursor",
    ]);
  });

  it("writes nothing when the user deselects every harness", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox, { answers: ["1 2,3"] });
    expect(await h.run(["install"])).toBe(0);
    expect(h.out).toContain("No harness selected. Nothing was installed.");
    expect(h.gateway.requests).toEqual([]);
    expect(existsSync(statePath(h.ctx))).toBe(false);
    expect(existsSync(join(sandbox.home, ".cursor"))).toBe(false);
  });

  it("refuses an answer that is not a listed number", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox, { answers: ["4"] });
    expect(await h.run(["install"])).toBe(2);
    expect(h.gateway.requests).toEqual([]);
  });

  it("--only selects the named harnesses without a prompt", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox, { answers: [] });
    expect(await h.run(["install", "--only", "codex,cursor"])).toBe(0);
    expect(h.gateway.startRequests()[0]?.body).toMatchObject({ harnesses: ["codex", "cursor"] });
    expect(existsSync(join(sandbox.home, ".claude", "skills"))).toBe(false);
  });

  it("--only reports a harness that is not detected and skips it", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--only", "claude-code", "--only", "codex"])).toBe(0);
    expect(h.out).toContain("Claude Code: not detected on this machine; skipped.");
    expect(h.gateway.startRequests()[0]?.body).toMatchObject({ harnesses: ["codex"] });
  });

  it("--only refuses an unknown harness id before any write", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--only", "vscode"])).toBe(2);
    expect(h.err.join("\n")).toContain('Unknown harness "vscode"');
    expect(h.gateway.requests).toEqual([]);
  });

  it("selects every detected harness when no terminal can answer", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox);
    expect(await h.run(["install"])).toBe(0);
    expect(h.gateway.startRequests()[0]?.body).toMatchObject({
      harnesses: ["claude-code", "codex", "cursor"],
    });
  });
});

describe("--server (AC-9.5)", () => {
  it("configures every harness for the given server and stores it in state", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes", "--server", "https://self.example/agentdesk/"])).toBe(
      0,
    );
    const server = "https://self.example/agentdesk";
    expect(h.gateway.requests.every((r) => r.url.startsWith(`${server}/`))).toBe(true);
    expect(readJson(statePath(h.ctx)).server).toBe(server);
    const claude = readJson(join(sandbox.home, ".claude.json")).mcpServers as Record<
      string,
      { url: string }
    >;
    expect(claude.agentdesk?.url).toBe(`${server}/mcp`);
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toContain(`url = "${server}/mcp"`);
    const cursor = readJson(join(sandbox.home, ".cursor", "mcp.json")).mcpServers as Record<
      string,
      { url: string }
    >;
    expect(cursor.agentdesk?.url).toBe(`${server}/mcp`);
    const state = readJson(statePath(h.ctx)).harnesses as Record<string, { server: string }>;
    expect(Object.values(state).map((r) => r.server)).toEqual([server, server, server]);
  });

  it("uses the build's default server when --server is absent", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox, { defaultServer: "https://default.example" });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.gateway.requests[0]?.url).toBe("https://default.example/device/start");
  });

  it("fails before any write without --server when the build has no default", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox, { defaultServer: undefined });
    expect(await h.run(["install", "--yes"])).toBe(2);
    expect(h.err.join("\n")).toContain("Pass --server <url>");
    expect(h.gateway.requests).toEqual([]);
  });

  it("refuses a server URL that is not http or https", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes", "--server", "ftp://x.example"])).toBe(2);
    expect(h.gateway.requests).toEqual([]);
  });
});

describe("command line", () => {
  it("prints usage for help and fails for an unknown command or option", async () => {
    const h = makeContext(makeSandbox());
    expect(await h.run(["--help"])).toBe(0);
    expect(h.out.join("\n")).toContain("agentdesk <command>");
    expect(await h.run(["launch"])).toBe(2);
    expect(await h.run(["install", "--browser"])).toBe(2);
    expect(await h.run(["skill"])).toBe(2);
    expect(await h.run([])).toBe(2);
  });

  it("prints the version", async () => {
    const h = makeContext(makeSandbox());
    expect(await h.run(["--version"])).toBe(0);
    expect(h.out).toEqual(["0.0.0-dev"]);
  });
});
