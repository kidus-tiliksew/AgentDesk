import { lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
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
  assertConfinedFile,
  type Detection,
  detectHarnesses,
  discoverT3Profiles,
  HARNESS_IDS,
  type Harness,
  type HarnessId,
  harnessById,
  isConfined,
  isHarnessId,
  probeConfined,
  recordedT3ConfigDir,
  T3_HOOK_FILE,
  T3_MCP_FILE,
  t3ProfilesDir,
  t3ProfileTarget,
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
import { enroll, readInstallKey, STDIN_PATH } from "./install-key.js";
import { resumeDir } from "./resume/storage.js";
import {
  type Connection,
  checkConnection,
  connectionIdFor,
  InvalidSignInResult,
  revokeConnection,
  signIn,
} from "./signin.js";
import {
  assertOwnedDir,
  installedSkillVersion,
  planSkills,
  refuseLink,
  removeSkillDir,
  SKILL_FILE,
  skillFileText,
  writeSkill,
} from "./skill.js";
import {
  deleteState,
  type ExtraPathField,
  emptyState,
  type HarnessRecord,
  HOOK_PATH_FIELDS,
  readState,
  recordedHookEvents,
  recordedServer,
  recordUnrevoked,
  type State,
  setExtraPaths,
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
  /** Connect with the install key in this file, or on standard input for `-`. */
  keyFile?: string;
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
        // The folder and its SKILL.md, with the temporary file beside it, are
        // checked for a link before the content is read or written; a re-run
        // names Antigravity's skill unchanged when its bytes match.
        refuseLink(plan.dir);
        assertConfinedFile(ctx, harness, join(plan.dir, SKILL_FILE));
        const unchanged =
          harness.hookFormat === "named-hook" && skillFileText(plan.dir) === ctx.skill.content;
        record.skillRealPath = writeSkill(plan.dir, ctx.skill.content, isConfined(harness));
        record.skillPath = plan.dir;
        record.skillVersion = ctx.skill.version;
        ctx.io.out(
          unchanged
            ? `${harness.displayName}: skill ${ctx.skill.version} unchanged in ${plan.dir}`
            : `${harness.displayName}: skill ${ctx.skill.version} written to ${plan.dir}`,
        );
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

// ---------------------------------------------------------------------------
// T3 Code Antigravity profiles (component-installer §Harnesses and §State,
// re-run, and uninstall; DEC-25(1)). Each profile's config directory gets the
// same MCP entry and named hook as ~/.gemini/config; the skill stays there.

/** The T3 Code profile targets this run sets up for `harness`: none unless it is Antigravity. */
type ProfileTargets = ReadonlyMap<HarnessId, readonly Harness[]>;

function discoverProfileTargets(ctx: Context, harness: Harness): Harness[] {
  if (harness.id !== "antigravity") return [];
  return discoverT3Profiles(ctx).map((dir) => t3ProfileTarget(ctx, harness, dir));
}

const PROFILE_FILES: Readonly<Record<ExtraPathField, typeof T3_MCP_FILE | typeof T3_HOOK_FILE>> = {
  extraConfigPaths: T3_MCP_FILE,
  extraHookPaths: T3_HOOK_FILE,
};

/**
 * The target a recorded T3 Code profile path names, derived from the current
 * T3 Code home; undefined for a stray path.
 */
function recordedProfileTarget(
  ctx: Context,
  harness: Harness,
  path: string,
  field: ExtraPathField,
): { target: Harness; file: string } | undefined {
  const dir = recordedT3ConfigDir(ctx, path, PROFILE_FILES[field]);
  if (dir === undefined) return undefined;
  const target = t3ProfileTarget(ctx, harness, dir);
  const file = field === "extraConfigPaths" ? target.configPath(ctx) : target.hookPath(ctx);
  return { target, file };
}

/**
 * Records `written` in `field` beside the paths already recorded. When this
 * run wrote every target, a recorded path is dropped only when it is a T3
 * Code profile file confirmed absent; a path that still exists, cannot be
 * inspected, or lies outside the current T3 Code home stays for later
 * cleanup.
 */
function recordProfilePaths(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
  field: ExtraPathField,
  written: readonly string[],
  succeeded: boolean,
): void {
  const keep = new Set(written);
  for (const path of record[field] ?? []) {
    if (keep.has(path)) continue;
    if (succeeded) {
      const recorded = recordedProfileTarget(ctx, harness, path, field);
      if (recorded) {
        let found: "absent" | "present" | undefined;
        try {
          found = probeConfined(ctx, recorded.target, recorded.file, "file");
        } catch {
          found = undefined;
        }
        if (found === "absent") continue;
      }
    }
    keep.add(path);
  }
  setExtraPaths(record, field, keep);
}

/**
 * Writes `mcpServers.agentdesk` for `server` and `token` into every T3 Code
 * profile target, leaving a file whose bytes match unchanged, and records each
 * path written or unchanged. Returns failure lines (AC-9.4).
 */
async function syncProfileMcp(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
  targets: readonly Harness[],
  server: string,
  token: string,
  backups: BackupRegistry,
): Promise<string[]> {
  const failures: string[] = [];
  const written: string[] = [];
  for (const target of targets) {
    const file = target.configPath(ctx);
    try {
      const changed = await writeMcpEntry(ctx, target, server, token, backups);
      written.push(file);
      ctx.io.out(
        `${target.displayName}: MCP entry ${changed ? "written to" : "unchanged in"} ${file}`,
      );
    } catch (error) {
      failures.push(
        `${target.displayName}: its MCP entry in ${file} was not written: ${message(error)}`,
      );
    }
  }
  recordProfilePaths(ctx, harness, record, "extraConfigPaths", written, failures.length === 0);
  return failures;
}

/**
 * Writes or refreshes the named hook `agentdesk` in every T3 Code profile
 * target with the same commands as ~/.gemini/config, and records each path
 * written or unchanged. Returns failure lines (AC-9.9).
 */
function syncProfileHooks(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
  targets: readonly Harness[],
  commandFor: (event: HookEvent) => string,
  backups: BackupRegistry,
): string[] {
  const failures: string[] = [];
  const written: string[] = [];
  for (const target of targets) {
    const file = target.hookPath(ctx);
    let changed: boolean;
    try {
      changed = writeHooks(ctx, target, commandFor, backups);
    } catch (error) {
      failures.push(
        `${target.displayName}: its hooks in ${file} were not written: ${message(error)}`,
      );
      continue;
    }
    written.push(file);
    for (const event of hookEvents(target)) {
      ctx.io.out(
        `${target.displayName}: ${event.label} ${changed ? "written to" : "unchanged in"} ${file}`,
      );
    }
  }
  recordProfilePaths(ctx, harness, record, "extraHookPaths", written, failures.length === 0);
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
  profiles: ProfileTargets,
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
    let changed: boolean;
    try {
      changed = writeHooks(ctx, harness, (event) => commands.get(event.id) as string, backups);
    } catch (error) {
      failures.push(
        `${harness.displayName}: its hooks in ${file} were not written: ${message(error)}`,
      );
      continue;
    }
    // A re-run names Antigravity's hook unchanged when its bytes match; the
    // other harnesses keep their messages.
    const verb = !changed && harness.hookFormat === "named-hook" ? "unchanged in" : "written to";
    for (const event of events) {
      record[HOOK_PATH_FIELDS[event.id]] = file;
      ctx.io.out(`${harness.displayName}: ${event.label} ${verb} ${file}`);
    }
    const targets = profiles.get(harness.id) ?? [];
    if (targets.length > 0 || record.extraHookPaths !== undefined) {
      failures.push(
        ...syncProfileHooks(
          ctx,
          harness,
          record,
          targets,
          (event) => commands.get(event.id) as string,
          backups,
        ),
      );
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
    if (removal.removed.length === 0) {
      // An Antigravity `agentdesk` object that holds no handler goes too.
      ctx.io.out(`${harness.displayName}: removing the AgentDesk hooks from ${file}`);
    }
    // Antigravity's backup and write never follow a link (DEC-24(1)).
    backups.backupOnce(file, isConfined(harness));
    writeFileAtomic(file, removal.text, 0o600, isConfined(harness));
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

/**
 * The directory the resume directory's ownership walk starts from: the home
 * directory when the configuration base lies inside it, otherwise the
 * filesystem root. The walk refuses a symbolic link at that directory or at
 * any component below it.
 */
function resumeAnchor(ctx: Context, dir: string): string {
  const home = resolve(ctx.home);
  const rel = relative(home, dir);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? home : parse(dir).root;
}

/**
 * Removes `component-resume`'s `resume` directory beside the state file. The
 * target is derived from the state file's location, never from state
 * content, and is printed before removal. Like a skill folder, it is removed
 * only when it and every directory above it, up to and including the home
 * directory, are real directories and not symbolic links, so a redirected
 * `~/.config`, `XDG_CONFIG_HOME`, or a directory above either is refused. A
 * configuration base outside the home directory is checked from the
 * filesystem root. Throws when it may remain.
 */
function removeResumeDir(ctx: Context): void {
  const dir = resumeDir(ctx);
  try {
    // A symbolic link counts as present, so it is refused rather than skipped.
    lstatSync(dir);
  } catch {
    return;
  }
  ctx.io.out(`Removing the resume directory ${dir}`);
  const anchor = resumeAnchor(ctx, dir);
  let anchorStat: ReturnType<typeof lstatSync>;
  try {
    anchorStat = lstatSync(anchor);
  } catch {
    throw new InstallerError(
      `${dir} is not a resume directory the installer owns (${anchor} cannot be inspected); it was not removed.`,
    );
  }
  if (anchorStat.isSymbolicLink() || !anchorStat.isDirectory()) {
    throw new InstallerError(
      `${dir} is not a resume directory the installer owns (${anchor} is a symbolic link or not a directory); it was not removed.`,
    );
  }
  assertOwnedDir(dir, anchor, "resume directory");
  try {
    rmSync(dir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    throw new InstallerError(`${dir} could not be removed (${code}).`);
  }
}

/**
 * `agentdesk install` (component-installer §Commands; REQ-9). With
 * `keyFile`, the install key is read and checked before anything is printed
 * or requested, and standard input read for `-` is never prompted on again
 * (overlay-install-keys §Installer).
 */
export async function install(ctx: Context, options: InstallOptions): Promise<number> {
  if (options.keyFile === undefined) return installWith(ctx, options, undefined);
  const installKey = await readInstallKey(ctx, options.keyFile);
  const runCtx: Context =
    options.keyFile === STDIN_PATH ? { ...ctx, io: { out: ctx.io.out, err: ctx.io.err } } : ctx;
  return installWith(runCtx, options, installKey);
}

async function installWith(
  ctx: Context,
  options: InstallOptions,
  installKey: string | undefined,
): Promise<number> {
  const previous = readState(ctx) ?? emptyState();
  const requested = options.server !== undefined ? normalizeServer(options.server) : undefined;
  const server = requested ?? previous.server ?? ctx.defaultServer;
  if (!server) {
    throw new InstallerError("This build has no default AgentDesk server. Pass --server <url>.", 2);
  }

  const detected = detectHarnesses(ctx);
  if (detected.length === 0) {
    throw new InstallerError(
      "No supported harness was found. Install Claude Code, Codex, Cursor, or Antigravity first.",
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
  const profiles = new Map<HarnessId, Harness[]>();
  for (const harness of selected) {
    const entry = readMcpEntry(ctx, harness);
    if (entry.token) ctx.secrets.add(entry.token);
    // A hook file the run would refuse stops it before a code is requested.
    checkHookFile(ctx, harness);
    // So does a T3 Code profile's MCP or hook file, before either sign-in
    // route (component-installer §Harnesses; DEC-25(1)).
    const targets = discoverProfileTargets(ctx, harness);
    for (const target of targets) {
      const profileEntry = readMcpEntry(ctx, target);
      if (profileEntry.token) ctx.secrets.add(profileEntry.token);
      checkHookFile(ctx, target);
    }
    profiles.set(harness.id, targets);
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
    const names = needSignIn.map((h) => h.displayName).join(", ");
    const ids = needSignIn.map((h) => h.id);
    try {
      if (installKey !== undefined) {
        ctx.io.out(`Connecting ${names} with the install key.`);
        connections = await enroll(ctx, server, installKey, ids);
      } else {
        ctx.io.out(`Signing in ${names}.`);
        connections = await signIn(ctx, server, ids);
      }
    } catch (error) {
      if (error instanceof InvalidSignInResult) {
        await recoverReported(ctx, previous, server, error);
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
      // No T3 Code profile file is written for this attempt.
      profiles.set(harness.id, []);
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
    state.harnesses[harness.id] = {
      ...state.harnesses[harness.id],
      server,
      connectionId: connection.connectionId,
      configPath: file,
    };

    // Antigravity's T3 Code profiles get the new connection before the one it
    // replaces is revoked; a failed profile keeps the paths already written
    // and fails the run (component-installer §State, re-run, and uninstall).
    const targets = profiles.get(harness.id) ?? [];
    const record = state.harnesses[harness.id] as HarnessRecord;
    if (targets.length > 0 || record.extraConfigPaths !== undefined) {
      failures.push(
        ...(await syncProfileMcp(ctx, harness, record, targets, server, connection.token, backups)),
      );
    }

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
  }

  // AC-9.4: a kept Antigravity connection reaches every T3 Code profile,
  // including one created since the last run, with no new sign-in.
  for (const id of kept) {
    const targets = profiles.get(id) ?? [];
    const record = state.harnesses[id] as HarnessRecord;
    const token = oldEntries.get(id)?.token;
    if (token === undefined || (targets.length === 0 && record.extraConfigPaths === undefined)) {
      continue;
    }
    failures.push(
      ...(await syncProfileMcp(ctx, harnessById(ctx, id), record, targets, server, token, backups)),
    );
  }

  // AC-9.4: every run rewrites the skill, the hook, and Codex trust.
  failures.push(...installSkills(ctx, selected, state));
  failures.push(...(await installGuidance(ctx, selected, state, backups, profiles)));
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
  refused: InvalidSignInResult,
): Promise<void> {
  const state: State = {
    ...previous,
    harnesses: { ...previous.harnesses },
    unrevoked: [...previous.unrevoked],
  };
  for (const item of refused.reported) {
    if (item.token) {
      const result = await revokeConnection(ctx, server, item.token);
      if (result.kind === "revoked") continue;
    }
    if (!item.connectionId) continue;
    const record: UnrevokedConnection = {
      harness: item.harness && isHarnessId(item.harness) ? item.harness : "unknown",
      connectionId: item.connectionId,
      server,
      reason: `the server returned an invalid ${refused.result}`,
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
      "No supported harness was found. Install Claude Code, Codex, Cursor, or Antigravity first.",
    );
  }
  const harnesses = detected.map((d) => d.harness);
  const profiles = new Map<HarnessId, Harness[]>();
  for (const harness of harnesses) {
    checkHookFile(ctx, harness);
    // Every T3 Code profile hook file is checked before any write; the MCP
    // entries are left as they are.
    const targets = discoverProfileTargets(ctx, harness);
    for (const target of targets) checkHookFile(ctx, target);
    profiles.set(harness.id, targets);
  }
  const failures = installSkills(ctx, harnesses, state);
  failures.push(...(await installGuidance(ctx, harnesses, state, new BackupRegistry(), profiles)));
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

/** Describes one recorded T3 Code profile MCP file against the ~/.gemini/config entry. */
function profileMcpStatus(
  ctx: Context,
  harness: Harness,
  path: string,
  canonical: McpEntry | undefined,
): string {
  const recorded = recordedProfileTarget(ctx, harness, path, "extraConfigPaths");
  if (!recorded) {
    return `${harness.displayName}: MCP file ${path} not checked, because it is not a T3 Code profile file under ${t3ProfilesDir(ctx)}`;
  }
  const { target, file } = recorded;
  let entry: McpEntry;
  try {
    if (probeConfined(ctx, target, file, "file") === "absent") {
      return `${target.displayName}: MCP file missing (${file})`;
    }
    entry = readMcpEntry(ctx, target);
  } catch (error) {
    return `${target.displayName}: MCP file unreadable (${message(error)})`;
  }
  if (!entry.present) return `${target.displayName}: no AgentDesk MCP entry in ${file}`;
  if (!canonical?.token) {
    return `${target.displayName}: MCP entry in ${file}, not compared, because ${harness.configPath(ctx)} holds no AgentDesk token`;
  }
  return entry.url === canonical.url && entry.token === canonical.token
    ? `${target.displayName}: MCP entry in ${file} matches ${harness.configPath(ctx)}`
    : `${target.displayName}: MCP entry in ${file} is out of sync with ${harness.configPath(ctx)}. Run: agentdesk install`;
}

/** Describes one recorded T3 Code profile hook file. */
function profileHookStatus(ctx: Context, harness: Harness, path: string): string {
  const recorded = recordedProfileTarget(ctx, harness, path, "extraHookPaths");
  if (!recorded) {
    return `${harness.displayName}: hook file ${path} not checked, because it is not a T3 Code profile file under ${t3ProfilesDir(ctx)}`;
  }
  const { target, file } = recorded;
  const events = hookEvents(target);
  let found: ReturnType<typeof findHooks>;
  try {
    if (probeConfined(ctx, target, file, "file") === "absent") {
      return `${target.displayName}: hook file missing (${file})`;
    }
    found = findHooks(ctx, target, events);
  } catch (error) {
    return `${target.displayName}: hook file unreadable (${message(error)})`;
  }
  const missing = events.filter((event) => found.get(event.id)?.kind !== "found");
  if (missing.length > 0) {
    return `${target.displayName}: no AgentDesk ${missing.map((e) => e.label).join(" or ")} in ${file}. Run: agentdesk install`;
  }
  return `${target.displayName}: ${events.map((e) => e.label).join(" and ")} in ${file}`;
}

/**
 * The `status` lines for T3 Code Antigravity profiles: each recorded MCP and
 * hook file, then each detected profile this installation has not set up
 * (component-installer §State, re-run, and uninstall). No line holds a token.
 */
function profileStatus(ctx: Context, record: HarnessRecord | undefined): string[] {
  const harness = ctx.harnesses.find((h) => h.id === "antigravity");
  if (!harness) return [];
  const lines: string[] = [];
  if (record?.extraConfigPaths) {
    let canonical: McpEntry | undefined;
    try {
      canonical = readMcpEntry(ctx, harness);
    } catch {
      canonical = undefined;
    }
    for (const path of record.extraConfigPaths) {
      lines.push(profileMcpStatus(ctx, harness, path, canonical));
    }
  }
  for (const path of record?.extraHookPaths ?? []) {
    lines.push(profileHookStatus(ctx, harness, path));
  }
  const configs = new Set(record?.extraConfigPaths ?? []);
  const hooks = new Set(record?.extraHookPaths ?? []);
  for (const target of discoverProfileTargets(ctx, harness)) {
    if (configs.has(target.configPath(ctx)) && hooks.has(target.hookPath(ctx))) continue;
    lines.push(
      `${target.displayName}: detected in ${target.configRoot?.(ctx)} but not set up. Run: agentdesk install`,
    );
  }
  return lines;
}

/**
 * `agentdesk status`: each recorded harness, its connection check, its skill
 * version, and its session-start and resume hooks with Codex trust, and each
 * T3 Code Antigravity profile.
 */
export async function status(ctx: Context): Promise<number> {
  const state = readState(ctx);
  const ids = HARNESS_IDS.filter((id) => state?.harnesses[id]);
  if (!state || (ids.length === 0 && state.unrevoked.length === 0)) {
    ctx.io.out("AgentDesk is not installed on this machine. Run: agentdesk install");
    for (const line of profileStatus(ctx, undefined)) ctx.io.out(line);
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
    let skillRefusal: string | undefined;
    if (record.skillPath) {
      // Antigravity's recorded SKILL.md is checked for a link before its
      // version is read (DEC-24(1)).
      try {
        assertConfinedFile(ctx, harness, join(record.skillPath, SKILL_FILE));
      } catch (error) {
        skillRefusal = message(error);
      }
    }
    if (record.skillPath && skillRefusal !== undefined) {
      skill = `skill not read (${skillRefusal})`;
    } else if (record.skillPath) {
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
    if (id === "antigravity") for (const line of profileStatus(ctx, record)) ctx.io.out(line);
  }
  if (!state.harnesses.antigravity) {
    for (const line of profileStatus(ctx, undefined)) ctx.io.out(line);
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

/** A recorded T3 Code profile file that exists and passed every check before uninstall changes anything. */
interface ProfileFile {
  /** The path as the record holds it. */
  path: string;
  target: Harness;
  file: string;
}

interface ProfileUninstall {
  mcp: (ProfileFile & { entry: McpEntry })[];
  hooks: ProfileFile[];
}

/**
 * Checks every recorded T3 Code profile file before uninstall revokes or
 * removes anything for Antigravity: each path must name `mcp_config.json` or
 * `hooks.json` in one profile's `config` directory under the current T3 Code
 * home, and each file that exists must pass no-follow confinement, parse, and
 * hold no foreign handler in `agentdesk`. A file or profile confirmed absent
 * is skipped. Throws on the first refusal, so the record is kept for a retry
 * (component-installer §State, re-run, and uninstall; AC-9.6).
 */
function planProfileUninstall(
  ctx: Context,
  harness: Harness,
  record: HarnessRecord,
): ProfileUninstall {
  const plan: ProfileUninstall = { mcp: [], hooks: [] };
  for (const field of ["extraConfigPaths", "extraHookPaths"] as const) {
    for (const path of record[field] ?? []) {
      const recorded = recordedProfileTarget(ctx, harness, path, field);
      if (!recorded) {
        throw new InstallerError(
          `the recorded T3 Code profile path ${path} is not a ${PROFILE_FILES[field]} in a profile's config directory under ${t3ProfilesDir(ctx)}.`,
        );
      }
      const { target, file } = recorded;
      if (probeConfined(ctx, target, file, "file") === "absent") {
        ctx.io.out(`${target.displayName}: ${file} no longer exists; skipped.`);
        continue;
      }
      if (field === "extraConfigPaths") {
        const entry = readMcpEntry(ctx, target);
        if (entry.token) ctx.secrets.add(entry.token);
        plan.mcp.push({ path, target, file, entry });
      } else {
        planHookRemoval(ctx, target, hookEvents(target));
        plan.hooks.push({ path, target, file });
      }
    }
  }
  return plan;
}

/**
 * Runs `remove` on each checked T3 Code profile file and drops its path from
 * `field`; a path the plan skipped as absent is dropped too. On the first
 * failure the remaining paths stay recorded for a retry, and it returns false.
 */
async function removeProfileFiles<T extends ProfileFile>(
  record: HarnessRecord,
  field: ExtraPathField,
  files: readonly T[],
  failures: string[],
  remove: (profile: T) => Promise<void>,
): Promise<boolean> {
  const remaining = new Set(files.map((profile) => profile.path));
  for (const profile of files) {
    try {
      await remove(profile);
    } catch (error) {
      const what = field === "extraConfigPaths" ? "its MCP entry" : "its hooks";
      failures.push(
        `${profile.target.displayName}: ${what} in ${profile.file} not removed: ${message(error)}`,
      );
      setExtraPaths(record, field, remaining);
      return false;
    }
    remaining.delete(profile.path);
  }
  setExtraPaths(record, field, remaining);
  return true;
}

/** Removes the named hook `agentdesk` from a checked T3 Code profile hook file. */
function removeProfileHooks(ctx: Context, profile: ProfileFile, backups: BackupRegistry): void {
  const removal = planHookRemoval(ctx, profile.target, hookEvents(profile.target));
  if (!removal) return;
  ctx.io.out(`${profile.target.displayName}: removing the AgentDesk hooks from ${profile.file}`);
  backups.backupOnce(profile.file, true);
  writeFileAtomic(profile.file, removal.text, 0o600, true);
}

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
    // Every recorded T3 Code profile file is checked before anything is
    // revoked or removed for Antigravity.
    let profiles: ProfileUninstall = { mcp: [], hooks: [] };
    try {
      profiles = planProfileUninstall(ctx, harness, record);
    } catch (error) {
      failures.push(
        `${harness.displayName}: ${message(error)} Nothing was revoked or removed for it, and its record was kept; fix it, then run agentdesk uninstall again.`,
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
      let token = entry.token;
      let server = recordedServer(state, id) ?? serverOfEntry(entry);
      // With no token in ~/.gemini/config/mcp_config.json, a checked T3 Code
      // profile entry for the recorded server can revoke the shared
      // connection, but only a token the server names as that recorded
      // connection; no token goes to a server a profile names alone.
      const recorded = recordedServer(state, id);
      if (!token && record.connectionId && recorded) {
        for (const profile of profiles.mcp) {
          const candidate = profile.entry.token;
          if (candidate === undefined || profile.entry.url !== mcpUrl(recorded)) continue;
          if ((await connectionIdFor(ctx, recorded, candidate)) !== record.connectionId) continue;
          token = candidate;
          server = recorded;
          ctx.io.out(
            `${harness.displayName}: revoking its connection with the token in ${profile.file}`,
          );
          break;
        }
      }
      if (token) {
        const result = server
          ? await revokeConnection(ctx, server, token)
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
    const hooksRemoved = await removeProfileFiles(
      record,
      "extraHookPaths",
      profiles.hooks,
      failures,
      async (profile) => removeProfileHooks(ctx, profile, backups),
    );
    if (!hooksRemoved) continue;

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
    const entriesRemoved = await removeProfileFiles(
      record,
      "extraConfigPaths",
      profiles.mcp,
      failures,
      async (profile) => {
        if (!profile.entry.present) return;
        ctx.io.out(`${profile.target.displayName}: removing the MCP entry from ${profile.file}`);
        await removeMcpEntry(ctx, profile.target, backups);
      },
    );
    if (!entriesRemoved) continue;

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

  // The waiter's claims and records go once no harness hook can start it
  // again; the state is kept while they may remain, so a later uninstall
  // retries (component-resume §Claims).
  let resumeRemains = false;
  if (Object.keys(state.harnesses).length === 0) {
    try {
      removeResumeDir(ctx);
    } catch (error) {
      resumeRemains = true;
      failures.push(
        `The resume directory was not removed: ${message(error)} Fix it, then run agentdesk uninstall again.`,
      );
    }
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

  if (stateIsEmpty(state) && !resumeRemains) {
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
