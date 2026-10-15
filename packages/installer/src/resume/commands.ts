import { parseArgs } from "node:util";
import type { Context } from "../context.js";
import { HARNESS_IDS, type HarnessId, isHarnessId } from "../harnesses.js";
import { runCodexStop } from "./codex.js";
import { runCursorAfterMcp, runCursorStop } from "./cursor.js";
import { type HookAdapters, nodeHookAdapters } from "./process.js";
import { isSafeId } from "./storage.js";
import { runWait, type WaitOptions } from "./waiter.js";

// The `wait` and `hook` commands' arguments (component-installer §Commands;
// component-resume). Each parser throws an Error whose message the CLI prints
// with the usage text and status 2.

export const WAIT_USAGE =
  "Use: agentdesk wait --harness <id> [--codex-thread <thread>] <decision-id>";
export const HOOK_USAGE = "Use: agentdesk hook <stop|after-mcp> --harness <id>";

function harnessOption(value: string | undefined, usage: string): HarnessId {
  if (value === undefined) throw new Error(usage);
  if (!isHarnessId(value)) {
    throw new Error(`Unknown harness ${JSON.stringify(value)}. Use ${HARNESS_IDS.join(", ")}.`);
  }
  return value;
}

export function parseWaitArgs(args: readonly string[]): WaitOptions {
  const parsed = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { harness: { type: "string" }, "codex-thread": { type: "string" } },
  });
  const harness = harnessOption(parsed.values.harness, WAIT_USAGE);
  const [decisionId, ...extra] = parsed.positionals;
  if (decisionId === undefined || extra.length > 0) throw new Error(WAIT_USAGE);
  if (!isSafeId(decisionId)) throw new Error(`${JSON.stringify(decisionId)} is not a decision id.`);
  const codexThread = parsed.values["codex-thread"];
  if (codexThread !== undefined && !isSafeId(codexThread)) {
    throw new Error(`${JSON.stringify(codexThread)} is not a Codex thread id.`);
  }
  return { harness, decisionId, ...(codexThread !== undefined ? { codexThread } : {}) };
}

export type HookEvent = "stop" | "after-mcp";

export interface HookOptions {
  event: HookEvent;
  harness: HarnessId;
}

/** The hooks each harness runs: `stop` for Codex and Cursor, `after-mcp` for Cursor. */
const SUPPORTED_HOOKS: Record<HookEvent, readonly HarnessId[]> = {
  stop: ["codex", "cursor"],
  "after-mcp": ["cursor"],
};

export function parseHookArgs(args: readonly string[]): HookOptions {
  const parsed = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { harness: { type: "string" } },
  });
  const [event, ...extra] = parsed.positionals;
  if (event === undefined || extra.length > 0) throw new Error(HOOK_USAGE);
  if (event !== "stop" && event !== "after-mcp") {
    throw new Error(`Unknown hook ${JSON.stringify(event)}. Use stop or after-mcp.`);
  }
  const harness = harnessOption(parsed.values.harness, HOOK_USAGE);
  if (!SUPPORTED_HOOKS[event].includes(harness)) {
    throw new Error(`${harness} has no ${event} hook.`);
  }
  return { event, harness };
}

/** Runs one resume hook. Hook input errors never fail the hook; it prints its JSON. */
export function runHook(
  ctx: Context,
  options: HookOptions,
  adapters: HookAdapters = nodeHookAdapters,
): Promise<number> {
  if (options.event === "after-mcp") return runCursorAfterMcp(ctx, adapters);
  return options.harness === "codex" ? runCodexStop(ctx, adapters) : runCursorStop(ctx, adapters);
}

export { runWait };
