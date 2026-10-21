import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupSandboxes,
  GUIDANCE_FILE,
  makeSandbox,
  PACKAGE_DIR,
  read,
  readJson,
  type Sandbox,
  SKILL_FILE,
} from "./helpers.js";

// component-installer §Verification: builds dist/agentdesk.mjs with
// scripts/build.mjs, as scripts/build-binaries.mjs does before compiling it,
// and runs it outside the workspace against a local HTTP fake gateway. The
// bundle sits at <outside>/bin/agentdesk, the name the release binary installs
// under, so the hooks it writes name an executable ending in /agentdesk.

const TOKEN = "adc_bundledtoken0000000000000000000000";
let server: Server;
let origin: string;
let sandbox: Sandbox;
let bundle: string;
const requests: { method: string; url: string; body: string }[] = [];

/** Runs the bundle with Node asynchronously so the in-process HTTP gateway keeps serving. */
function runBundle(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd: sandbox.root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/device/start") {
        res.end(
          JSON.stringify({
            user_code: "K7QM2XWZ",
            device_secret: "s".repeat(43),
            interval: 2,
            expires_in: 600,
          }),
        );
      } else if (req.url === "/device/poll") {
        res.end(
          JSON.stringify({
            status: "approved",
            connections: [{ harness: "cursor", connection_id: "conn_1", token: TOKEN }],
          }),
        );
      } else if (req.url === "/device/connection") {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  sandbox = makeSandbox();
  bundle = join(sandbox.root, "outside", "bin", "agentdesk");
  mkdirSync(dirname(bundle), { recursive: true });
  const built = spawnSync(
    process.execPath,
    [join(PACKAGE_DIR, "scripts", "build.mjs"), "--outfile", bundle],
    { encoding: "utf8", env: { ...process.env, AGENTDESK_SERVER_ORIGIN: origin } },
  );
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`);
}, 60_000);

afterAll(() => {
  server?.close();
  cleanupSandboxes();
});

describe("package agentdesk (DEC-10)", () => {
  it("is private and has no prepack, so it is never published to npm", () => {
    const manifest = readJson(join(PACKAGE_DIR, "package.json"));
    expect(manifest.private).toBe(true);
    expect((manifest.scripts as Record<string, string>).prepack).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
  });
});

describe("bundle dist/agentdesk.mjs", () => {
  it("is one file that imports only Node built-ins, with every build constant replaced", () => {
    const text = read(bundle);
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
    expect(text).not.toContain("__AGENTDESK_");
  });

  it("prints its version and an empty status outside the workspace", async () => {
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    // The build compiles the manifest's version in, so a release bump needs no
    // edit here.
    const { version } = readJson(join(PACKAGE_DIR, "package.json"));
    expect((await runBundle(["--version"], env)).stdout.trim()).toBe(version);
    const status = await runBundle(["status"], env);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("AgentDesk is not installed on this machine.");
  });

  it("prints the embedded guidance from context", async () => {
    const env = { HOME: join(sandbox.root, "no-home"), PATH: sandbox.bin };
    const plain = await runBundle(["context", "--harness", "codex"], env);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(read(GUIDANCE_FILE));
    const cursor = await runBundle(["context", "--harness", "cursor"], env);
    expect(JSON.parse(cursor.stdout)).toEqual({ additional_context: read(GUIDANCE_FILE) });
    expect(existsSync(join(sandbox.root, "no-home"))).toBe(false);
  });

  it("installs the embedded skill byte for byte with the hook", async () => {
    const home = join(sandbox.root, "skill-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const result = await runBundle(["skill", "install"], { HOME: home, PATH: sandbox.bin });
    expect(result.code).toBe(0);
    expect(readFileSync(join(home, ".codex", "skills", "agentdesk", "SKILL.md"))).toEqual(
      readFileSync(SKILL_FILE),
    );
    expect(result.stdout).toContain("skill 2.3.0");
    // codex is not on PATH, so trust for each hook is left to Codex's /hooks.
    expect(result.stdout).toContain(
      "Codex: the AgentDesk session-start hook is not trusted yet (codex is not on PATH). In Codex, run /hooks and trust the AgentDesk session-start hook.",
    );
    expect(result.stdout).toContain(
      "Codex: the AgentDesk Stop hook is not trusted yet (codex is not on PATH). In Codex, run /hooks and trust the AgentDesk Stop hook.",
    );
    expect(readJson(join(home, ".codex", "hooks.json"))).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: "startup|clear|compact",
            hooks: [{ type: "command", command: `${bundle} context --harness codex` }],
          },
        ],
        Stop: [
          {
            hooks: [
              { type: "command", command: `${bundle} hook stop --harness codex`, timeout: 10 },
            ],
          },
        ],
      },
    });
    const status = await runBundle(["status"], { HOME: home, PATH: sandbox.bin });
    expect(status.stdout).toContain(
      `; session-start hook in ${join(home, ".codex", "hooks.json")}, trust could not be checked; confirm it in Codex's /hooks; Stop hook in ${join(home, ".codex", "hooks.json")}, trust could not be checked; confirm it in Codex's /hooks`,
    );
  });

  it("signs in against the build's default server and writes the connection and the hook", async () => {
    const home = join(sandbox.root, "install-home");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const result = await runBundle(["install", "--yes"], { HOME: home, PATH: sandbox.bin });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("K7QM-2XWZ");
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stdout).toContain("Start a new agent session");
    expect(requests.find((r) => r.url === "/device/start")?.body).toContain(
      '"harnesses":["cursor"]',
    );
    expect(readJson(join(home, ".cursor", "mcp.json"))).toEqual({
      mcpServers: {
        agentdesk: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
    const hooks = readJson(join(home, ".cursor", "hooks.json"));
    const command = `${bundle} context --harness cursor`;
    const afterMcp = `${bundle} hook after-mcp --harness cursor`;
    const stop = `${bundle} hook stop --harness cursor`;
    expect(hooks).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command }],
        afterMCPExecution: [{ command: afterMcp }],
        stop: [{ command: stop, timeout: 3600, loop_limit: null }],
      },
    });
    expect(read(join(home, ".cursor", "hooks.json"))).not.toContain(TOKEN);
    expect(existsSync(join(home, ".config", "agentdesk", "state.json"))).toBe(true);

    // The hook's command, run by a shell as Cursor runs it, prints the guidance.
    // PATH holds node for the bundle's `#!/usr/bin/env node` line; node need not be in /usr/bin.
    const hook = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    expect(hook.status).toBe(0);
    expect(JSON.parse(hook.stdout)).toEqual({ additional_context: read(GUIDANCE_FILE) });

    // The resume hooks' commands, run the same way, reach the merged hook
    // commands: input naming no AgentDesk ask, and a turn that did not
    // complete, each print {} at once.
    const shellEnv = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const after = spawnSync("/bin/sh", ["-c", afterMcp], {
      encoding: "utf8",
      env: shellEnv,
      input: JSON.stringify({ mcp_server_name: "github", tool_name: "x", conversation_id: "c1" }),
    });
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({});
    const held = spawnSync("/bin/sh", ["-c", stop], {
      encoding: "utf8",
      env: shellEnv,
      input: JSON.stringify({ status: "aborted", conversation_id: "c1" }),
    });
    expect(held.status).toBe(0);
    expect(JSON.parse(held.stdout)).toEqual({});
  });
});
