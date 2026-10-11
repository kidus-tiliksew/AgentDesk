import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnswerHelper, McpClient, runSmoke, SmokeError } from "./smoke-mcp-steps.js";

// component-gateway §Verification: the MCP smoke run against a running gateway
// and its Convex dev deployment. Run from apps/gateway:
//
//   AGENTDESK_GATEWAY_URL=http://localhost:8787 AGENTDESK_CONNECTION_TOKEN=adc_… \
//     pnpm smoke:mcp [--quick]
//
// It settles the first decision with `npx convex run decisions/devAnswer:answer`
// from the repository root, so the Convex CLI there must select the deployment
// the gateway's CONVEX_SITE_URL names. CI never runs it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Bound on one `npx convex run`, which may download the CLI on first use.
const HELPER_TIMEOUT_MS = 120_000;

const answerWithConvex: AnswerHelper = (args) =>
  new Promise((done, fail) => {
    // No shell: the JSON argument reaches the CLI as one argv entry.
    execFile(
      "npx",
      ["convex", "run", "decisions/devAnswer:answer", JSON.stringify(args)],
      { cwd: root, timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) {
          done();
          return;
        }
        const detail = stderr.trim().split("\n").slice(-5).join("\n");
        fail(new Error(`npx convex run failed (${error.message.split("\n")[0]})\n${detail}`));
      },
    );
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
