import { resolve } from "node:path";
import {
  BackupRegistry,
  type McpEntry,
  mcpUrl,
  readMcpEntry,
  removeMcpEntry,
  writeMcpEntry,
} from "./config.js";
import { type Context, InstallerError } from "./context.js";
import {
  type Detection,
  detectHarnesses,
  HARNESS_IDS,
  type Harness,
  type HarnessId,
  harnessById,
} from "./harnesses.js";
import { type Connection, checkConnection, revokeConnection, signIn } from "./signin.js";
import { installedSkillVersion, planSkills, removeSkillDir, writeSkill } from "./skill.js";
import {
  deleteState,
  emptyState,
  type HarnessRecord,
  readState,
  recordedServer,
  type State,
  statePath,
  writeState,
} from "./state.js";

export interface InstallOptions {
  server?: string;
  only?: readonly HarnessId[];
  yes: boolean;
}

function message(error: unknown): string {
  return error instanceof InstallerError ? error.message : "an unexpected error occurred";
}

/** Normalizes a server URL to an origin plus optional path, without a trailing slash. */
export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InstallerError(
      `--server must be an http or https URL, not ${JSON.stringify(value)}.`,
      2,
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new InstallerError(
      `--server must be an http or https URL without credentials, query, or fragment.`,
      2,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function serverOfEntry(entry: McpEntry): string | undefined {
  return entry.url?.endsWith("/mcp") ? entry.url.slice(0, -"/mcp".length) : undefined;
}

async function select(
  ctx: Context,
  detected: Detection[],
  options: InstallOptions,
): Promise<Harness[]> {
  let candidates = detected;
  if (options.only) {
    const only = options.only;
    for (const id of only) {
      if (!detected.some((d) => d.harness.id === id)) {
        ctx.io.out(`${harnessById(ctx, id).displayName}: not detected on this machine; skipped.`);
      }
    }
    candidates = detected.filter((d) => only.includes(d.harness.id));
  }
  if (candidates.length === 0) return [];
  ctx.io.out("Detected harnesses:");
  candidates.forEach((d, index) => {
    ctx.io.out(`  ${index + 1}. [x] ${d.harness.displayName} (${d.via})`);
  });
  // AC-9.1: every detected harness is selected unless the user deselects it.
  if (options.yes || options.only || !ctx.io.prompt) {
    if (!options.yes && !options.only) {
      ctx.io.out(
        "No terminal is attached, so every detected harness is selected. Use --only to choose.",
      );
    }
    return candidates.map((d) => d.harness);
  }
  const answer = await ctx.io.prompt(
    "Press Enter to install for all of them, or type the numbers to leave out (for example: 2 3): ",
  );
  const leaveOut = new Set<number>();
  for (const part of answer.split(/[\s,]+/).filter((p) => p.length > 0)) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
      throw new InstallerError(`${JSON.stringify(part)} is not one of the listed numbers.`, 2);
    }
    leaveOut.add(index);
  }
  return candidates.filter((_, index) => !leaveOut.has(index + 1)).map((d) => d.harness);
}

/**
 * Applies the skill rule to `harnesses`, writes each folder at the current
 * version, and updates their records. Returns failure lines.
 */
function installSkills(ctx: Context, harnesses: readonly Harness[], state: State): string[] {
  const failures: string[] = [];
  for (const plan of planSkills(ctx, harnesses)) {
    const { harness } = plan;
    const record: HarnessRecord = state.harnesses[harness.id] ?? {};
    if (plan.dir) {
      try {
        writeSkill(plan.dir, ctx.skill.content);
        record.skillPath = plan.dir;
        record.skillVersion = ctx.skill.version;
        ctx.io.out(`${harness.displayName}: skill ${ctx.skill.version} written to ${plan.dir}`);
      } catch (error) {
        failures.push(`${harness.displayName}: the skill was not written: ${message(error)}`);
      }
    } else {
      // A folder this installation owned earlier is no longer wanted.
      if (record.skillPath && resolve(record.skillPath) === harness.skillDir(ctx)) {
        try {
          removeSkillDir(record.skillPath);
          ctx.io.out(`${harness.displayName}: removed its own skill folder ${record.skillPath}`);
          delete record.skillPath;
          delete record.skillVersion;
        } catch (error) {
          failures.push(`${harness.displayName}: ${message(error)}`);
        }
      }
      if (plan.reason === "unsupported") {
        ctx.io.out(`${harness.displayName}: does not support skills, so no skill was installed.`);
      } else {
        ctx.io.out(
          `${harness.displayName}: loads the AgentDesk skill from the Claude Code or Codex skill folder.`,
        );
      }
    }
    state.harnesses[harness.id] = record;
  }
  return failures;
}

