import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "../context.js";
import { statePath } from "../state.js";

// component-resume §Claims: resume state lives under
// `${XDG_CONFIG_HOME:-~/.config}/agentdesk/resume/`, beside the installer's
// state file, with directories at mode 0700 and files at 0600. Nothing here
// holds a token or an answer.

export const CLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CURSOR_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Identifiers that name files: decision ids, Cursor conversation ids, and
 * Codex thread ids. One path segment of letters, digits, `_`, and `-`, not
 * starting with `-`, so no identifier can leave its directory, read as an
 * option, or collide with the `.lock` and `.tmp` names beside it.
 */
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,199}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export class ResumeStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeStorageError";
  }
}

/** The `resume` directory beside `state.json`. */
export function resumeDir(ctx: Context): string {
  return join(dirname(statePath(ctx)), "resume");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Creates `dir` with mode 0700 when missing and refuses it when it is a
 * symbolic link or not a directory, so cleanup never follows a redirect.
 */
function ensureRealDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ResumeStorageError(`${dir} is not a directory the waiter owns.`);
  }
  if ((stat.mode & 0o777) !== DIR_MODE) chmodSync(dir, DIR_MODE);
}

/** Resume storage for one machine user. */
export class ResumeStore {
  readonly root: string;

  constructor(ctx: Context) {
    this.root = resumeDir(ctx);
  }

  /** Creates `resume/` and the named subdirectories, each a real 0700 directory. */
  private dir(...segments: string[]): string {
    const base = dirname(this.root);
    mkdirSync(base, { recursive: true, mode: DIR_MODE });
    ensureRealDir(this.root);
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      ensureRealDir(current);
    }
    return current;
  }

  private static requireId(value: string): string {
    if (!isSafeId(value)) throw new ResumeStorageError("refused an unsafe identifier.");
    return value;
  }

  // -------------------------------------------------------------------------
  // Claims

  claimPath(decisionId: string): string {
    return join(this.root, "claims", ResumeStore.requireId(decisionId));
  }

  /**
   * Creates `claims/<decision-id>` exclusively. Returns true for the one
   * caller on the machine that created it, and false when it already exists
   * (component-resume §Claims; AC-12.4).
   */
  claim(decisionId: string): boolean {
    const dir = this.dir("claims");
    const file = join(dir, ResumeStore.requireId(decisionId));
    let fd: number;
    try {
      fd = openSync(file, "wx", FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    closeSync(fd);
    return true;
  }

  /** Deletes claims last modified more than 30 days before `now`. */
  cleanupClaims(now: number): void {
    const dir = this.dir("claims");
    removeOldFiles(dir, now - CLAIM_MAX_AGE_MS);
  }

  // -------------------------------------------------------------------------
  // Codex waiter records

  /** Reads the process id recorded in `waiters/<decision-id>`. */
  waiterPid(decisionId: string): number | undefined {
    const file = join(this.dir("waiters"), ResumeStore.requireId(decisionId));
    let text: string;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) return undefined;
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const pid = Number(text.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }

  /** Writes the waiter's process id to `waiters/<decision-id>`, replacing a stale one. */
  recordWaiter(decisionId: string, pid: number): void {
    const dir = this.dir("waiters");
    const file = join(dir, ResumeStore.requireId(decisionId));
    writeFile(file, `${pid}\n`);
  }

  /** Removes the waiter record when it still names `pid`. */
  forgetWaiter(decisionId: string, pid: number): void {
    if (this.waiterPid(decisionId) !== pid) return;
    try {
      unlinkSync(join(this.root, "waiters", ResumeStore.requireId(decisionId)));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /**
   * Takes the per-decision start lock `waiters/<decision-id>.lock`, so two
   * `Stop` hooks running at once cannot both start a waiter for one decision.
   * Returns a release function, or undefined when another hook holds the lock.
   * A lock older than `staleMs` is left by a hook that died and is replaced.
   */
  lockWaiterStart(decisionId: string, now: number, staleMs: number): (() => void) | undefined {
    const dir = this.dir("waiters");
    const file = join(dir, `${ResumeStore.requireId(decisionId)}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        closeSync(openSync(file, "wx", FILE_MODE));
        return () => {
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let stale = false;
      try {
        const stat = lstatSync(file);
        stale = stat.isFile() && stat.mtimeMs < now - staleMs;
      } catch (error) {
        if (!isMissing(error)) throw error;
        stale = true;
      }
      if (!stale) return undefined;
      try {
        unlinkSync(file);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Cursor records

  /** Creates `cursor/<conversation-id>/<decision-id>`; an existing record is kept. */
  recordCursorDecision(conversationId: string, decisionId: string): void {
    const dir = this.dir("cursor", ResumeStore.requireId(conversationId));
    const file = join(dir, ResumeStore.requireId(decisionId));
    try {
      closeSync(openSync(file, "wx", FILE_MODE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  /** The decision ids recorded for a conversation, oldest name order. */
  cursorDecisions(conversationId: string): string[] {
    const dir = join(this.dir("cursor"), ResumeStore.requireId(conversationId));
    let entries: string[];
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
      entries = readdirSync(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .filter((name) => isSafeId(name))
      .filter((name) => {
        try {
          return lstatSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  }

  /**
   * Deletes Cursor records last modified more than 7 days before `now`, and a
   * conversation directory left empty by that.
   */
  cleanupCursorRecords(now: number): void {
    const root = this.dir("cursor");
    for (const name of readdirSync(root)) {
      if (!isSafeId(name)) continue;
      const dir = join(root, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(dir);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      removeOldFiles(dir, now - CURSOR_RECORD_MAX_AGE_MS);
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // a concurrent hook recorded a decision or removed the directory
      }
    }
  }
}

/** Removes regular files in `dir` whose modification time is before `cutoff`. */
function removeOldFiles(dir: string, cutoff: number): void {
  for (const name of readdirSync(dir)) {
    if (!isSafeId(name)) continue;
    const file = join(dir, name);
    try {
      const stat = lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) unlinkSync(file);
    } catch {
      // removed concurrently
    }
  }
}

/** Writes `content` to `file` atomically with mode 0600. */
function writeFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", FILE_MODE);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, FILE_MODE);
  renameSync(temp, file);
}
