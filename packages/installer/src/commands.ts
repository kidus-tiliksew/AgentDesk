import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  findListedHook,
  type HookList,
  listCodexHooks,
  parseHookKey,
  trustStep,
} from "./codex-trust.js";
import {
  applyCodexTrust,
  BackupRegistry,
  type McpEntry,
  mcpUrl,
  readMcpEntry,
  removeMcpEntry,
  writeFileAtomic,
  writeMcpEntry,
} from "./config.js";
import { type Context, InstallerError, TerminalReadError } from "./context.js";
import {
  type Detection,
  detectHarnesses,
  HARNESS_IDS,
  type Harness,
  type HarnessId,
  harnessById,
  isHarnessId,
} from "./harnesses.js";
import {
  checkHookFile,
  currentHookCommand,
  findHooks,
  type HookEvent,
  type HookEventId,
  hookEvent,
  hookEvents,
  planHookRemoval,
  writeHooks,
} from "./hooks.js";
import {
  type Connection,
  checkConnection,
  InvalidSignInResult,
  type ReportedConnection,
  revokeConnection,
  signIn,
} from "./signin.js";
import { installedSkillVersion, planSkills, removeSkillDir, writeSkill } from "./skill.js";
import {
  deleteState,
  emptyState,
  type HarnessRecord,
  HOOK_PATH_FIELDS,
  readState,
  recordedHookEvents,
  recordedServer,
  recordUnrevoked,
  type State,
  stateIsEmpty,
  statePath,
  TRUST_KEY_FIELDS,
  type UnrevokedConnection,
  writeState,
} from "./state.js";

/** Printed when the harness selection prompt cannot read the terminal (component-installer §Commands). */
export const TERMINAL_UNREADABLE_SELECTION =
  "The terminal could not be read, so every detected harness is kept. Use --only to choose.";

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
  let answer: string;
  try {
    answer = await ctx.io.prompt(
      "Press Enter to install for all of them, or type the numbers to leave out (for example: 2 3): ",
    );
  } catch (error) {
    if (!(error instanceof TerminalReadError)) throw error;
    ctx.io.out(TERMINAL_UNREADABLE_SELECTION);
    return candidates.map((d) => d.harness);
  }
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
        record.skillRealPath = writeSkill(plan.dir, ctx.skill.content);
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
          ctx.io.out(`${harness.displayName}: removing its own skill folder ${record.skillPath}`);
          removeSkillDir(record.skillPath, harness.skillAnchor(ctx), record.skillRealPath);
          delete record.skillPath;
          delete record.skillRealPath;
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

/** The Codex hooks whose trust the installer records, with the record field of each key. */
function trustedEvents(
  events: readonly HookEvent[],
): (HookEvent & { id: keyof typeof TRUST_KEY_FIELDS })[] {
  return events.filter(
    (event): event is HookEvent & { id: keyof typeof TRUST_KEY_FIELDS } =>
      event.id in TRUST_KEY_FIELDS,
  );
}

/**
 * Records trust for each Codex hook in `commands`, under the key and hash
 * `hooks/list` reports for it (component-installer §Codex trust). App-server
 * is asked once for every hook, and config.toml gets one edit that sets each
 * reported key and removes each recorded key that changed. A hook app-server
 * cannot report gets the `/hooks` step for that hook and does not fail the
 * run (AC-10.3). Returns failure lines.
 */
async function trustCodexHooks(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
  events: readonly HookEvent[],
  commands: ReadonlyMap<HookEventId, string>,
  backups: BackupRegistry,
): Promise<string[]> {
  const list = await listCodexHooks(ctx);
  const configPath = harness.configPath(ctx);
  const reported: {
    event: (typeof events)[number] & { id: keyof typeof TRUST_KEY_FIELDS };
    key: string;
  }[] = [];
  const trust = new Map<string, string>();
  const replaced: string[] = [];
  for (const event of trustedEvents(events)) {
    const hook = findListedHook(list, commands.get(event.id) as string);
    if (!hook) {
      const reason =
        list.kind === "unavailable"
          ? list.reason
          : `codex does not list the AgentDesk ${event.label}`;
      ctx.io.out(
        `${harness.displayName}: the AgentDesk ${event.label} is not trusted yet (${reason}). ${trustStep(event.label)}`,
      );
      continue;
    }
    const recorded = record[TRUST_KEY_FIELDS[event.id]];
    if (recorded !== undefined && recorded !== hook.key) replaced.push(recorded);
    trust.set(hook.key, hook.currentHash);
    reported.push({ event, key: hook.key });
  }
  if (reported.length === 0) return [];
  try {
    applyCodexTrust(configPath, trust, replaced, backups);
  } catch (error) {
    return reported.map(
      ({ event }) =>
        `${harness.displayName}: the AgentDesk ${event.label}'s trust was not recorded: ${message(error)} ${trustStep(event.label)}`,
    );
  }
  for (const { event, key } of reported) {
    record[TRUST_KEY_FIELDS[event.id]] = key;
    ctx.io.out(
      `${harness.displayName}: trust for the AgentDesk ${event.label} recorded in ${configPath}`,
    );
  }
  return [];
}

