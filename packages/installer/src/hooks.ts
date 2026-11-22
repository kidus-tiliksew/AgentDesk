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
import { assertConfinedFile, type Harness, type HarnessId } from "./harnesses.js";

// component-installer §Standing guidance and §Resume hooks: each harness's
// session-start hook runs `<executable> context --harness <id>`, and the
// Codex, Cursor, and Antigravity resume hooks run `<executable> hook <event>
// --harness <id>`. Antigravity's hooks live in the named hook object
// `agentdesk` (DEC-24(1)). No hook holds a token.

/**
 * The hooks the installer writes: `session-start` runs `context`, and the
 * resume hooks `stop` and `after-mcp` run `hook stop` and `hook after-mcp`.
 */
export type HookEventId = "session-start" | "stop" | "after-mcp";

/** The hooks each harness gets (DEC-12; DEC-15(3) to DEC-15(5); DEC-24(2), DEC-24(3)). */
const EVENTS_BY_HARNESS: Readonly<Record<HarnessId, readonly HookEventId[]>> = {
  "claude-code": ["session-start"],
  codex: ["session-start", "stop"],
  cursor: ["session-start", "after-mcp", "stop"],
  antigravity: ["session-start", "stop"],
};

/** The hook events the installer writes for the harness `id`. */
export function hookEventIds(id: HarnessId): readonly HookEventId[] {
  return EVENTS_BY_HARNESS[id];
}

/** One hook the installer writes into a harness's hook file. */
export interface HookEvent {
  id: HookEventId;
  /** The key under `hooks` that holds the event's groups or entries. */
  name: string;
  /**
   * The event in a Codex hook key, `<file>:<keyName>:<group>:<handler>`;
   * undefined for a harness whose hooks are not keyed.
   */
  keyName: string | undefined;
  /** How messages and `status` name the hook. */
  label: string;
  /** Fields the installer's handler or entry holds besides its command. */
  fields: Readonly<JsonObject>;
  /** The matcher of a new group; a new group holds none when undefined. */
  matcher: string | undefined;
}

/** The hooks written for `harness`, in the order the installer writes them. */
export function hookEvents(harness: Harness): readonly HookEvent[] {
  return hookEventIds(harness.id).map((id) => hookEvent(harness, id));
}

/** The description of the hook `id` for `harness`. */
export function hookEvent(harness: Harness, id: HookEventId): HookEvent {
  const cursor = harness.hookFormat === "cursor";
  switch (id) {
    case "session-start":
      // Antigravity runs the handler under a 30-second timeout and keys no
      // hook, so it records no trust (DEC-24(2)).
      if (harness.hookFormat === "named-hook") {
        return {
          id,
          name: "SessionStart",
          keyName: undefined,
          label: "session-start hook",
          fields: { timeout: 30 },
          matcher: undefined,
        };
      }
      return {
        id,
        name: cursor ? "sessionStart" : "SessionStart",
        keyName: cursor ? undefined : "session_start",
        label: "session-start hook",
        fields: {},
        matcher: HOOK_MATCHER,
      };
    case "stop":
      // Codex runs the Stop hook with a 10-second timeout; Cursor's stop hook
      // holds for up to 50 minutes under a 3600-second timeout with no loop
      // limit; Antigravity's Stop hook holds under a 3600-second timeout and
      // keys no hook, so it records no trust and sets no loop limit
      // (component-resume §Codex stop hook, §Cursor hooks, and §Antigravity
      // stop hook; DEC-24(3)).
      if (harness.hookFormat === "named-hook") {
        return {
          id,
          name: "Stop",
          keyName: undefined,
          label: "Stop hook",
          fields: { timeout: 3600 },
          matcher: undefined,
        };
      }
      return cursor
        ? {
            id,
            name: "stop",
            keyName: undefined,
            label: "stop hook",
            fields: { timeout: 3600, loop_limit: null },
            matcher: undefined,
          }
        : {
            id,
            name: "Stop",
            keyName: "stop",
            label: "Stop hook",
            fields: { timeout: 10 },
            matcher: undefined,
          };
    case "after-mcp":
      return {
        id,
        name: "afterMCPExecution",
        keyName: undefined,
        label: "afterMCPExecution hook",
        fields: {},
        matcher: undefined,
      };
  }
}

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

/** The arguments after the executable in the hook `event` of `harness`. */
function commandArguments(harness: HarnessId, event: HookEventId): string {
  return event === "session-start"
    ? `context --harness ${harness}`
    : `hook ${event} --harness ${harness}`;
}

