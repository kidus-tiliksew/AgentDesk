import {
  type BackupRegistry,
  isPlainObject,
  type JsonObject,
  readJsonFile,
  writeFileAtomic,
} from "./config.js";
import { type Context, InstallerError } from "./context.js";
import { HOOK_MATCHER } from "./defaults.js";
import { runningExecutable } from "./guidance.js";
import type { Harness, HarnessId } from "./harnesses.js";

// component-installer §Standing guidance: each harness's session-start hook
// runs `<executable> context --harness <id>`. The hook holds no token.

const SHELL_SAFE = /^[A-Za-z0-9_./-]+$/;
const SINGLE_QUOTED = /^'((?:[^']|'\\'')*)'$/;

/** Single-quotes `path` for the shell when it holds a character outside `A-Za-z0-9_./-`. */
export function shellQuote(path: string): string {
  return SHELL_SAFE.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

function shellUnquote(word: string): string | undefined {
  if (SHELL_SAFE.test(word)) return word;
  const quoted = SINGLE_QUOTED.exec(word)?.[1];
  return quoted === undefined ? undefined : quoted.replaceAll(`'\\''`, "'");
}

/** The hook command for `harness`, run by the executable at `executable`. */
export function hookCommand(executable: string, harness: HarnessId): string {
  return `${shellQuote(executable)} context --harness ${harness}`;
}

/** The command the hooks of this run hold. */
export function currentHookCommand(ctx: Context, harness: HarnessId): string {
  return hookCommand(ctx.executable ?? runningExecutable(), harness);
}

/**
 * Whether `command` is the installer's hook for `harness`:
 * `<absolute path ending in /agentdesk> context --harness <id>`.
 */
export function isInstallerCommand(command: string, harness: HarnessId): boolean {
  const suffix = ` context --harness ${harness}`;
  if (!command.endsWith(suffix)) return false;
  const path = shellUnquote(command.slice(0, -suffix.length));
  return Boolean(path?.startsWith("/") && path.endsWith("/agentdesk"));
}

function eventName(harness: Harness): string {
  return harness.hookFormat === "cursor" ? "sessionStart" : "SessionStart";
}

interface HookDocument {
  /** The parsed file, or a new document when the file does not exist. */
  data: JsonObject;
  indent: string;
  /** The file's text, or undefined when it does not exist. */
  text: string | undefined;
  hooks: JsonObject;
  /** The event's array: groups for Claude Code and Codex, entries for Cursor. */
  event: unknown[];
}

/**
 * Reads a hook file. A file that cannot be read or does not parse, or whose
 * `hooks` value is not an object or whose event value is not an array, is
 * refused: the caller changes nothing.
 */
function readHookDocument(file: string, harness: Harness): HookDocument {
  const current = readJsonFile(file);
  const data: JsonObject = current?.data ?? (harness.hookFormat === "cursor" ? { version: 1 } : {});
  const hooks = data.hooks ?? {};
  if (!isPlainObject(hooks)) {
    throw new InstallerError(
      `${file} has a hooks value that is not an object; it was not changed.`,
    );
  }
  const name = eventName(harness);
  const event = hooks[name] ?? [];
  if (!Array.isArray(event)) {
    throw new InstallerError(
      `${file} has a hooks.${name} value that is not a list; it was not changed.`,
    );
  }
  return { data, indent: current?.indent ?? "  ", text: current?.text, hooks, event };
}

function handlersOf(group: unknown): unknown[] | undefined {
  return isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
}

function commandOf(handler: unknown): string | undefined {
  return isPlainObject(handler) && typeof handler.command === "string"
    ? handler.command
    : undefined;
}

function isOwned(handler: unknown, harness: Harness): boolean {
  const command = commandOf(handler);
  return command !== undefined && isInstallerCommand(command, harness.id);
}

function serialize(doc: HookDocument, harness: Harness, event: unknown[]): string {
  const data: JsonObject = { ...doc.data, hooks: { ...doc.hooks, [eventName(harness)]: event } };
  return `${JSON.stringify(data, null, doc.indent)}\n`;
}

/** Throws when the harness's hook file would be refused; used before sign-in. */
export function checkHookFile(ctx: Context, harness: Harness): void {
  readHookDocument(harness.hookPath(ctx), harness);
}

/**
 * Writes the installer's hook for `harness` with `command`. An installer entry
 * is replaced in place, so its group keeps its position; a new group (Claude
 * Code, Codex) or entry (Cursor) is appended only when none exists. Every
 * other key, group, and hook is kept. Returns whether the file changed.
 */
export function writeHook(
  ctx: Context,
  harness: Harness,
  command: string,
  backups: BackupRegistry,
): boolean {
  const file = harness.hookPath(ctx);
  const doc = readHookDocument(file, harness);
  let found = false;
  let event: unknown[];
  if (harness.hookFormat === "cursor") {
    event = doc.event.map((entry) => {
      if (!isOwned(entry, harness)) return entry;
      found = true;
      return { ...(entry as JsonObject), command };
    });
    if (!found) event.push({ command });
  } else {
    event = doc.event.map((group) => {
      const handlers = handlersOf(group);
      if (!handlers?.some((handler) => isOwned(handler, harness))) return group;
      found = true;
      return {
        ...(group as JsonObject),
        hooks: handlers.map((handler) =>
          isOwned(handler, harness)
            ? { ...(handler as JsonObject), type: "command", command }
            : handler,
        ),
      };
    });
    if (!found) event.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] });
  }
  const text = serialize(doc, harness, event);
  if (text === doc.text) return false;
  backups.backupOnce(file);
  writeFileAtomic(file, text);
  return true;
}