/**
 * Writes or refreshes each harness's session-start hook and resume hooks and,
 * for Codex, their trust, and records them (component-installer §Standing
 * guidance and §Resume hooks; AC-9.4, AC-9.9). Returns failure lines.
 */
async function installGuidance(
  ctx: Context,
  harnesses: readonly Harness[],
  state: State,
  backups: BackupRegistry,
): Promise<string[]> {
  const failures: string[] = [];
  for (const harness of harnesses) {
    const record: HarnessRecord = state.harnesses[harness.id] ?? {};
    state.harnesses[harness.id] = record;
    const file = harness.hookPath(ctx);
    const events = hookEvents(harness);
    const commands = new Map(
      events.map((event) => [event.id, currentHookCommand(ctx, harness.id, event.id)]),
    );
    try {
      writeHooks(ctx, harness, (event) => commands.get(event.id) as string, backups);
    } catch (error) {
      failures.push(
        `${harness.displayName}: its hooks in ${file} were not written: ${message(error)}`,
      );
      continue;
    }
    for (const event of events) {
      record[HOOK_PATH_FIELDS[event.id]] = file;
      ctx.io.out(`${harness.displayName}: ${event.label} written to ${file}`);
    }
    if (harness.id === "codex") {
      failures.push(...(await trustCodexHooks(ctx, harness, record, events, commands, backups)));
    }
  }
  return failures;
}

/**
 * Carries trust to Codex hooks whose keys a removal changed: each hook that
 * was trusted before and still has the same hash at its new key, in the same
 * event, gets a `hooks.state` table for that key (component-installer §State,
 * re-run, and uninstall). Returns undefined when app-server could not report
 * both lists.
 */
async function carriedTrust(
  ctx: Context,
  before: HookList,
  file: string,
  moved: ReadonlyMap<string, string>,
): Promise<Map<string, string> | undefined> {
  if (before.kind !== "listed") return undefined;
  const after = await listCodexHooks(ctx);
  if (after.kind !== "listed") return undefined;
  const carried = new Map<string, string>();
  for (const hook of before.hooks) {
    const parsed = parseHookKey(hook.key);
    const target =
      parsed && parsed.file === file ? moved.get(`${parsed.event}:${parsed.position}`) : undefined;
    if (hook.source !== "user" || hook.trustStatus !== "trusted" || !target || !hook.currentHash) {
      continue;
    }
    // `target` is `<event>:<group>:<handler>`, so the new key keeps the event.
    const newKey = `${file}:${target}`;
    const now = after.hooks.find((h) => h.key === newKey);
    if (now?.source === "user" && now.currentHash === hook.currentHash) {
      carried.set(newKey, hook.currentHash);
    }
  }
  return carried;
}

/** The `hooks.state` keys a record holds for its Codex hooks. */
function recordedTrustKeys(record: HarnessRecord): string[] {
  return Object.values(TRUST_KEY_FIELDS)
    .map((field) => record[field])
    .filter((key): key is string => key !== undefined);
}

/**
 * Removes the installer's recorded hooks, each group that then holds no other
 * hook, and for Codex the recorded `hooks.state` tables, carrying trust to the
 * later hooks the removal re-keys in either event. Throws when something may
 * remain. When the Codex trust edit fails, the hook file is restored as it
 * was, so a later uninstall finds the installer's hooks again and repeats the
 * trust carry.
 */
