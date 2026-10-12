import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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

/**
 * Writes SKILL.md at the current version (AC-9.4) and returns the folder's
 * resolved path, which the state records for removal.
 */
export function writeSkill(dir: string, content: string): string {
  refuseLink(dir);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, SKILL_FILE), content, 0o644);
  return realpathSync(dir);
}

/**
 * Refuses a removal target that leaves the installer's own location: every
 * path component below `anchor` must be a real directory, not a symbolic
 * link, and the resolved target must equal the owned location under the
 * resolved anchor. A redirected parent such as a symlinked ~/.claude/skills
 * is refused as well as a symlinked final folder.
 */
export function assertOwnedDir(dir: string, anchor: string): void {
  const refuse = (why: string) =>
    new InstallerError(
      `${dir} is not a skill folder the installer owns (${why}); it was not removed.`,
    );
  const rel = relative(anchor, dir);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel))
    throw refuse(`it is outside ${anchor}`);
  let current = anchor;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      throw refuse(`${current} cannot be inspected`);
    }
    if (stat.isSymbolicLink()) throw refuse(`${current} is a symbolic link`);
    if (!stat.isDirectory()) throw refuse(`${current} is not a directory`);
  }
  if (realpathSync(dir) !== join(realpathSync(anchor), rel)) {
    throw refuse("it resolves to another location");
  }
}

/**
 * Removes an owned skill folder; returns whether it existed. `anchor` is the
 * harness's own base directory (the home directory or CODEX_HOME), and
 * `recordedRealPath` is the folder's resolved path recorded when it was
 * written. The folder must still resolve to that path, which covers a
 * redirected anchor or any directory above it; the components below the
 * anchor must also be real directories. The caller reports the path before
 * calling.
 */
export function removeSkillDir(
  dir: string,
  anchor: string,
  recordedRealPath: string | undefined,
): boolean {
  if (!existsSync(dir) && !isDanglingLink(dir)) return false;
  assertOwnedDir(dir, anchor);
  const refuse = (why: string) =>
    new InstallerError(
      `${dir} is not a skill folder the installer owns (${why}); it was not removed.`,
    );
  if (!recordedRealPath) throw refuse("no resolved location was recorded when it was written");
  const resolved = realpathSync(dir);
  if (resolved !== recordedRealPath) {
    throw refuse(`it resolves to ${resolved}, not to ${recordedRealPath} where it was written`);
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