/** `agentdesk install` (component-installer §Commands; REQ-9). */
export async function install(ctx: Context, options: InstallOptions): Promise<number> {
  const previous = readState(ctx) ?? emptyState();
  const requested = options.server !== undefined ? normalizeServer(options.server) : undefined;
  const server = requested ?? previous.server ?? ctx.defaultServer;
  if (!server) {
    throw new InstallerError("This build has no default AgentDesk server. Pass --server <url>.", 2);
  }

  const detected = detectHarnesses(ctx);
  if (detected.length === 0) {
    throw new InstallerError(
      "No supported harness was found. Install Claude Code, Codex, or Cursor first.",
    );
  }
  const selected = await select(ctx, detected, options);
  if (selected.length === 0) {
    ctx.io.out("No harness selected. Nothing was installed.");
    return 0;
  }
  ctx.io.out(`AgentDesk server: ${server}`);

  // AC-9.4: a working connection at this server is kept unchanged.
  const oldEntries = new Map<HarnessId, McpEntry>();
  const kept = new Set<HarnessId>();
  const needSignIn: Harness[] = [];
  for (const harness of selected) {
    const entry = readMcpEntry(ctx, harness);
    if (entry.token) ctx.secrets.add(entry.token);
    oldEntries.set(harness.id, entry);
    const record = previous.harnesses[harness.id];
    if (
      record?.connectionId &&
      recordedServer(previous, harness.id) === server &&
      entry.token &&
      entry.url === mcpUrl(server)
    ) {
      const check = await checkConnection(ctx, server, entry.token);
      if (check.kind === "ok") {
        kept.add(harness.id);
        ctx.io.out(`${harness.displayName}: connection works; keeping it.`);
        continue;
      }
      ctx.io.out(
        `${harness.displayName}: connection check ${check.kind === "refused" ? "was refused" : `failed (${check.detail})`}; signing in again.`,
      );
    }
    needSignIn.push(harness);
  }

  let connections: Connection[] = [];
  if (needSignIn.length > 0) {
    ctx.io.out(`Signing in ${needSignIn.map((h) => h.displayName).join(", ")}.`);
    connections = await signIn(
      ctx,
      server,
      needSignIn.map((h) => h.id),
    );
  } else {
    ctx.io.out("Every selected harness is already connected. No sign-in is needed.");
  }

  const state: State = {
    version: 1,
    server,
    harnesses: { ...previous.harnesses },
  };
  for (const id of kept) {
    state.harnesses[id] = { ...state.harnesses[id], server };
  }

  const backups = new BackupRegistry();
  const failures: string[] = [];
  for (const connection of connections) {
    const harness = harnessById(ctx, connection.harness);
    const file = harness.configPath(ctx);
    try {
      await writeMcpEntry(ctx, harness, server, connection.token, backups);
    } catch (error) {
      failures.push(
        `${harness.displayName}: its MCP entry in ${file} was not written: ${message(error)}`,
      );
      const undo = await revokeConnection(ctx, server, connection.token);
      if (undo.kind === "failed") {
        failures.push(`${harness.displayName}: revoke the unused connection in the AgentDesk app.`);
      }
      continue;
    }
    state.harnesses[harness.id] = {
      ...state.harnesses[harness.id],
      server,
      connectionId: connection.connectionId,
      configPath: file,
    };
    ctx.io.out(`${harness.displayName}: connected; MCP entry written to ${file}`);

    // A replaced token is revoked so it does not stay valid unused.
    const old = oldEntries.get(harness.id);
    const oldServer = old ? serverOfEntry(old) : undefined;
    if (old?.token && oldServer && old.token !== connection.token) {
      const result = await revokeConnection(ctx, oldServer, old.token);
      if (result.kind === "failed") {
        ctx.io.err(
          `${harness.displayName}: the previous connection could not be revoked (${result.detail}). Revoke it in the AgentDesk app.`,
        );
      }
    }
  }

  // AC-9.4: every run rewrites the skill at the current version.
  failures.push(...installSkills(ctx, selected, state));
  writeState(ctx, state);

  if (failures.length > 0) {
    for (const line of failures) ctx.io.err(line);
    return 1;
  }
  ctx.io.out("AgentDesk is installed. A new agent session can call ask now.");
  return 0;
}

/** `agentdesk skill install`: the skill only, for every detected harness (REQ-3). */
export async function skillInstall(ctx: Context): Promise<number> {
  const state = readState(ctx) ?? emptyState();
  const detected = detectHarnesses(ctx);
  if (detected.length === 0) {
    throw new InstallerError(
      "No supported harness was found. Install Claude Code, Codex, or Cursor first.",
    );
  }
  const failures = installSkills(
    ctx,
    detected.map((d) => d.harness),
    state,
  );
  writeState(ctx, state);
  for (const line of failures) ctx.io.err(line);
  return failures.length > 0 ? 1 : 0;
}