async function removeGuidance(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
  backups: BackupRegistry,
): Promise<void> {
  const file = harness.hookPath(ctx);
  const events = recordedHookEvents(harness.id, record).map((id) => hookEvent(harness, id));
  let carried = new Map<string, string>();
  const removal = events.length > 0 ? planHookRemoval(ctx, harness, events) : undefined;
  if (removal) {
    const codexMoves = harness.id === "codex" && removal.moved.size > 0;
    const keyFile = codexMoves ? realpathSync(file) : file;
    const before = codexMoves ? await listCodexHooks(ctx) : undefined;
    for (const event of events) {
      if (removal.removed.includes(event.id)) {
        ctx.io.out(`${harness.displayName}: removing the ${event.label} from ${file}`);
      }
    }
    backups.backupOnce(file);
    writeFileAtomic(file, removal.text);
    if (before) {
      const carry = await carriedTrust(ctx, before, keyFile, removal.moved);
      if (carry) carried = carry;
      else {
        ctx.io.out(
          `${harness.displayName}: hooks listed after AgentDesk's in ${file} may need trusting again. In Codex, run /hooks and trust them.`,
        );
      }
    }
  }
  const recordedKeys = recordedTrustKeys(record);
  if (harness.id !== "codex" || (recordedKeys.length === 0 && carried.size === 0)) {
    return;
  }
  const configPath = harness.configPath(ctx);
  ctx.io.out(`${harness.displayName}: removing the AgentDesk hooks' trust from ${configPath}`);
  try {
    applyCodexTrust(configPath, carried, recordedKeys, backups);
  } catch (error) {
    if (removal) {
      try {
        writeFileAtomic(file, removal.original);
      } catch {
        throw new InstallerError(
          `${message(error)} ${file} could not be restored either; hooks listed after AgentDesk's in it may need trusting again in Codex's /hooks.`,
        );
      }
      ctx.io.out(`${harness.displayName}: restored ${file}, because its trust was not updated.`);
    }
    throw error;
  }
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
    // A hook file the run would refuse stops it before a code is requested.
    checkHookFile(ctx, harness);
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
    try {
      connections = await signIn(
        ctx,
        server,
        needSignIn.map((h) => h.id),
      );
    } catch (error) {
      if (error instanceof InvalidSignInResult) {
        await recoverReported(ctx, previous, server, error.reported);
      }
      throw error;
    }
  } else {
    ctx.io.out("Every selected harness is already connected. No sign-in is needed.");
  }

  const state: State = {
    version: 1,
    server,
    harnesses: { ...previous.harnesses },
    unrevoked: [...previous.unrevoked],
  };
  for (const id of kept) {
    state.harnesses[id] = { ...state.harnesses[id], server };
  }

  const backups = new BackupRegistry();
  const failures: string[] = [];
  // Connections this run could not revoke; each is kept as a recovery record.
  const unresolved: UnrevokedConnection[] = [];
  const keepUnrevoked = (record: UnrevokedConnection) => {
    recordUnrevoked(state, record);
    unresolved.push(record);
  };

  for (const connection of connections) {
    const harness = harnessById(ctx, connection.harness);
    const file = harness.configPath(ctx);
    try {
      await writeMcpEntry(ctx, harness, server, connection.token, backups);
    } catch (error) {
      failures.push(
        `${harness.displayName}: its MCP entry in ${file} was not written: ${message(error)}`,
      );
      // The new connection is unused; revoke it, or keep it recorded.
      const undo = await revokeConnection(ctx, server, connection.token);
      if (undo.kind === "failed") {
        keepUnrevoked({
          harness: harness.id,
          connectionId: connection.connectionId,
          server,
          reason: `its configuration was not written and revocation failed: ${undo.detail}`,
        });
      }
      continue;
    }
    ctx.io.out(`${harness.displayName}: connected; MCP entry written to ${file}`);

    // The connection this one replaces is revoked, or kept as a recovery record.
    const prior = previous.harnesses[harness.id];
    const old = oldEntries.get(harness.id);
    const oldServer = old ? serverOfEntry(old) : undefined;
    const priorServer = recordedServer(previous, harness.id) ?? oldServer ?? server;
    if (prior?.connectionId && prior.connectionId !== connection.connectionId) {
      if (old?.token && old.token !== connection.token) {
        const result = await revokeConnection(ctx, oldServer ?? priorServer, old.token);
        if (result.kind === "failed") {
          keepUnrevoked({
            harness: harness.id,
            connectionId: prior.connectionId,
            server: priorServer,
            reason: `revocation failed: ${result.detail}`,
          });
        }
      } else {
        keepUnrevoked({
          harness: harness.id,
          connectionId: prior.connectionId,
          server: priorServer,
          reason: `no token for it was in ${file}`,
        });
      }
    } else if (old?.token && oldServer && old.token !== connection.token) {
      // An entry no state recorded, so no connection id is known for it.
      const result = await revokeConnection(ctx, oldServer, old.token);
      if (result.kind === "failed") {
        failures.push(
          `${harness.displayName}: the AgentDesk entry it replaced could not be revoked (${result.detail}), and no connection id was recorded for it. Revoke it in the AgentDesk app under Settings → Connections.`,
        );
      }
    }
    state.harnesses[harness.id] = {
      ...state.harnesses[harness.id],
      server,
      connectionId: connection.connectionId,
      configPath: file,
    };
  }

  // AC-9.4: every run rewrites the skill, the hook, and Codex trust.
  failures.push(...installSkills(ctx, selected, state));
  failures.push(...(await installGuidance(ctx, selected, state, backups)));
  writeState(ctx, state);

  for (const record of unresolved) failures.push(unrevokedLine(ctx, record, "forget"));
  const earlier = state.unrevoked.filter((u) => !unresolved.includes(u));
  for (const record of earlier) ctx.io.err(unrevokedLine(ctx, record, "forget"));
  if (failures.length > 0) {
    for (const line of failures) ctx.io.err(line);
    return 1;
  }
  ctx.io.out(NEW_SESSION);
  return 0;
}

