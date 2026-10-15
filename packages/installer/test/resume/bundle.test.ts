import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupSandboxes, makeSandbox, PACKAGE_DIR } from "../helpers.js";
import { decision, FIXTURES, installSandbox, resumeRoot, stubCodex, TOKENS } from "./helpers.js";

// The resume commands in the bundle that scripts/build.mjs builds, run as the
// harness hooks run them: hook input on standard input, against a local HTTP
// gateway that answers `POST /device/wait` as component-gateway §Waiter
// endpoint states. The Codex case follows the hook through the detached
// waiter it starts to the stub `codex queue`.

const THREAD = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";
let server: Server;
let origin: string;
let bundle: string;
const requests: { decisionId: string; authorization: string | undefined }[] = [];
/** The event each decision's wait answers with. */
const answers = new Map<string, unknown>([
  ["dec_phone1", { decision: decision("dec_phone1", { answered_via: "app" }) }],
  ["dec_phone2", { decision: decision("dec_phone2", { answered_via: "chat" }) }],
  ["dec_cursor1", { decision: decision("dec_cursor1", { answered_via: "notification" }) }],
]);

function message(id: string): string {
  return `AgentDesk decision ${id} settled. Read it with check, tell the user the answer and where it was given, then act on it.`;
}

/**
 * Runs the bundle and resolves once its streams close. `ms` is the time to
 * the process's own exit. `stdin: "open"` keeps standard input open with no
 * data, as a stalled harness would. A child still running after 20 seconds is
 * killed and reported with `killed: true`.
 */
function runBundle(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string | { open: true },
): Promise<{ code: number; stdout: string; stderr: string; ms: number; killed: boolean }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { env });
    let stdout = "";
    let stderr = "";
    let exitedAt = 0;
    let killed = false;
    const guard = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("exit", () => {
      exitedAt = Date.now();
      clearTimeout(guard);
      if (!child.stdin.destroyed) child.stdin.destroy();
    });
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr, ms: (exitedAt || Date.now()) - started, killed }),
    );
    if (typeof stdin === "string") child.stdin.end(stdin);
    else if (stdin === undefined) child.stdin.end();
  });
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/device/wait") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      const { decision_id: decisionId } = JSON.parse(body) as { decision_id: string };
      requests.push({ decisionId, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": keepalive\n\n");
      const answer = answers.get(decisionId) ?? {
        error: { code: "not_found", message: "Decision not found" },
      };
      res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outside = makeSandbox();
  bundle = join(outside.root, "outside", "bin", "agentdesk");
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

describe("resume commands in the bundle", () => {
  it("the Codex Stop hook returns {} at once and its detached waiter queues the resume", async () => {
    const sandbox = installSandbox(["codex"], origin);
    const log = stubCodex(sandbox, 0);
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    const input = readFileSync(join(FIXTURES, "codex-stop-input.json"), "utf8").replace(
      "__TRANSCRIPT__",
      join(FIXTURES, "codex-transcript.jsonl"),
    );
    const hook = await runBundle(["hook", "stop", "--harness", "codex"], env, input);
    expect(hook.code).toBe(0);
    expect(hook.stdout).toBe("{}\n");
    expect(hook.stderr).toBe("");
    expect(hook.ms).toBeLessThan(10_000);
    // dec_phone1 was answered in the app and resumes; dec_phone2 was answered
    // in chat and resumes nothing.
    await waitFor(() => existsSync(log));
    await waitFor(() => requests.filter((r) => r.decisionId.startsWith("dec_phone")).length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(calls).toEqual([["queue", "--thread", THREAD, "--message", message("dec_phone1")]]);
    const waits = requests.filter((r) => r.decisionId.startsWith("dec_phone"));
    expect(waits.every((r) => r.authorization === `Bearer ${TOKENS.codex}`)).toBe(true);
    expect(existsSync(join(resumeRoot(sandbox), "claims", "dec_phone1"))).toBe(true);
    expect(existsSync(join(resumeRoot(sandbox), "claims", "dec_phone2"))).toBe(false);
  }, 30_000);

  it("the Cursor hooks record the ask result and return its followup_message", async () => {
    const sandbox = installSandbox(["cursor"], origin);
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    const after = await runBundle(
      ["hook", "after-mcp", "--harness", "cursor"],
      env,
      readFileSync(join(FIXTURES, "cursor-after-mcp-input.json"), "utf8"),
    );
    expect(after).toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
    const stop = await runBundle(
      ["hook", "stop", "--harness", "cursor"],
      env,
      readFileSync(join(FIXTURES, "cursor-stop-input.json"), "utf8"),
    );
    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe(`${JSON.stringify({ followup_message: message("dec_cursor1") })}\n`);
    expect(stop.stderr).toBe("");
  }, 30_000);

  it("the Codex Stop hook exits promptly with {} for a transcript that would stall a read", async () => {
    const sandbox = installSandbox(["codex"], origin);
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    const fifo = join(sandbox.root, "transcript.fifo");
    const made = spawnSync("mkfifo", [fifo]);
    expect(made.status).toBe(0);
    const linked = join(sandbox.root, "transcript-link.jsonl");
    symlinkSync(fifo, linked);
    for (const transcript of [fifo, linked, "/dev/zero"]) {
      const input = JSON.stringify({ session_id: THREAD, transcript_path: transcript });
      const hook = await runBundle(["hook", "stop", "--harness", "codex"], env, input);
      // The process itself ended, well inside Codex's 10-second hook timeout.
      expect(hook.killed).toBe(false);
      expect(hook.ms).toBeLessThan(10_000);
      expect(hook.code).toBe(0);
      expect(hook.stdout).toBe("{}\n");
      expect(hook.stderr).toBe("");
    }
    // No waiter started, during the hook or after it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(join(resumeRoot(sandbox), "waiters"))).toBe(false);
  }, 60_000);

  it("the Codex Stop hook exits promptly with {} when its input never ends", async () => {
    const sandbox = installSandbox(["codex"], origin);
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    const hook = await runBundle(["hook", "stop", "--harness", "codex"], env, { open: true });
    expect(hook.killed).toBe(false);
    expect(hook.ms).toBeLessThan(10_000);
    expect(hook.code).toBe(0);
    expect(hook.stdout).toBe("{}\n");
    expect(hook.stderr).toBe("");
    expect(existsSync(join(resumeRoot(sandbox), "waiters"))).toBe(false);
  }, 30_000);

  it("the hooks print {} on bad input, and wait answers usage errors with status 2", async () => {
    const sandbox = installSandbox(["codex", "cursor"], origin);
    const env = { HOME: sandbox.home, PATH: sandbox.bin };
    for (const args of [
      ["hook", "stop", "--harness", "codex"],
      ["hook", "stop", "--harness", "cursor"],
      ["hook", "after-mcp", "--harness", "cursor"],
    ]) {
      const result = await runBundle(args, env, "{ not json");
      expect(result).toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
    }
    const usage = await runBundle(["wait", "--harness", "codex"], env);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe("");
  }, 30_000);
});
