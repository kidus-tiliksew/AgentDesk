import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Context } from "./context.js";

/**
 * Harness ids shared with `/device/start` and the identity vocabulary
 * (component-identity §Harnesses).
 */
export const HARNESS_IDS = ["claude-code", "codex", "cursor"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

export type ConfigFormat = "claude" | "codex-toml" | "cursor-json";

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
}

export function codexHome(ctx: Context): string {
  const value = ctx.env.CODEX_HOME;
  if (value && value.length > 0) return resolve(ctx.home, value);
  return join(ctx.home, ".codex");
}

// component-installer §Harnesses: detection, MCP entry location, and skill path.
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
  },
  {
    id: "cursor",
    displayName: "Cursor",
    supportsSkills: true,
    executables: ["cursor-agent", "agent", "cursor"],
    configFormat: "cursor-json",
    detectionPath: (ctx) => join(ctx.home, ".cursor"),
    configPath: (ctx) => join(ctx.home, ".cursor", "mcp.json"),
    skillDir: (ctx) => join(ctx.home, ".cursor", "skills", "agentdesk"),
    skillAnchor: (ctx) => ctx.home,
  },
];

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
