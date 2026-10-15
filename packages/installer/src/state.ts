import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./config.js";
import { type Context, InstallerError } from "./context.js";
import { type HarnessId, isHarnessId } from "./harnesses.js";
import { type HookEventId, hookEventIds } from "./hooks.js";

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
  /** The file that holds this installation's session-start hook. */
  hookPath?: string;
  /** Codex and Cursor: the file that holds this installation's `stop` resume hook. */
  stopHookPath?: string;
  /** Cursor only: the file that holds this installation's `afterMCPExecution` resume hook. */
  afterMcpHookPath?: string;
  /** Codex only: the `hooks.state` key whose trust this installation recorded for the session-start hook. */
  codexTrustKey?: string;
  /** Codex only: the `hooks.state` key whose trust this installation recorded for the `Stop` hook. */
  codexStopTrustKey?: string;
}

/** The record field that names the file holding each hook (component-installer §State, re-run, and uninstall). */
export const HOOK_PATH_FIELDS = {
  "session-start": "hookPath",
  stop: "stopHookPath",
  "after-mcp": "afterMcpHookPath",
} as const satisfies Record<HookEventId, keyof HarnessRecord>;

/** The record field that holds each Codex hook's trusted key. */
export const TRUST_KEY_FIELDS = {
  "session-start": "codexTrustKey",
  stop: "codexStopTrustKey",
} as const satisfies Partial<Record<HookEventId, keyof HarnessRecord>>;

/** The hooks a record names a file for, in the installer's order. */
export function recordedHookEvents(id: HarnessId, record: HarnessRecord): HookEventId[] {
  return hookEventIds(id).filter((event) => record[HOOK_PATH_FIELDS[event]] !== undefined);
}

/**
 * A connection this installation was issued whose revocation is not
 * established. It holds no secret. It stays recorded until the person removes
 * it with `agentdesk forget <connection-id>` or `agentdesk uninstall
 * --forget-unrevoked` after revoking it in the app, so no issued connection is
 * forgotten silently (AC-9.6).
 */
export interface UnrevokedConnection {
  /** "unknown" when the server named no harness the installer knows. */
  harness: HarnessId | "unknown";
  connectionId: string;
  server: string;
  /** Why it could not be revoked from the machine. */
  reason: string;
}

export interface State {
  version: 1;
  /** The server of the latest install run. */
  server?: string;
  harnesses: Partial<Record<HarnessId, HarnessRecord>>;
  unrevoked: UnrevokedConnection[];
}

export function emptyState(): State {
  return { version: 1, harnesses: {}, unrevoked: [] };
}

/** Adds a recovery record once per connection id. */
export function recordUnrevoked(state: State, connection: UnrevokedConnection): void {
  if (!state.unrevoked.some((u) => u.connectionId === connection.connectionId)) {
    state.unrevoked.push(connection);
  }
}

/** Whether the state still records anything worth keeping. */
export function stateIsEmpty(state: State): boolean {
  return Object.keys(state.harnesses).length === 0 && state.unrevoked.length === 0;
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
  "hookPath",
  "stopHookPath",
  "afterMcpHookPath",
  "codexTrustKey",
  "codexStopTrustKey",
] as const;

/**
 * Fields an installer before the resume hooks never wrote. Each is a
 * non-empty string, held only by a harness that has that hook.
 */
const RESUME_FIELDS: Readonly<Record<string, (id: HarnessId) => boolean>> = {
  stopHookPath: (id) => hookEventIds(id).includes("stop"),
  afterMcpHookPath: (id) => hookEventIds(id).includes("after-mcp"),
  codexStopTrustKey: (id) => id === "codex",
};

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
      // A record the installer cannot read is refused, never dropped: it may
      // hold the only copy of a connection id.
      if (!isHarnessId(id) || typeof record !== "object" || record === null) {
        throw new InstallerError(
          `${file} has a harness record the installer cannot read (${JSON.stringify(id)}). Fix it, then run again.`,
        );
      }
      const clean: HarnessRecord = {};
      for (const field of RECORD_FIELDS) {
        const fieldValue = (record as Record<string, unknown>)[field];
        if (fieldValue === undefined) continue;
        const applies = RESUME_FIELDS[field];
        if (
          typeof fieldValue !== "string" ||
          (applies !== undefined && (fieldValue.length === 0 || !applies(id)))
        ) {
          throw new InstallerError(
            `${file} has an unreadable ${field} for ${id}. Fix it, then run again.`,
          );
        }
        clean[field] = fieldValue;
      }
      state.harnesses[id] = clean;
    }
  }
  if (value.unrevoked !== undefined) {
    // A recovery record that cannot be read is refused, never dropped.
    const invalid = () =>
      new InstallerError(`${file} has an unreadable unrevoked connection. Fix it, then run again.`);
    if (!Array.isArray(value.unrevoked)) throw invalid();
    for (const item of value.unrevoked) {
      if (typeof item !== "object" || item === null) throw invalid();
      const { harness, connectionId, server, reason } = item as Record<string, unknown>;
      if (
        typeof harness !== "string" ||
        (!isHarnessId(harness) && harness !== "unknown") ||
        typeof connectionId !== "string" ||
        connectionId.length === 0 ||
        typeof server !== "string" ||
        server.length === 0
      ) {
        throw invalid();
      }
      state.unrevoked.push({
        harness: harness as HarnessId | "unknown",
        connectionId,
        server,
        reason: typeof reason === "string" ? reason : "revocation not established",
      });
    }
  }
  return state;
}

/** Writes the state file with mode 0600 in a 0700 directory. */
export function writeState(ctx: Context, state: State): void {
  const file = statePath(ctx);
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { unrevoked, ...rest } = state;
  const value = unrevoked.length > 0 ? { ...rest, unrevoked } : rest;
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  chmodSync(file, 0o600);
}

export function deleteState(ctx: Context): void {
  rmSync(statePath(ctx), { force: true });
}

export function recordedServer(state: State, id: HarnessId): string | undefined {
  return state.harnesses[id]?.server ?? state.server;
}
