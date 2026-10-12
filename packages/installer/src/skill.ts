import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./config.js";
import { type Context, InstallerError } from "./context.js";
import type { Harness } from "./harnesses.js";

export const SKILL_FILE = "SKILL.md";

/** Reads `metadata.version` from a SKILL.md frontmatter block. */
export function skillVersionOf(content: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (!frontmatter) return undefined;
  const metadata = /^metadata:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(frontmatter)?.[1];
  if (!metadata) return undefined;
  return /^[ \t]+version:\s*["']?([^"'\s#]+)["']?/m.exec(metadata)?.[1];
}

export interface SkillPlan {
  harness: Harness;
  /** The folder to write, or undefined when this harness gets no folder of its own. */
  dir: string | undefined;
  /** Why no folder is written. */
  reason?: "unsupported" | "shared";
}

/**
 * Chooses skill folders for the harnesses of a run. Cursor also loads the
 * Claude Code and Codex skill folders, so it gets its own folder only when the
 * run installs neither of those (component-installer §Harnesses).
 */
export function planSkills(ctx: Context, harnesses: readonly Harness[]): SkillPlan[] {
  const sharedFolder = harnesses.some(
    (h) => (h.id === "claude-code" || h.id === "codex") && h.supportsSkills,
  );
  return harnesses.map((harness) => {
    if (!harness.supportsSkills) return { harness, dir: undefined, reason: "unsupported" };
    if (harness.id === "cursor" && sharedFolder)
      return { harness, dir: undefined, reason: "shared" };
    return { harness, dir: harness.skillDir(ctx) };
  });
}

function refuseLink(dir: string): void {
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new InstallerError(`${dir} is a symbolic link; the installer does not write through it.`);
  }
}

/** Writes SKILL.md at the current version (AC-9.4). */
export function writeSkill(dir: string, content: string): void {
  refuseLink(dir);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, SKILL_FILE), content, 0o644);
}

/** Removes an owned skill folder; returns whether it existed. */
export function removeSkillDir(dir: string): boolean {
  if (!existsSync(dir) && !isDanglingLink(dir)) return false;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InstallerError(
      `${dir} is not a skill folder the installer wrote; it was not removed.`,
    );
  }
  rmSync(dir, { recursive: true });
  return true;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function installedSkillVersion(dir: string): string | undefined {
  try {
    return skillVersionOf(readFileSync(join(dir, SKILL_FILE), "utf8"));
  } catch {
    return undefined;
  }
}
