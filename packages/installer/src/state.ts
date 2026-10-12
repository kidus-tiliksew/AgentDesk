import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./config.js";
import { type Context, InstallerError } from "./context.js";
import { type HarnessId, isHarnessId } from "./harnesses.js";

/**
 * One recorded harness. Tokens are never recorded: they live only in the
 * harness configuration (component-installer §State, re-run, and uninstall).
 */
export interface HarnessRecord {
  /** Server the connection belongs to; absent for a skill-only record. */
  server?: string;
  connectionId?: string;
  configPath?: string;
  /** The skill folder this installation owns. */
  skillPath?: string;
  /**
   * The skill folder's resolved path when it was written. Removal requires the
   * folder to resolve to it still, so a base redirected after install (such as
   * a symlinked ~/.codex or CODEX_HOME) is refused.
   */
  skillRealPath?: string;
  skillVersion?: string;
}

export interface State {
  version: 1;
  /** The server of the latest install run. */
  server?: string;
  harnesses: Partial<Record<HarnessId, HarnessRecord>>;
}

export function emptyState(): State {
  return { version: 1, harnesses: {} };
}

export function statePath(ctx: Context): string {
  const xdg = ctx.env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(ctx.home, ".config");
  return join(base, "agentdesk", "state.json");
}

const RECORD_FIELDS = [
  "server",
  "connectionId",
  "configPath",
  "skillPath",
  "skillRealPath",
  "skillVersion",
] as const;

export function readState(ctx: Context): State | undefined {
  const file = statePath(ctx);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new InstallerError(`${file} is not valid JSON. Move it aside, then run again.`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InstallerError(
      `${file} is not an AgentDesk state file. Move it aside, then run again.`,
    );
  }
  const value = raw as Record<string, unknown>;
  const state = emptyState();
  if (typeof value.server === "string") state.server = value.server;
  const harnesses = value.harnesses;
  if (typeof harnesses === "object" && harnesses !== null) {
    for (const [id, record] of Object.entries(harnesses as Record<string, unknown>)) {
      if (!isHarnessId(id) || typeof record !== "object" || record === null) continue;
      const clean: HarnessRecord = {};
      for (const field of RECORD_FIELDS) {
        const fieldValue = (record as Record<string, unknown>)[field];
        if (typeof fieldValue === "string") clean[field] = fieldValue;
      }
      state.harnesses[id] = clean;
    }
  }
  return state;
}

/** Writes the state file with mode 0600 in a 0700 directory. */
export function writeState(ctx: Context, state: State): void {
  const file = statePath(ctx);
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  chmodSync(file, 0o600);
}

export function deleteState(ctx: Context): void {
  rmSync(statePath(ctx), { force: true });
}

export function recordedServer(state: State, id: HarnessId): string | undefined {
  return state.harnesses[id]?.server ?? state.server;
}