/**
 * Handles connections a rejected approved result reported: each is revoked
 * with its token, or kept as a recovery record when that fails or no token
 * was given, so a connection the server issued is never forgotten.
 */
async function recoverReported(
  ctx: Context,
  previous: State,
  server: string,
  reported: ReportedConnection[],
): Promise<void> {
  const state: State = {
    ...previous,
    harnesses: { ...previous.harnesses },
    unrevoked: [...previous.unrevoked],
  };
  for (const item of reported) {
    if (item.token) {
      const result = await revokeConnection(ctx, server, item.token);
      if (result.kind === "revoked") continue;
    }
    if (!item.connectionId) continue;
    const record: UnrevokedConnection = {
      harness: item.harness && isHarnessId(item.harness) ? item.harness : "unknown",
      connectionId: item.connectionId,
      server,
      reason: "the server returned an invalid sign-in result",
    };
    recordUnrevoked(state, record);
    ctx.io.err(unrevokedLine(ctx, record, "forget"));
  }
  if (state.unrevoked.length > previous.unrevoked.length) writeState(ctx, state);
}

/**
 * Describes a connection whose revocation is not established and the step
 * that resolves it: `forget` names `agentdesk forget <id>`, which keeps the
 * installation; `uninstall` names `agentdesk uninstall --forget-unrevoked`.
 */
export function unrevokedLine(
  ctx: Context,
  record: UnrevokedConnection,
  next: "forget" | "uninstall",
): string {
  const command =
    next === "forget"
      ? `agentdesk forget ${record.connectionId}`
      : `agentdesk uninstall ${FORGET_UNREVOKED_FLAG}`;
  return `${displayNameOf(ctx, record.harness)}: connection ${record.connectionId} at ${record.server} is not revoked (${record.reason}). Revoke it in the AgentDesk app under Settings → Connections, then run: ${command}`;
}

function displayNameOf(ctx: Context, harness: HarnessId | "unknown"): string {
  return harness === "unknown" ? "Unknown harness" : harnessById(ctx, harness).displayName;
}

/** `agentdesk forget <connection-id>`: drop one recovery record after manual revocation. */
export async function forget(ctx: Context, connectionId: string): Promise<number> {
  const state = readState(ctx);
  const record = state?.unrevoked.find((u) => u.connectionId === connectionId);
  if (!state || !record) {
    throw new InstallerError(`No unrevoked connection ${connectionId} is recorded.`);
  }
  state.unrevoked = state.unrevoked.filter((u) => u !== record);
  ctx.io.out(
    `${displayNameOf(ctx, record.harness)}: Forgot connection ${record.connectionId} at ${record.server}. Make sure it is revoked in the AgentDesk app under Settings → Connections.`,
  );
  if (stateIsEmpty(state)) deleteState(ctx);
  else writeState(ctx, state);
  return 0;
}

