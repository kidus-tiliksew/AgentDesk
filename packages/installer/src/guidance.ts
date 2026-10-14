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
 * `agentdesk context --harness <id>`: prints the standing guidance compiled
 * into the build, as plain text for Claude Code and Codex and as
 * `{"additional_context": ...}` for Cursor. It reads no state or
 * configuration and makes no network call.
 */
export function printContext(ctx: Context, harness: Harness): number {
  if (ctx.guidance === undefined) {
    throw new InstallerError(
      "This build carries no standing guidance; build it with scripts/build.mjs.",
    );
  }
  const text = guidanceFor(ctx.guidance, harness);
  if (harness.hookFormat === "cursor") {
    ctx.io.out(JSON.stringify({ additional_context: text }));
  } else {
    ctx.io.out(text.replace(/\n$/, ""));
  }
  return 0;
}
