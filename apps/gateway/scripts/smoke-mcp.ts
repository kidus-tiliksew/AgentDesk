import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HelperProcess, runHelperProcess } from "./helper-process.js";
import { type AnswerHelper, McpClient, runSmoke, SmokeError } from "./smoke-mcp-steps.js";

// component-gateway §Verification: the MCP smoke run against a running gateway
// and its Convex dev deployment. Run from apps/gateway:
//
//   AGENTDESK_GATEWAY_URL=http://localhost:8787 AGENTDESK_CONNECTION_TOKEN=adc_… \
//     pnpm smoke:mcp [--quick]
//
// It settles the answered leg's decision with
// `npx convex run decisions/devAnswer:answer` from the repository root, so the
// Convex CLI there must select the deployment the gateway's CONVEX_SITE_URL
// names. CI never runs it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Bound on one `npx convex run`, which may download the CLI on first use.
const HELPER_TIMEOUT_MS = 120_000;
// How long `npx convex run` has to exit after SIGTERM before SIGKILL.
const HELPER_GRACE_MS = 5_000;
// The standard error kept for a failure report.
const STDERR_TAIL = 2_000;

// Starts `npx convex run` from the repository root. No shell: the JSON
// argument reaches the CLI as one argv entry. The process leads its own group,
// so `kill` also stops the Convex CLI that npx starts.
function startConvexRun(args: unknown): HelperProcess {
  const child = spawn(
    "npx",
    ["convex", "run", "decisions/devAnswer:answer", JSON.stringify(args)],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr = (stderr + data).slice(-STDERR_TAIL);
  });
  return {
    exited: new Promise((done) => {
      child.once("close", (code, signal) => done({ code, signal }));
      child.once("error", (error) => {
        stderr += error.message;
        done({ code: -1, signal: null });
      });
    }),
    kill(signal) {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group has already exited.
      }
    },
    stderr: () => stderr.trim(),
  };
}

const answerWithConvex: AnswerHelper = (args, signal) =>
  runHelperProcess(() => startConvexRun(args), {
    signal,
    timeoutMs: HELPER_TIMEOUT_MS,
    graceMs: HELPER_GRACE_MS,
  });

function usage(message: string): never {
  console.error(`smoke-mcp: ${message}`);
  console.error(
    "usage: AGENTDESK_GATEWAY_URL=<gateway-url> AGENTDESK_CONNECTION_TOKEN=<adc_…> pnpm smoke:mcp [--quick]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--quick");
  if (unknown.length > 0) {
    usage(`unknown argument ${unknown[0]}`);
  }
  const url = process.env.AGENTDESK_GATEWAY_URL;
  const token = process.env.AGENTDESK_CONNECTION_TOKEN;
  if (url === undefined || !URL.canParse(url)) {
    usage("AGENTDESK_GATEWAY_URL must be the gateway's URL");
  }
  if (token === undefined || !token.startsWith("adc_")) {
    usage("AGENTDESK_CONNECTION_TOKEN must be a connection token (adc_…)");
  }

  const stop = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => stop.abort(new Error(`interrupted by ${name}`)));
  }
  const clock = { now: () => Date.now() };
  const runId = randomUUID();
  const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
  log(`smoke run ${runId} against ${new URL(url).origin}`);

  try {
    await runSmoke({
      client: new McpClient({ url, token, fetch, clock, signal: stop.signal }),
      answer: answerWithConvex,
      clock,
      runId,
      quick: args.includes("--quick"),
      log,
    });
    log("PASS");
  } catch (error) {
    if (error instanceof SmokeError) {
      log(`FAIL ${error.step}: ${error.message}`);
    } else {
      log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

await main();