/** The command of the hook `event` for `harness`, run by the executable at `executable`. */
export function hookCommand(
  executable: string,
  harness: HarnessId,
  event: HookEventId = "session-start",
): string {
  return `${shellQuote(executable)} ${commandArguments(harness, event)}`;
}

/** The command the hook `event` of this run holds. */
export function currentHookCommand(
  ctx: Context,
  harness: HarnessId,
  event: HookEventId = "session-start",
): string {
  return hookCommand(ctx.executable ?? runningExecutable(), harness, event);
}

/**
 * The executable names whose hooks the installer owns for each harness. The
 * hook runs `<executable>`: the compiled binary, which install.sh installs as
 * `agentdesk`, or the bundle file when Node runs it, which `scripts/build.mjs`
 * writes as `agentdesk.mjs` (component-installer §Standing guidance and §Build
 * and distribution). Antigravity owns both, so a hook its bundle wrote is
 * recognized on a re-run, in `status`, and on uninstall. The other harnesses
 * keep the ownership rule they had before Antigravity: `agentdesk` only.
 */
const OWNED_EXECUTABLE_NAMES: Readonly<Record<HarnessId, readonly string[]>> = {
  "claude-code": ["agentdesk"],
  codex: ["agentdesk"],
  cursor: ["agentdesk"],
  antigravity: ["agentdesk", "agentdesk.mjs"],
};

/**
 * Whether `command` is the installer's hook `event` for `harness`:
 * `<absolute path ending in /<name>> context --harness <id>` for the
 * session-start hook and `<absolute path ending in /<name>> hook <event>
 * --harness <id>` for a resume hook, where `<name>` is one of the harness's
 * owned executable names.
 */
export function isInstallerCommand(
  command: string,
  harness: HarnessId,
  event: HookEventId = "session-start",
): boolean {
  const suffix = ` ${commandArguments(harness, event)}`;
  if (!command.endsWith(suffix)) return false;
  const path = shellUnquote(command.slice(0, -suffix.length));
  if (!path?.startsWith("/")) return false;
  return OWNED_EXECUTABLE_NAMES[harness].some((name) => path.endsWith(`/${name}`));
}

interface HookDocument {
  file: string;
  /** The parsed file, or a new document when the file does not exist. */
  data: JsonObject;
  indent: string;
  /** The file's text, or undefined when it does not exist. */
  text: string | undefined;
  hooks: JsonObject;
}

/**
 * Reads a hook file. A file that cannot be read or does not parse, or whose
 * `hooks` value is not an object, is refused: the caller changes nothing.
 * Only an absent key defaults; a present `null` is refused like any other
 * value of the wrong type.
 */
function readHookDocument(file: string, harness: Harness): HookDocument {
  const current = readJsonFile(file);
  const data: JsonObject = current?.data ?? (harness.hookFormat === "cursor" ? { version: 1 } : {});
  const hooks = "hooks" in data ? data.hooks : {};
  if (!isPlainObject(hooks)) {
    throw new InstallerError(
      `${file} has a hooks value that is not an object; it was not changed.`,
    );
  }
  return { file, data, indent: current?.indent ?? "  ", text: current?.text, hooks };
}

/**
 * The event's array: groups for Claude Code and Codex, entries for Cursor.
 * An event value that is not an array is refused.
 */
function eventArray(doc: HookDocument, event: HookEvent): unknown[] {
  const value = event.name in doc.hooks ? doc.hooks[event.name] : [];
  if (!Array.isArray(value)) {
    throw new InstallerError(
      `${doc.file} has a hooks.${event.name} value that is not a list; it was not changed.`,
    );
  }
  return value;
}

/** Reads the hook file and every event in `events`, refusing before any change. */
function readEvents(
  ctx: Context,
  harness: Harness,
  events: readonly HookEvent[],
): { doc: HookDocument; arrays: Map<HookEvent, unknown[]> } {
  const doc = readHookDocument(harness.hookPath(ctx), harness);
  const arrays = new Map<HookEvent, unknown[]>();
  for (const event of events) arrays.set(event, eventArray(doc, event));
  return { doc, arrays };
}

function handlersOf(group: unknown): unknown[] | undefined {
  return isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
}

function commandOf(handler: unknown): string | undefined {
  return isPlainObject(handler) && typeof handler.command === "string"
    ? handler.command
    : undefined;
}