/** A session already running has not run the hook (component-installer §Commands). */
const NEW_SESSION =
  "AgentDesk is installed. Start a new agent session: a session that is already running has not loaded the AgentDesk guidance.";

/**
 * `agentdesk skill install`: the skill, the session-start hook, and the resume
 * hooks, with Codex trust, for every detected harness (REQ-3).
 */
export async function skillInstall(ctx: Context): Promise<number> {
  const state = readState(ctx) ?? emptyState();
  const detected = detectHarnesses(ctx);
  if (detected.length === 0) {
    throw new InstallerError(
      "No supported harness was found. Install Claude Code, Codex, or Cursor first.",
    );
  }
  const harnesses = detected.map((d) => d.harness);
  for (const harness of harnesses) checkHookFile(ctx, harness);
  const failures = installSkills(ctx, harnesses, state);
  failures.push(...(await installGuidance(ctx, harnesses, state, new BackupRegistry())));
  writeState(ctx, state);
  for (const line of failures) ctx.io.err(line);
  if (failures.length > 0) return 1;
  ctx.io.out(
    "Start a new agent session: a session that is already running has not loaded the updated skill and guidance.",
  );
  return 0;
}

/**
 * Describes each recorded hook: whether its file holds the installer's hook
 * and, for Codex, the trust `hooks/list` reports for it (component-installer
 * §State, re-run, and uninstall). Returns undefined when no hook is recorded.
 */
async function hookStatus(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
): Promise<string | undefined> {
  const events = recordedHookEvents(harness.id, record).map((id) => hookEvent(harness, id));
  if (events.length === 0) return undefined;
  const file = harness.hookPath(ctx);
  let found: ReturnType<typeof findHooks>;
  try {
    found = findHooks(ctx, harness, events);
  } catch (error) {
    return `hook file unreadable (${message(error)})`;
  }
  let list: HookList | undefined;
  const parts: string[] = [];
  for (const event of events) {
    const lookup = found.get(event.id) ?? { kind: "missing" };
    if (lookup.kind === "missing") {
      parts.push(`no AgentDesk ${event.label} in ${record[HOOK_PATH_FIELDS[event.id]] ?? file}`);
    } else if (lookup.kind === "unreadable") {
      parts.push(`${event.label} unreadable (${lookup.reason})`);
    } else if (harness.id !== "codex" || event.keyName === undefined) {
      parts.push(`${event.label} in ${file}`);
    } else {
      list ??= await listCodexHooks(ctx);
      const hook = findListedHook(list, lookup.command);
      parts.push(
        hook?.trustStatus
          ? `${event.label} in ${file}, trust ${hook.trustStatus}`
          : `${event.label} in ${file}, trust could not be checked; confirm it in Codex's /hooks`,
      );
    }
  }
  return parts.join("; ");
}

/**
 * `agentdesk status`: each recorded harness, its connection check, its skill
 * version, and its session-start and resume hooks with Codex trust.
 */
