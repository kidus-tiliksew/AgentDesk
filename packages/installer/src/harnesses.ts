import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
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
}

export function codexHome(ctx: Context): string {
  const value = ctx.env.CODEX_HOME;
  if (value && value.length > 0) return resolve(ctx.home, value);
  return join(ctx.home, ".codex");
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
    // DEC-24(1): only the user-level configuration under ~/.gemini/config;
    // ~/.gemini/antigravity-cli serves detection alone.
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
    } catch {
      continue;
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
 * from the home directory down to `path` may be a symbolic link, every
 * existing component above `path` must be a directory, and an existing
 * `path` must be a regular file or a directory, as `kind` says. A missing
 * component ends the walk, because the installer creates it as a real
 * directory or file. A harness without a root is never refused. Callers check
 * before any read or write of `path` (DEC-24(1): Antigravity's setup stays in
 * its user-level configuration under ~/.gemini/config, never in a linked host
 * application profile).
 */
export function assertConfined(
  ctx: Context,
  harness: Harness,
  path: string,
  kind: "file" | "directory",
): void {
  const root = harness.configRoot?.(ctx);
  if (root === undefined) return;
  const refuse = (why: string) =>
    new InstallerError(`${path} was not read or changed, because ${why}.`);
  const insideRoot = relative(root, path);
  if (insideRoot.length === 0 || insideRoot.startsWith("..") || isAbsolute(insideRoot)) {
    throw refuse(`it lies outside ${root}`);
  }
  let current = ctx.home;
  for (const part of relative(ctx.home, path).split(sep)) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      throw refuse(`${current} cannot be inspected`);
    }
    if (stat.isSymbolicLink()) {
      throw refuse(`${current} is a symbolic link, which the installer does not follow`);
    }
    if (current !== path || kind === "directory") {
      if (!stat.isDirectory()) throw refuse(`${current} is not a directory`);
    } else if (!stat.isFile()) {
      throw refuse("it is not a regular file");
    }
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
    if (exists(path)) found.push({ harness, via: path });
  }
  return found;
}