function isOwned(handler: unknown, harness: Harness, event: HookEvent): boolean {
  const command = commandOf(handler);
  return command !== undefined && isInstallerCommand(command, harness.id, event.id);
}

function serialize(doc: HookDocument, changed: ReadonlyMap<HookEvent, unknown[]>): string {
  const hooks: JsonObject = { ...doc.hooks };
  for (const [event, value] of changed) hooks[event.name] = value;
  const data: JsonObject = { ...doc.data, hooks };
  return `${JSON.stringify(data, null, doc.indent)}\n`;
}

/**
 * Throws when the harness's hook file, or any event the installer writes in
 * it, would be refused; used before sign-in and before any hook is written.
 */
export function checkHookFile(ctx: Context, harness: Harness): void {
  if (harness.hookFormat === "named-hook") {
    readNamedHook(ctx, harness);
    return;
  }
  readEvents(ctx, harness, hookEvents(harness));
}

/** Returns the event's array with the installer's hook written as `command`. */
function withHook(
  harness: Harness,
  event: HookEvent,
  current: readonly unknown[],
  command: string,
): unknown[] {
  let found = false;
  let next: unknown[];
  if (harness.hookFormat === "cursor") {
    next = current.map((entry) => {
      if (!isOwned(entry, harness, event)) return entry;
      found = true;
      return { ...(entry as JsonObject), command, ...event.fields };
    });
    if (!found) next.push({ command, ...event.fields });
  } else {
    next = current.map((group) => {
      const handlers = handlersOf(group);
      if (!handlers?.some((handler) => isOwned(handler, harness, event))) return group;
      found = true;
      return {
        ...(group as JsonObject),
        hooks: handlers.map((handler) =>
          isOwned(handler, harness, event)
            ? { ...(handler as JsonObject), type: "command", command, ...event.fields }
            : handler,
        ),
      };
    });
    if (!found) {
      const handler = { type: "command", command, ...event.fields };
      next.push(
        event.matcher === undefined
          ? { hooks: [handler] }
          : { matcher: event.matcher, hooks: [handler] },
      );
    }
  }
  return next;
}

/**
 * Writes every hook the installer owns for `harness`, each with the command
 * `commandFor` returns for its event. Every event is read and checked before
 * anything changes. An installer entry is replaced in place, so its group
 * keeps its position, and its required fields are set again; a new group
 * (Claude Code, Codex) or entry (Cursor) is appended only when none exists.
 * Every other key, group, and hook is kept. The file is backed up once per
 * run and written once. Returns whether the file changed.
 */
export function writeHooks(
  ctx: Context,
  harness: Harness,
  commandFor: (event: HookEvent) => string,
  backups: BackupRegistry,
): boolean {
  if (harness.hookFormat === "named-hook") return writeNamedHook(ctx, harness, commandFor, backups);
  const { doc, arrays } = readEvents(ctx, harness, hookEvents(harness));
  const changed = new Map<HookEvent, unknown[]>();
  for (const [event, current] of arrays) {
    changed.set(event, withHook(harness, event, current, commandFor(event)));
  }
  const text = serialize(doc, changed);
  if (text === doc.text) return false;
  backups.backupOnce(doc.file);
  writeFileAtomic(doc.file, text);
  return true;
}

