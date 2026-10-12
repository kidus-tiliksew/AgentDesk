import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupSandboxes,
  makeSandbox,
  PACKAGE_DIR,
  read,
  readJson,
  type Sandbox,
  SKILL_FILE,
} from "./helpers.js";

// Builds the bundle, packs the npm package, and runs the packed entry outside
// the workspace against a local HTTP fake gateway.

const TOKEN = "adc_packagedtoken000000000000000000000";
let server: Server;
let origin: string;
let sandbox: Sandbox;
let extracted: string;
const requests: { method: string; url: string; body: string }[] = [];

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** Runs the packed entry asynchronously so the in-process HTTP gateway keeps serving. */
function runEntry(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(extracted, "package", "dist", "agentdesk.mjs"), ...args],
      {
        cwd: sandbox.root,
        env,
      },
    );
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
  const stage = join(sandbox.root, "stage");
  mkdirSync(join(stage, "dist"), { recursive: true });
  copyFileSync(join(PACKAGE_DIR, "package.json"), join(stage, "package.json"));
  run(
    process.execPath,
    [join(PACKAGE_DIR, "scripts", "build.mjs"), "--outfile", join(stage, "dist", "agentdesk.mjs")],
    {
      env: { ...process.env, AGENTDESK_SERVER_ORIGIN: origin },
    },
  );
  const packDir = join(sandbox.root, "pack");
  mkdirSync(packDir);
  run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", packDir], {
    cwd: stage,
  });
  const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  extracted = join(sandbox.root, "outside");
  mkdirSync(extracted);
  run("tar", ["-xzf", join(packDir, tarball), "-C", extracted]);
}, 60_000);

afterAll(() => {
  server?.close();
  cleanupSandboxes();
});

describe("npm package agentdesk", () => {
  it("has the agentdesk bin, a Node 20 engine, and no dependency", () => {
    const manifest = readJson(join(extracted, "package", "package.json"));
    expect(manifest.name).toBe("agentdesk");
    expect(manifest.bin).toEqual({ agentdesk: "dist/agentdesk.mjs" });
    expect(manifest.engines).toEqual({ node: ">=20" });
    expect(manifest.dependencies).toBeUndefined();
    expect(read(join(extracted, "package", "package.json"))).not.toContain("workspace:");
    expect(readdirSync(join(extracted, "package")).sort()).toEqual(["dist", "package.json"]);
    expect(readdirSync(join(extracted, "package", "dist"))).toEqual(["agentdesk.mjs"]);
  });

  it("bundles everything into one file that imports only Node built-ins", () => {
    const bundle = read(join(extracted, "package", "dist", "agentdesk.mjs"));
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const imports = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
    expect(bundle).not.toContain("__AGENTDESK_");
  });

  it("prints its version and an empty status outside the workspace", async () => {
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    expect((await runEntry(["--version"], env)).stdout.trim()).toBe("0.0.0");
    const status = await runEntry(["status"], env);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("AgentDesk is not installed on this machine.");
  });

  it("installs the embedded skill byte for byte", async () => {
    const home = join(sandbox.root, "skill-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const result = await runEntry(["skill", "install"], { HOME: home, PATH: sandbox.bin });
    expect(result.code).toBe(0);
    expect(readFileSync(join(home, ".codex", "skills", "agentdesk", "SKILL.md"))).toEqual(
      readFileSync(SKILL_FILE),
    );
    expect(result.stdout).toContain("skill 1.0.0");
  });

  it("signs in against the build's default server and writes the connection", async () => {
    const home = join(sandbox.root, "install-home");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const result = await runEntry(["install", "--yes"], { HOME: home, PATH: sandbox.bin });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("K7QM-2XWZ");
    expect(result.stdout).not.toContain(TOKEN);
    expect(requests.find((r) => r.url === "/device/start")?.body).toContain(
      '"harnesses":["cursor"]',
    );
    expect(readJson(join(home, ".cursor", "mcp.json"))).toEqual({
      mcpServers: {
        agentdesk: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
    expect(existsSync(join(home, ".config", "agentdesk", "state.json"))).toBe(true);
  });
});