export async function status(ctx: Context): Promise<number> {
  const state = readState(ctx);
  const ids = HARNESS_IDS.filter((id) => state?.harnesses[id]);
  if (!state || (ids.length === 0 && state.unrevoked.length === 0)) {
    ctx.io.out("AgentDesk is not installed on this machine. Run: agentdesk install");
    return 0;
  }
  ctx.io.out(`AgentDesk server: ${state.server ?? "none recorded"}`);
  // Connections whose revocation is not established are always listed.
  for (const record of state.unrevoked) ctx.io.out(unrevokedLine(ctx, record, "forget"));
  for (const id of ids) {
    const harness = harnessById(ctx, id);
    const record = state.harnesses[id] as HarnessRecord;
    let connection: string;
    if (!record.connectionId) {
      connection = "no connection recorded";
    } else {
      let entry: McpEntry | undefined;
      let readError: string | undefined;
      try {
        entry = readMcpEntry(ctx, harness);
      } catch (error) {
        readError = message(error);
      }
      const server = recordedServer(state, id) ?? (entry ? serverOfEntry(entry) : undefined);
      if (readError !== undefined) {
        connection = `configuration unreadable (${readError})`;
      } else if (!entry?.token || !server) {
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
    const hooks = await hookStatus(ctx, harness, record);
    ctx.io.out(`${harness.displayName}: ${connection}; ${skill}${hooks ? `; ${hooks}` : ""}`);
  }
  return 0;
}

export interface UninstallOptions {
  /**
   * Forget a recorded connection that cannot be revoked because its harness
   * configuration holds no token, after the person revoked it in the app.
   */
  forgetUnrevoked: boolean;
}

export const FORGET_UNREVOKED_FLAG = "--forget-unrevoked";

/** `agentdesk uninstall`: revoke, remove, and forget what the state records (AC-9.6). */
export async function uninstall(
  ctx: Context,
  options: UninstallOptions = { forgetUnrevoked: false },
): Promise<number> {
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
    const hookPath = harness.hookPath(ctx);
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
    const strayHook = Object.values(HOOK_PATH_FIELDS)
      .map((field) => record[field])
      .find((path) => path !== undefined && resolve(path) !== hookPath);
    if (strayHook !== undefined) {
      failures.push(
        `${harness.displayName}: the recorded hook path ${strayHook} is not ${hookPath}; nothing was changed for it.`,
      );
      continue;
    }

    // The MCP entry, read before anything changes; set when the record holds a connection.
    let entry: McpEntry | undefined;
    if (record.connectionId || record.configPath) {
      // An unreadable or malformed configuration is not proof the entry is
      // gone: keep the record so a later run can revoke and remove it.
      try {
        entry = readMcpEntry(ctx, harness);
      } catch (error) {
        failures.push(
          `${harness.displayName}: ${message(error)} Its connection was not revoked and its record was kept; fix the file, then run agentdesk uninstall again.`,
        );
        continue;
      }
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
      } else if (record.connectionId) {
        // A missing local token is not proof the server revoked the
        // connection: it becomes a recovery record, listed below.
        recordUnrevoked(state, {
          harness: id,
          connectionId: record.connectionId,
          server: recordedServer(state, id) ?? serverOfEntry(entry) ?? "the recorded server",
          reason: `no token for it was in ${configPath}`,
        });
      }
    }

    // The hooks go before the MCP entry, so the Codex trust tables appended
    // after the MCP table leave config.toml as it was before install.
    if (recordedHookEvents(id, record).length > 0 || recordedTrustKeys(record).length > 0) {
      try {
        await removeGuidance(ctx, harness, record, backups);
      } catch (error) {
        failures.push(`${harness.displayName}: its hooks were not removed: ${message(error)}`);
        continue;
      }
      for (const field of Object.values(HOOK_PATH_FIELDS)) delete record[field];
      for (const field of Object.values(TRUST_KEY_FIELDS)) delete record[field];
    }

    if (entry) {
      try {
        if (entry.present) {
          ctx.io.out(`${harness.displayName}: removing the MCP entry from ${configPath}`);
          await removeMcpEntry(ctx, harness, backups);
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
        ctx.io.out(`${harness.displayName}: removing the skill folder ${record.skillPath}`);
        removeSkillDir(record.skillPath, harness.skillAnchor(ctx), record.skillRealPath);
      } catch (error) {
        failures.push(`${harness.displayName}: ${message(error)}`);
        continue;
      }
      delete record.skillPath;
      delete record.skillRealPath;
      delete record.skillVersion;
    }
    delete state.harnesses[id];
  }

  // Recovery records leave the state only on the person's explicit request.
  if (options.forgetUnrevoked) {
    for (const record of state.unrevoked) {
      ctx.io.out(
        `${displayNameOf(ctx, record.harness)}: Forgot connection ${record.connectionId} at ${record.server} without revoking it, as ${FORGET_UNREVOKED_FLAG} asked. Make sure it is revoked in the AgentDesk app under Settings → Connections.`,
      );
    }
    state.unrevoked = [];
  } else {
    for (const record of state.unrevoked) failures.push(unrevokedLine(ctx, record, "uninstall"));
  }

  if (stateIsEmpty(state)) {
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
