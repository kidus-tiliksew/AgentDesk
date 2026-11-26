import { accessSync, constants, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { type Context, InstallerError } from "./context.js";
import { BACKUP_SUFFIX, tempPath } from "./defaults.js";

/**
 * Harness ids shared with `/device/start` and the identity vocabulary
 * (component-identity §Harnesses).
 */
export const HARNESS_IDS = ["claude-code", "codex", "cursor", "antigravity"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * Shape of the MCP entry: the Claude Code CLI or its JSON, the Codex TOML
 * table, or `mcpServers.agentdesk` `{url, headers}` in a JSON file for Cursor
 * and Antigravity (component-installer §Harnesses).
 */
export type ConfigFormat = "claude" | "codex-toml" | "url-headers-json";

/**
 * Shape of the session-start hook file: `hooks.SessionStart` groups for
 * Claude Code and Codex, `hooks.sessionStart` entries for Cursor, and the
 * top-level named hook object `agentdesk` for Antigravity
 * (component-installer §Standing guidance).
 */
export type HookFormat = "session-start-groups" | "cursor" | "named-hook";

export interface Harness {
  id: HarnessId;
  displayName: string;
  /** AC-9.2: a harness without skills gets its MCP entry and a report. */
  supportsSkills: boolean;
  /** Executables whose presence on PATH detects the harness. */
  executables: readonly string[];
  configFormat: ConfigFormat;
  /** A file or directory whose presence detects the harness. */
  detectionPath(ctx: Context): string;
  /** The user-level MCP configuration file. */
  configPath(ctx: Context): string;
  /** The `agentdesk` skill folder. */
  skillDir(ctx: Context): string;
  /** The base directory the skill folder must stay inside: the home directory or CODEX_HOME. */
  skillAnchor(ctx: Context): string;
  hookFormat: HookFormat;
  /** The user-level file that holds the session-start hook. */
  hookPath(ctx: Context): string;
  /**
   * The directory that the MCP configuration, hook file, and skill folder must
   * stay inside with no symbolic link on the way, or undefined for a harness
   * whose files may be links. See `assertConfined`.
   */
  configRoot?(ctx: Context): string;
  /**
   * The directory the confinement walk starts from, itself included; the home
   * directory when absent. See `assertConfined`.
   */
  confinementAnchor?(ctx: Context): string;
  /**
   * A further way to detect the harness after its executables and detection
   * path: a human-readable reason, or undefined when it finds nothing.
   */
  detectOther?(ctx: Context): string | undefined;
}

export function codexHome(ctx: Context): string {
  const value = ctx.env.CODEX_HOME;
  if (value && value.length > 0) return resolve(ctx.home, value);
  return join(ctx.home, ".codex");
}

/**
 * T3 Code's home: `T3CODE_HOME` resolved against the home directory when it
 * is set and nonempty, as `CODEX_HOME` is, otherwise `~/.t3`
 * (component-installer §Harnesses; DEC-25(1)).
 */
export function t3Home(ctx: Context): string {
  const value = ctx.env.T3CODE_HOME;
  if (value && value.length > 0) return resolve(ctx.home, value);
  return join(ctx.home, ".t3");
}

/** The directory that holds T3 Code's Antigravity profiles. */
export function t3ProfilesDir(ctx: Context): string {
  return join(t3Home(ctx), "userdata", "providers", "antigravity");
}

/** Whether `child` is `parent` or lies below it, compared by path segment. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel.length === 0) return true;
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/**
 * The directory confinement walks from for T3 Code's files: the home
 * directory when T3 Code's home lies inside it, otherwise the filesystem root
 * (component-installer §Harnesses).
 */
export function t3Anchor(ctx: Context): string {
  const home = resolve(ctx.home);
  const base = t3Home(ctx);
  return isWithin(home, base) ? home : parse(base).root;
}

/** Whether `path` exists and is a real directory, not a symbolic link. */
function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The `config` directory of every T3 Code Antigravity profile, sorted by
 * path. Discovery follows no link: when the anchor or any directory from it
 * down to `userdata/providers/antigravity` is missing, is not a directory, or
 * is a symbolic link, there are no profiles. A direct child counts only when
 * it and its `config` directory are real directories (component-installer
 * §Harnesses; DEC-25(1)).
 */
export function discoverT3Profiles(ctx: Context): string[] {
  const anchor = t3Anchor(ctx);
  const dir = t3ProfilesDir(ctx);
  let current = anchor;
  if (!isRealDirectory(current)) return [];
  const rel = relative(anchor, dir);
  for (const part of rel.length > 0 ? rel.split(sep) : []) {
    current = join(current, part);
    if (!isRealDirectory(current)) return [];
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => join(dir, name, "config"))
    .filter((config) => isRealDirectory(join(config, "..")) && isRealDirectory(config))
    .sort();
}

/** The MCP configuration file in a T3 Code profile's `config` directory. */
export const T3_MCP_FILE = "mcp_config.json";
/** The hook file in a T3 Code profile's `config` directory. */
export const T3_HOOK_FILE = "hooks.json";

/**
 * The Antigravity harness pointed at one T3 Code profile's `config`
 * directory: the same MCP entry, named hook, and hook commands as
 * `~/.gemini/config`, confined to that directory and walked from
 * `t3Anchor`. The skill stays in `~/.gemini/config/skills`, which T3 Code
 * profiles link to, so this target writes none (DEC-25(1)).
 */
export function t3ProfileTarget(ctx: Context, base: Harness, configDir: string): Harness {
  const anchor = t3Anchor(ctx);
  return {
    ...base,
    displayName: `${base.displayName} (T3 Code profile ${basename(join(configDir, ".."))})`,
    configPath: () => join(configDir, T3_MCP_FILE),
    hookPath: () => join(configDir, T3_HOOK_FILE),
    configRoot: () => configDir,
    confinementAnchor: () => anchor,
  };
}

/**
 * The `config` directory a recorded T3 Code profile path names, derived from
 * the current T3 Code home, one profile segment, and the exact `file` name,
 * never from the recorded text alone. Undefined for any other path: a stray
 * path, another file name, or a path below a different T3 Code home
 * (component-installer §State, re-run, and uninstall).
 */
export function recordedT3ConfigDir(
  ctx: Context,
  recorded: string,
  file: typeof T3_MCP_FILE | typeof T3_HOOK_FILE,
): string | undefined {
  if (!isAbsolute(recorded)) return undefined;
  const dir = t3ProfilesDir(ctx);
  const rel = relative(dir, resolve(recorded));
  if (isAbsolute(rel)) return undefined;
  const parts = rel.split(sep);
  const [profile, config, name] = parts;
  if (
    parts.length !== 3 ||
    profile === undefined ||
    profile.length === 0 ||
    profile === "." ||
    profile === ".." ||
    config !== "config" ||
    name !== file
  ) {
    return undefined;
  }
  return join(dir, profile, "config");
}

// component-installer §Harnesses and §Standing guidance: detection, MCP entry
// location, skill path, and session-start hook file.
export const HARNESSES: readonly Harness[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    supportsSkills: true,
    executables: ["claude"],
    configFormat: "claude",
    detectionPath: (ctx) => join(ctx.home, ".claude.json"),
    configPath: (ctx) => join(ctx.home, ".claude.json"),
    skillDir: (ctx) => join(ctx.home, ".claude", "skills", "agentdesk"),
    skillAnchor: (ctx) => ctx.home,
    hookFormat: "session-start-groups",
    hookPath: (ctx) => join(ctx.home, ".claude", "settings.json"),
  },
  {
    id: "codex",
    displayName: "Codex",
    supportsSkills: true,
    executables: ["codex"],
    configFormat: "codex-toml",
    detectionPath: (ctx) => codexHome(ctx),
    configPath: (ctx) => join(codexHome(ctx), "config.toml"),
    skillDir: (ctx) => join(codexHome(ctx), "skills", "agentdesk"),
    skillAnchor: (ctx) => codexHome(ctx),
    hookFormat: "session-start-groups",
    hookPath: (ctx) => join(codexHome(ctx), "hooks.json"),
  },
  {
    id: "cursor",
    displayName: "Cursor",
    supportsSkills: true,
    executables: ["cursor-agent", "agent", "cursor"],
    configFormat: "url-headers-json",
    detectionPath: (ctx) => join(ctx.home, ".cursor"),
    configPath: (ctx) => join(ctx.home, ".cursor", "mcp.json"),
    skillDir: (ctx) => join(ctx.home, ".cursor", "skills", "agentdesk"),
    skillAnchor: (ctx) => ctx.home,
    hookFormat: "cursor",
    hookPath: (ctx) => join(ctx.home, ".cursor", "hooks.json"),
  },
  {
    // DEC-25(1): the user-level configuration under ~/.gemini/config, plus
    // the MCP entry and named hook in each T3 Code Antigravity profile's
    // config directory (`t3ProfileTarget`); ~/.gemini/antigravity-cli and the
    // T3 Code profiles also detect the harness.
    id: "antigravity",
    displayName: "Antigravity",
    supportsSkills: true,
    executables: ["agy"],
    configFormat: "url-headers-json",
    detectionPath: (ctx) => join(ctx.home, ".gemini", "antigravity-cli"),
    configPath: (ctx) => join(ctx.home, ".gemini", "config", "mcp_config.json"),
    skillDir: (ctx) => join(ctx.home, ".gemini", "config", "skills", "agentdesk"),
    skillAnchor: (ctx) => ctx.home,
    hookFormat: "named-hook",
    hookPath: (ctx) => join(ctx.home, ".gemini", "config", "hooks.json"),
    configRoot: (ctx) => join(ctx.home, ".gemini", "config"),
    detectOther: (ctx) =>
      discoverT3Profiles(ctx).length > 0 ? `T3 Code profiles in ${t3ProfilesDir(ctx)}` : undefined,
  },
];

/** Whether `harness` is confined to a configuration root (see `assertConfined`). */
export function isConfined(harness: Harness): boolean {
  return harness.configRoot !== undefined;
}

/**
 * `assertConfined` for a file the installer reads and writes, and for the
 * backup and temporary files it writes beside it. The file and each of those
 * two must be absent or a regular file, never a symbolic link, a directory, a
 * FIFO, a socket, or a device. So no read can block on a special file, and no
 * backup or write can leave the root through a link at any of the three
 * paths. Callers check before any read, so a refusal comes before sign-in and
 * before any write.
 */
export function assertConfinedFile(ctx: Context, harness: Harness, file: string): void {
  if (!isConfined(harness)) return;
  assertConfined(ctx, harness, file, "file");
  for (const sibling of [file + BACKUP_SUFFIX, tempPath(file)]) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(sibling);
    } catch (error) {
      // Only a confirmed absence passes; any other failure is refused.
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
      throw new InstallerError(
        `${sibling} cannot be inspected, and the installer writes there before it changes ${file}; nothing was read or changed.`,
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new InstallerError(
        `${sibling} is a symbolic link or not a regular file, and the installer writes there before it changes ${file}; nothing was read or changed.`,
      );
    }
  }
}