/** `agentdesk status`: each recorded harness, its connection check, and its skill version. */
export async function status(ctx: Context): Promise<number> {
  const state = readState(ctx);
  const ids = HARNESS_IDS.filter((id) => state?.harnesses[id]);
  if (!state || ids.length === 0) {
    ctx.io.out("AgentDesk is not installed on this machine. Run: agentdesk install");
    return 0;
  }
  ctx.io.out(`AgentDesk server: ${state.server ?? "none recorded"}`);
  for (const id of ids) {
    const harness = harnessById(ctx, id);
    const record = state.harnesses[id] as HarnessRecord;
    let connection: string;
    if (!record.connectionId) {
      connection = "no connection recorded";
    } else {
      const entry = readMcpEntry(ctx, harness);
      const server = recordedServer(state, id) ?? serverOfEntry(entry);
      if (!entry.token || !server) {
        connection = `not connected (no AgentDesk entry in ${harness.configPath(ctx)})`;
      } else {
        const check = await checkConnection(ctx, server, entry.token);
        connection =
          check.kind === "ok"
            ? "connected"
            : check.kind === "refused"
              ? "not connected (the server refused its token)"
              : `connection check failed (${check.detail})`;
      }
    }
    let skill: string;
    if (record.skillPath) {
      const version = installedSkillVersion(record.skillPath);
      skill = version
        ? `skill ${version} at ${record.skillPath}`
        : `skill missing from ${record.skillPath}`;
    } else if (id === "cursor" && harness.supportsSkills) {
      skill = "skill loaded from the Claude Code or Codex folder";
    } else {
      skill = "no skill installed";
    }
    ctx.io.out(`${harness.displayName}: ${connection}; ${skill}`);
  }
  return 0;
}

/** `agentdesk uninstall`: revoke, remove, and forget what the state records (AC-9.6). */
export async function uninstall(ctx: Context): Promise<number> {
  const state = readState(ctx);
  if (!state) {
    ctx.io.out(`Nothing to uninstall: ${statePath(ctx)} does not exist.`);
    return 0;
  }
  const backups = new BackupRegistry();
  const failures: string[] = [];
  for (const id of HARNESS_IDS) {
    const record = state.harnesses[id];
    if (!record) continue;
    const harness = harnessById(ctx, id);
    const configPath = harness.configPath(ctx);
    const skillDir = harness.skillDir(ctx);
    // Only the installer's own locations are ever edited or removed.
    if (record.configPath && resolve(record.configPath) !== configPath) {
      failures.push(
        `${harness.displayName}: the recorded configuration path ${record.configPath} is not ${configPath}; nothing was changed for it.`,
      );
      continue;
    }
    if (record.skillPath && resolve(record.skillPath) !== skillDir) {
      failures.push(
        `${harness.displayName}: the recorded skill path ${record.skillPath} is not ${skillDir}; nothing was changed for it.`,
      );
      continue;
    }

    if (record.connectionId || record.configPath) {
      const entry = readMcpEntry(ctx, harness);
      if (entry.token) {
        const server = recordedServer(state, id) ?? serverOfEntry(entry);
        const result = server
          ? await revokeConnection(ctx, server, entry.token)
          : ({ kind: "failed", detail: "no server is recorded" } as const);
        if (result.kind === "failed") {
          failures.push(
            `${harness.displayName}: its connection could not be revoked (${result.detail}). Its entry and skill were kept; run agentdesk uninstall again.`,
          );
          continue;
        }
        ctx.io.out(`${harness.displayName}: connection revoked.`);
      }
      try {
        if (await removeMcpEntry(ctx, harness, backups)) {
          ctx.io.out(`${harness.displayName}: MCP entry removed from ${configPath}`);
        }
      } catch (error) {
        failures.push(
          `${harness.displayName}: its MCP entry in ${configPath} was not removed: ${message(error)}`,
        );
        continue;
      }
      delete record.connectionId;
      delete record.configPath;
      delete record.server;
    }

    if (record.skillPath) {
      try {
        if (removeSkillDir(record.skillPath)) {
          ctx.io.out(`${harness.displayName}: skill folder removed: ${record.skillPath}`);
        }
      } catch (error) {
        failures.push(`${harness.displayName}: ${message(error)}`);
        continue;
      }
      delete record.skillPath;
      delete record.skillVersion;
    }
    delete state.harnesses[id];
  }

  if (Object.keys(state.harnesses).length === 0) {
    deleteState(ctx);
    ctx.io.out(`Removed ${statePath(ctx)}`);
  } else {
    writeState(ctx, state);
  }
  if (failures.length > 0) {
    for (const line of failures) ctx.io.err(line);
    return 1;
  }
  ctx.io.out("AgentDesk was uninstalled.");
  return 0;
}