/** Returns the command of the installer's hook in the harness's hook file, if any. */
export function findHook(ctx: Context, harness: Harness): string | undefined {
  const file = harness.hookPath(ctx);
  const doc = readHookDocument(file, harness);
  if (doc.text === undefined) return undefined;
  const entries =
    harness.hookFormat === "cursor" ? doc.event : doc.event.flatMap((g) => handlersOf(g) ?? []);
  const owned = entries.find((entry) => isOwned(entry, harness));
  return owned === undefined ? undefined : commandOf(owned);
}

export interface HookRemoval {
  /** The hook file's text without the installer's hook. */
  text: string;
  /**
   * Hooks whose position changes, as `"<group>:<handler>"` before and after
   * the removal. Codex keys a hook by its position, so these keys change.
   */
  moved: Map<string, string>;
}

/**
 * Plans the removal of the installer's hook and of its group when that group
 * then holds no other hook. Returns undefined when the file holds no
 * installer hook.
 */
export function planHookRemoval(ctx: Context, harness: Harness): HookRemoval | undefined {
  const file = harness.hookPath(ctx);
  const doc = readHookDocument(file, harness);
  if (doc.text === undefined) return undefined;
  const moved = new Map<string, string>();
  let removed = false;
  let event: unknown[];
  if (harness.hookFormat === "cursor") {
    event = doc.event.filter((entry) => !isOwned(entry, harness));
    removed = event.length !== doc.event.length;
  } else {
    event = [];
    doc.event.forEach((group, index) => {
      const handlers = handlersOf(group);
      const kept: unknown[] = [];
      handlers?.forEach((handler, position) => {
        if (isOwned(handler, harness)) {
          removed = true;
          return;
        }
        if (index !== event.length || position !== kept.length) {
          moved.set(`${index}:${position}`, `${event.length}:${kept.length}`);
        }
        kept.push(handler);
      });
      if (!handlers || kept.length === handlers.length) {
        event.push(group);
      } else if (kept.length > 0) {
        event.push({ ...(group as JsonObject), hooks: kept });
      }
    });
  }
  if (!removed) return undefined;
  return { text: serialize(doc, harness, event), moved };
}