/**
 * Refuses `path` for a harness with a configuration root unless it resolves
 * inside that root: `path` must lie under the root, no existing component
 * from the anchor (the home directory, or the harness's
 * `confinementAnchor`), itself included, down to `path` may be a symbolic
 * link, every existing component above `path` must be a directory, and an
 * existing `path` must be a regular file or a directory, as `kind` says. A
 * missing component ends the walk, because the installer creates it as a real
 * directory or file. A harness without a root is never refused. Callers check
 * before any read or write of `path` (DEC-25(1): Antigravity's setup stays in
 * ~/.gemini/config and in each T3 Code profile's config directory, never
 * behind a link).
 */
export function assertConfined(
  ctx: Context,
  harness: Harness,
  path: string,
  kind: "file" | "directory",
): void {
  probeConfined(ctx, harness, path, kind);
}

/**
 * `assertConfined`, returning whether `path` exists: "absent" when a
 * component from the anchor down to `path` is confirmed missing, "present"
 * when `path` exists and passes. Any other outcome throws.
 */
export function probeConfined(
  ctx: Context,
  harness: Harness,
  path: string,
  kind: "file" | "directory",
): "absent" | "present" {
  const root = harness.configRoot?.(ctx);
  if (root === undefined) return lstatOrMissing(path) ? "present" : "absent";
  const refuse = (why: string) =>
    new InstallerError(`${path} was not read or changed, because ${why}.`);
  if (path === root || !isWithin(root, path)) {
    throw refuse(`it lies outside ${root}`);
  }
  const anchor = harness.confinementAnchor?.(ctx) ?? ctx.home;
  if (!isWithin(anchor, root)) throw refuse(`${root} lies outside ${anchor}`);
  const check = (current: string, last: boolean): boolean => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
      throw refuse(`${current} cannot be inspected`);
    }
    if (stat.isSymbolicLink()) {
      throw refuse(`${current} is a symbolic link, which the installer does not follow`);
    }
    if (!last || kind === "directory") {
      if (!stat.isDirectory()) throw refuse(`${current} is not a directory`);
    } else if (!stat.isFile()) {
      throw refuse("it is not a regular file");
    }
    return true;
  };
  let current = anchor;
  if (!check(current, false)) return "absent";
  for (const part of relative(anchor, path).split(sep)) {
    current = join(current, part);
    if (!check(current, current === path)) return "absent";
  }
  return "present";
}

function lstatOrMissing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function harnessById(ctx: Context, id: HarnessId): Harness {
  const harness = ctx.harnesses.find((h) => h.id === id);
  if (!harness) throw new Error(`unknown harness ${id}`);
  return harness;
}

/** Returns the absolute path of an executable named `name` on PATH, if any. */
export function findExecutable(ctx: Context, name: string): string | undefined {
  const pathValue = ctx.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not present or not executable
    }
  }
  return undefined;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface Detection {
  harness: Harness;
  /** Human-readable reason, such as "claude on PATH" or "~/.claude.json". */
  via: string;
}

/** AC-9.1: detect which harnesses are installed for the current user. */
export function detectHarnesses(ctx: Context): Detection[] {
  const found: Detection[] = [];
  for (const harness of ctx.harnesses) {
    const executable = harness.executables.find((name) => findExecutable(ctx, name));
    if (executable) {
      found.push({ harness, via: `${executable} on PATH` });
      continue;
    }
    const path = harness.detectionPath(ctx);
    if (exists(path)) {
      found.push({ harness, via: path });
      continue;
    }
    const other = harness.detectOther?.(ctx);
    if (other !== undefined) found.push({ harness, via: other });
  }
  return found;
}