/** What the hook file holds for one of the installer's hooks. */
export type HookLookup =
  | { kind: "found"; command: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

/**
 * Looks up the installer's hook for each event in `events`. Throws when the
 * hook file cannot be read; an event whose value cannot be read is reported
 * as unreadable on its own.
 */
export function findHooks(
  ctx: Context,
  harness: Harness,
  events: readonly HookEvent[],
): Map<HookEventId, HookLookup> {
  if (harness.hookFormat === "named-hook") return findNamedHooks(ctx, harness, events);
  const doc = readHookDocument(harness.hookPath(ctx), harness);
  const found = new Map<HookEventId, HookLookup>();
  for (const event of events) {
    if (doc.text === undefined) {
      found.set(event.id, { kind: "missing" });
      continue;
    }
    let array: unknown[];
    try {
      array = eventArray(doc, event);
    } catch (error) {
      found.set(event.id, {
        kind: "unreadable",
        reason: error instanceof InstallerError ? error.message : String(error),
      });
      continue;
    }
    const entries =
      harness.hookFormat === "cursor" ? array : array.flatMap((g) => handlersOf(g) ?? []);
    const command = commandOf(entries.find((entry) => isOwned(entry, harness, event)));
    found.set(event.id, command === undefined ? { kind: "missing" } : { kind: "found", command });
  }
  return found;
}

export interface HookRemoval {
  /** The hook file's text without the installer's hooks. */
  text: string;
  /** The hook file's text as read, which a failed uninstall restores. */
  original: string;
  /** The events the file held an installer hook in. */
  removed: HookEventId[];
  /**
   * Hooks whose position changes, as `"<keyName>:<group>:<handler>"` before
   * and after the removal. Codex keys a hook by its event and position, so
   * these keys change. The event keeps a position in one event from being
   * taken for the same position in another.
   */
  moved: Map<string, string>;
}

/**
 * Plans the removal of the installer's hooks for `events`, from one reading of
 * the hook file, and of each group that then holds no other hook. Returns
 * undefined when the file holds none of those hooks.
 */
export function planHookRemoval(
  ctx: Context,
  harness: Harness,
  events: readonly HookEvent[],
): HookRemoval | undefined {
  if (harness.hookFormat === "named-hook") return planNamedHookRemoval(ctx, harness, events);
  const { doc, arrays } = readEvents(ctx, harness, events);
  if (doc.text === undefined) return undefined;
  const moved = new Map<string, string>();
  const changed = new Map<HookEvent, unknown[]>();
  const removed: HookEventId[] = [];
  for (const [event, current] of arrays) {
    let next: unknown[];
    let removedHere = false;
    if (harness.hookFormat === "cursor") {
      next = current.filter((entry) => !isOwned(entry, harness, event));
      removedHere = next.length !== current.length;
    } else {
      const kept: unknown[] = [];
      current.forEach((group, index) => {
        const handlers = handlersOf(group);
        const keptHandlers: unknown[] = [];
        handlers?.forEach((handler, position) => {
          if (isOwned(handler, harness, event)) {
            removedHere = true;
            return;
          }
          if (index !== kept.length || position !== keptHandlers.length) {
            moved.set(
              `${event.keyName}:${index}:${position}`,
              `${event.keyName}:${kept.length}:${keptHandlers.length}`,
            );
          }
          keptHandlers.push(handler);
        });
        if (!handlers || keptHandlers.length === handlers.length) {
          kept.push(group);
        } else if (keptHandlers.length > 0) {
          kept.push({ ...(group as JsonObject), hooks: keptHandlers });
        }
      });
      next = kept;
    }
    // An event the installer has no hook in keeps its value, or its absence.
    if (removedHere) {
      removed.push(event.id);
      changed.set(event, next);
    }
  }
  if (removed.length === 0) return undefined;
  return { text: serialize(doc, changed), original: doc.text, removed, moved };
}

// ---------------------------------------------------------------------------
// Antigravity: `~/.gemini/config/hooks.json` holds named hook objects at its
// top level. The installer owns the object `agentdesk`, whose `SessionStart`
// and `Stop` each hold one handler (component-installer §Standing guidance and
// §Resume hooks; DEC-24(1)-(3)).

/** The top-level key of the named hook object the installer owns. */
export const NAMED_HOOK = "agentdesk";

interface NamedHookDocument {
  file: string;
  /** The parsed file, or a new document when the file does not exist. */
  data: JsonObject;
  indent: string;
  /** The file's text, or undefined when it does not exist. */
  text: string | undefined;
  /** The `agentdesk` object, or undefined when the file holds none. */
  owned: JsonObject | undefined;
}

/**
 * Reads the named hook file and checks the `agentdesk` object. The file is
 * refused, and the caller changes nothing, when it cannot be read or parsed,
 * when its top-level value or its `agentdesk` value is not an object, when an
 * event value in `agentdesk` is not a list, or when `agentdesk` holds a
 * handler other than the installer's own command for that event. An absent
 * `agentdesk` key is free for the installer to write; an empty file counts as
 * an object with no hooks.
 */
function readNamedHook(ctx: Context, harness: Harness): NamedHookDocument {
  const file = harness.hookPath(ctx);
  // A linked hooks.json, backup, or temporary file, or a redirected parent,
  // is refused before any read.
  assertConfinedFile(ctx, harness, file);
  const current = readJsonFile(file);
  const data: JsonObject = current?.data ?? {};
  const doc: NamedHookDocument = {
    file,
    data,
    indent: current?.indent ?? "  ",
    text: current?.text,
    owned: undefined,
  };
  if (!(NAMED_HOOK in data)) return doc;
  const owned = data[NAMED_HOOK];
  if (!isPlainObject(owned)) {
    throw new InstallerError(
      `${file} has an ${NAMED_HOOK} hook that is not an object; it was not changed.`,
    );
  }
  const events = hookEvents(harness);
  for (const [name, handlers] of Object.entries(owned)) {
    if (!Array.isArray(handlers)) {
      throw new InstallerError(
        `${file} has an ${NAMED_HOOK}.${name} value that is not a list; it was not changed.`,
      );
    }
    const event = events.find((e) => e.name === name);
    if (event === undefined) {
      throw new InstallerError(
        `${file} has an ${NAMED_HOOK}.${name} value, which AgentDesk does not write; it was not changed. Move it to a hook with another name, then run again.`,
      );
    }
    for (const handler of handlers) {
      if (!isOwnedNamedHandler(handler, harness, event)) {
        throw new InstallerError(
          `${file} has a handler in its ${NAMED_HOOK} hook that is not exactly the handler AgentDesk writes; it was not changed. Move that handler to a hook with another name, or remove it, then run again.`,
        );
      }
    }
  }
  doc.owned = owned;
  return doc;
}

/**
 * Whether `handler` is exactly the handler the installer writes for `event`:
 * an object whose keys are `type`, `command`, and the event's fields and
 * nothing else, with `"type": "command"`, the installer's command for this
 * harness and event (from any executable path, so an older install's handler
 * is replaced), and each field's exact value, such as `"timeout": 30`. Any
 * other handler, a missing, extra, or differently typed key included, is not
 * owned, so the file is refused before setup or removal.
 */
function isOwnedNamedHandler(handler: unknown, harness: Harness, event: HookEvent): boolean {
  if (!isPlainObject(handler)) return false;
  const expected = ["type", "command", ...Object.keys(event.fields)].sort();
  const actual = Object.keys(handler).sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    return false;
  }
  if (handler.type !== "command" || !isOwned(handler, harness, event)) return false;
  return Object.entries(event.fields).every(([key, value]) => Object.is(handler[key], value));
}

