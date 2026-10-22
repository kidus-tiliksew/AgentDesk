import { basename, resolve } from "node:path";
import { type Context, InstallerError } from "./context.js";
import type { Harness } from "./harnesses.js";

/**
 * The absolute path of the running `agentdesk` executable: the compiled
 * binary, or the bundle file when Node runs it (component-installer §Standing
 * guidance).
 */
export function runningExecutable(): string {
  const runtime = basename(process.execPath).toLowerCase();
  const script = process.argv[1];
  if (script && (runtime === "node" || runtime === "nodejs")) return resolve(script);
  return process.execPath;
}

/**
 * The guidance for `harness`. The last line points to the skill, so it is
 * omitted for a harness without skills.
 */
export function guidanceFor(text: string, harness: Harness): string {
  if (harness.supportsSkills) return text;
  const body = text.replace(/\r?\n$/, "");
  const cut = body.lastIndexOf("\n");
  return cut < 0 ? "" : body.slice(0, cut + 1);
}

/**
 * The environment variable a launching agent sets, for one child agent process
 * it starts, to mark that process's session as a child session
 * (component-installer §`agentdesk context`).
 */
export const PARENT_SESSION_ENV = "AGENTDESK_PARENT_SESSION";

/**
 * The guidance a child session starts with in place of the whole standing
 * guidance. It is the same for every harness, with or without skills.
 */
export const CHILD_GUIDANCE =
  "AgentDesk belongs to the agent that started this session. Report progress and questions to that agent. Do not call any AgentDesk tool.";

/**
 * Whether `env` marks a child session: `AGENTDESK_PARENT_SESSION` set to any
 * value other than the empty string. The value is not trimmed, no value means
 * false, and the value itself is never used.
 */
export function isChildSession(env: Context["env"]): boolean {
  const value = env[PARENT_SESSION_ENV];
  return value !== undefined && value !== "";
}

/**
 * `agentdesk context --harness <id>`: prints the standing guidance compiled
 * into the build, or the child guidance when `AGENTDESK_PARENT_SESSION` marks
 * a child session, as plain text for Claude Code and Codex and as
 * `{"additional_context": ...}` for Cursor. Besides its embedded inputs it
 * reads only that variable from the process environment: it reads no state
 * file or other persisted configuration, writes no file, and makes no network
 * call.
 */
export function printContext(ctx: Context, harness: Harness): number {
  if (ctx.guidance === undefined) {
    throw new InstallerError(
      "This build carries no standing guidance; build it with scripts/build.mjs.",
    );
  }
  // The child guidance never passes through guidanceFor: its last-line
  // omission belongs to the standing guidance's skill pointer.
  const text = isChildSession(ctx.env) ? CHILD_GUIDANCE : guidanceFor(ctx.guidance, harness);
  if (harness.hookFormat === "cursor") {
    ctx.io.out(JSON.stringify({ additional_context: text }));
  } else {
    ctx.io.out(text.replace(/\n$/, ""));
  }
  return 0;
}