function serializeNamed(doc: NamedHookDocument, owned: JsonObject | undefined): string {
  const data: JsonObject = { ...doc.data };
  if (owned === undefined) delete data[NAMED_HOOK];
  else data[NAMED_HOOK] = owned;
  return `${JSON.stringify(data, null, doc.indent)}\n`;
}

/**
 * Writes the `agentdesk` object with one handler per event the installer
 * writes. An existing object is replaced at its key, so it keeps its
 * position; every other named hook and key is kept. Returns whether the file
 * changed.
 */
function writeNamedHook(
  ctx: Context,
  harness: Harness,
  commandFor: (event: HookEvent) => string,
  backups: BackupRegistry,
): boolean {
  const doc = readNamedHook(ctx, harness);
  const owned: JsonObject = {};
  for (const event of hookEvents(harness)) {
    owned[event.name] = [{ type: "command", command: commandFor(event), ...event.fields }];
  }
  const text = serializeNamed(doc, owned);
  if (text === doc.text) return false;
  backups.backupOnce(doc.file, true);
  writeFileAtomic(doc.file, text, 0o600, true);
  return true;
}

function ownedHandler(
  doc: NamedHookDocument,
  harness: Harness,
  event: HookEvent,
): string | undefined {
  const handlers = doc.owned?.[event.name];
  if (!Array.isArray(handlers)) return undefined;
  return commandOf(handlers.find((handler) => isOwnedNamedHandler(handler, harness, event)));
}

function findNamedHooks(
  ctx: Context,
  harness: Harness,
  events: readonly HookEvent[],
): Map<HookEventId, HookLookup> {
  const doc = readNamedHook(ctx, harness);
  const found = new Map<HookEventId, HookLookup>();
  for (const event of events) {
    const command = ownedHandler(doc, harness, event);
    found.set(event.id, command === undefined ? { kind: "missing" } : { kind: "found", command });
  }
  return found;
}

/**
 * Plans the removal of the whole `agentdesk` object. Returns undefined when
 * the file holds no such object. No other hook moves, because Antigravity
 * keys no hook by position.
 */
function planNamedHookRemoval(
  ctx: Context,
  harness: Harness,
  events: readonly HookEvent[],
): HookRemoval | undefined {
  const doc = readNamedHook(ctx, harness);
  if (doc.text === undefined || doc.owned === undefined) return undefined;
  const removed = events
    .filter((event) => ownedHandler(doc, harness, event) !== undefined)
    .map((event) => event.id);
  return { text: serializeNamed(doc, undefined), original: doc.text, removed, moved: new Map() };
}
