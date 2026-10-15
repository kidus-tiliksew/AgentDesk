import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type Context, InstallerError } from "./context.js";
import { BACKUP_SUFFIX, MCP_ENTRY_NAME } from "./defaults.js";
import { findExecutable, type Harness } from "./harnesses.js";

/**
 * Copies each file to `<file>.agentdesk-backup` before its first edit in a run
 * and never again in that run, so a backup never holds a token this run wrote
 * (component-installer §Harnesses).
 */
export class BackupRegistry {
  private readonly seen = new Set<string>();

  backupOnce(file: string): void {
    if (this.seen.has(file)) return;
    this.seen.add(file);
    if (!existsSync(file)) return;
    copyFileSync(file, file + BACKUP_SUFFIX);
  }
}

/**
 * Writes through a temporary file and a rename in the same directory. An
 * existing file keeps its mode; a new file gets `newFileMode`. A symlinked
 * configuration file is written at its target so the link survives.
 */
export function writeFileAtomic(file: string, content: string, newFileMode = 0o600): void {
  let target = file;
  let mode = newFileMode;
  if (existsSync(file)) {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.agentdesk-tmp-${process.pid}`;
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

function tokenFromHeader(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(value.trim());
  return match?.[1];
}

export function mcpUrl(server: string): string {
  return `${server}/mcp`;
}

export interface McpEntry {
  /** Whether the configuration holds an agentdesk entry at all. */
  present: boolean;
  url?: string;
  token?: string;
}

// ---------------------------------------------------------------------------
// JSON configuration (~/.claude.json fallback and ~/.cursor/mcp.json)

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface JsonFile {
  data: JsonObject;
  indent: string;
  /** The file's text as read. */
  text: string;
}

/** Reads a file as UTF-8; a read failure is an InstallerError, never confirmed absence. */
export function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new InstallerError(`${file} could not be read; it was not changed.`);
  }
}

export function readJsonFile(file: string): JsonFile | undefined {
  if (!existsSync(file)) return undefined;
  const text = readText(file);
  if (text.trim().length === 0) return { data: {}, indent: "  ", text };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstallerError(
      `${file} is not valid JSON. Fix or move it, then run again; it was not changed.`,
    );
  }
  if (!isPlainObject(data)) {
    throw new InstallerError(
      `${file} does not hold a JSON object. Fix or move it, then run again; it was not changed.`,
    );
  }
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return { data, indent, text };
}

function mcpServersOf(file: string, data: JsonObject): JsonObject {
  const servers = data.mcpServers;
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) {
    throw new InstallerError(
      `${file} has an mcpServers value that is not an object; it was not changed.`,
    );
  }
  return servers;
}

/** Sets `mcpServers.agentdesk` and keeps every other key. */
export function setJsonMcpServer(file: string, entry: JsonObject, backups: BackupRegistry): void {
  const current = readJsonFile(file) ?? { data: {}, indent: "  " };
  const servers = mcpServersOf(file, current.data);
  const next: JsonObject = { ...current.data, mcpServers: { ...servers, [MCP_ENTRY_NAME]: entry } };
  backups.backupOnce(file);
  writeFileAtomic(file, `${JSON.stringify(next, null, current.indent)}\n`);
}

/** Removes `mcpServers.agentdesk`; returns whether an entry was removed. */
export function removeJsonMcpServer(file: string, backups: BackupRegistry): boolean {
  const current = readJsonFile(file);
  if (!current) return false;
  const servers = mcpServersOf(file, current.data);
  if (!(MCP_ENTRY_NAME in servers)) return false;
  const { [MCP_ENTRY_NAME]: _removed, ...rest } = servers;
  const next: JsonObject = { ...current.data, mcpServers: rest };
  backups.backupOnce(file);
  writeFileAtomic(file, `${JSON.stringify(next, null, current.indent)}\n`);
  return true;
}

/**
 * Reads `mcpServers.agentdesk`. A missing file or entry is `{present: false}`;
 * an unreadable or malformed file throws, so callers never mistake it for
 * absence.
 */
export function readJsonMcpServer(file: string): McpEntry {
  const current = readJsonFile(file);
  if (!current) return { present: false };
  const servers = mcpServersOf(file, current.data);
  if (!(MCP_ENTRY_NAME in servers)) return { present: false };
  const entry = servers[MCP_ENTRY_NAME];
  if (!isPlainObject(entry)) return { present: true };
  const headers = isPlainObject(entry.headers) ? entry.headers : {};
  const result: McpEntry = { present: true };
  if (typeof entry.url === "string") result.url = entry.url;
  const token = tokenFromHeader(headers.Authorization);
  if (token) result.token = token;
  return result;
}

// ---------------------------------------------------------------------------
// Codex config.toml: replace only the [mcp_servers.agentdesk] table's lines.

const AGENTDESK_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:agentdesk|"agentdesk"|'agentdesk')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;

/** Splits text into lines that keep their own terminators. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

interface Region {
  start: number;
  end: number;
}

/**
 * Finds the line ranges of the tables whose header line `isTarget` accepts,
 * with their subtables. Each range runs from the header to the next other
 * header, minus trailing blank and comment lines, which belong to whatever
 * follows.
 */
function tableRegions(lines: string[], isTarget: (header: string) => boolean): Region[] {
  const regions: Region[] = [];
  let inMultiline: string | undefined;
  let open: number | undefined;
  const close = (endExclusive: number) => {
    if (open === undefined) return;
    let end = endExclusive;
    while (end > open + 1 && BLANK_OR_COMMENT.test(stripEol(lines[end - 1] ?? ""))) end--;
    regions.push({ start: open, end });
    open = undefined;
  };
  lines.forEach((raw, index) => {
    const line = stripEol(raw);
    if (inMultiline) {
      if (line.includes(inMultiline)) inMultiline = undefined;
      return;
    }
    const delimiterMatch = /("""|''')/.exec(line);
    if (delimiterMatch) {
      const delim = delimiterMatch[1] as string;
      const after = line.slice((delimiterMatch.index ?? 0) + 3);
      if (!after.includes(delim)) inMultiline = delim;
    }
    if (!ANY_HEADER.test(line)) return;
    const isOurs = isTarget(line);
    if (isOurs && open !== undefined) return; // a subtable inside the open region
    close(index);
    if (isOurs) open = index;
  });
  close(lines.length);
  return regions;
}

/** The line ranges of `[mcp_servers.agentdesk]` and its subtables. */
function agentdeskRegions(lines: string[]): Region[] {
  return tableRegions(lines, (line) => AGENTDESK_HEADER.test(line));
}

/** Appends `table` after a blank separator line. */
function appendTable(lines: readonly string[], table: readonly string[], eol: string): string[] {
  const next = [...lines];
  if (next.length > 0) {
    const lastIndex = next.length - 1;
    const last = next[lastIndex] ?? "";
    if (!last.endsWith("\n")) next[lastIndex] = last + eol;
    if (stripEol(next[lastIndex] ?? "").trim().length > 0) next.push(eol);
  }
  next.push(...table);
  return next;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexTableLines(server: string, token: string, eol: string): string[] {
  return [
    `[mcp_servers.${MCP_ENTRY_NAME}]${eol}`,
    `url = ${tomlString(mcpUrl(server))}${eol}`,
    `http_headers = { "Authorization" = ${tomlString(bearer(token))} }${eol}`,
  ];
}

function parseCodex(file: string, text: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    throw new InstallerError(
      `${file} is not valid TOML. Fix or move it, then run again; it was not changed.`,
    );
  }
}

function codexEntryOf(data: Record<string, unknown>): McpEntry {
  const servers = data.mcp_servers;
  if (!isPlainObject(servers) || !(MCP_ENTRY_NAME in servers)) return { present: false };
  const entry = servers[MCP_ENTRY_NAME];
  if (!isPlainObject(entry)) return { present: true };
  const result: McpEntry = { present: true };
  if (typeof entry.url === "string") result.url = entry.url;
  const headers = isPlainObject(entry.http_headers) ? entry.http_headers : {};
  const token = tokenFromHeader(headers.Authorization);
  if (token) result.token = token;
  return result;
}

/** Returns the new config.toml text with the agentdesk table set. */
export function replaceCodexTable(
  file: string,
  text: string,
  server: string,
  token: string,
): string {
  parseCodex(file, text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  const regions = agentdeskRegions(lines);
  const table = codexTableLines(server, token, eol);
  let next: string[];
  const first = regions[0];
  if (first) {
    next = [...lines];
    for (const region of [...regions].reverse()) {
      const replacement = region === first ? table : [];
      // A region that ends at the end of a file without a final newline keeps that shape.
      const last = next[region.end - 1] ?? "";
      if (replacement.length > 0 && !last.endsWith("\n")) {
        const lastIndex = replacement.length - 1;
        replacement[lastIndex] = stripEol(replacement[lastIndex] ?? "");
      }
      next.splice(region.start, region.end - region.start, ...replacement);
    }
  } else {
    next = appendTable(lines, table, eol);
  }
  const result = next.join("");
  // The edited text must parse and hold exactly the new entry; otherwise the
  // file defines the entry in a form (inline or dotted keys) lines cannot replace.
  let check: McpEntry = { present: false };
  try {
    check = codexEntryOf(parseToml(result) as Record<string, unknown>);
  } catch {
    // fall through to the refusal
  }
  if (check.url !== mcpUrl(server) || check.token !== token) {
    throw new InstallerError(
      `${file} defines mcp_servers.agentdesk in a form the installer cannot replace. Remove that definition, then run again; it was not changed.`,
    );
  }
  return result;
}

/** Returns the config.toml text without the agentdesk table, or undefined when absent. */
export function removeCodexTableText(file: string, text: string): string | undefined {
  const lines = splitLines(text);
  const regions = agentdeskRegions(lines);
  if (regions.length === 0) return undefined;
  const next = [...lines];
  for (const region of [...regions].reverse()) {
    let start = region.start;
    // Drop the blank separator the installer added before an appended table.
    if (region.end >= next.length && start > 0 && stripEol(next[start - 1] ?? "").trim() === "") {
      start--;
    }
    next.splice(start, region.end - start);
  }
  const result = next.join("");
  try {
    parseToml(result);
  } catch {
    throw new InstallerError(`${file} could not be edited safely; it was not changed.`);
  }
  return result;
}

export function setCodexEntry(
  file: string,
  server: string,
  token: string,
  backups: BackupRegistry,
): void {
  const text = existsSync(file) ? readText(file) : "";
  const next = replaceCodexTable(file, text, server, token);
  backups.backupOnce(file);
  writeFileAtomic(file, next);
}

export function removeCodexEntry(file: string, backups: BackupRegistry): boolean {
  if (!existsSync(file)) return false;
  const text = readText(file);
  // A file that does not parse cannot confirm the entry is absent.
  parseCodex(file, text);
  const next = removeCodexTableText(file, text);
  if (next === undefined) {
    if (codexEntryOf(parseCodex(file, text)).present) {
      throw new InstallerError(
        `${file} defines mcp_servers.agentdesk in a form the installer cannot remove; it was not changed.`,
      );
    }
    return false;
  }
  backups.backupOnce(file);
  writeFileAtomic(file, next);
  return true;
}

/** Reads the Codex entry; an unreadable or malformed file throws. */
export function readCodexEntry(file: string): McpEntry {
  if (!existsSync(file)) return { present: false };
  return codexEntryOf(parseCodex(file, readText(file)));
}

// ---------------------------------------------------------------------------
// Codex hook trust: replace only the lines of `[hooks.state."<key>"]` tables.

/** The key path of a table header line, such as ["hooks", "state", "<key>"]. */
function headerPath(line: string): string[] | undefined {
  let node: unknown;
  try {
    node = parseToml(line);
  } catch {
    return undefined;
  }
  const path: string[] = [];
  while (isPlainObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) return path.length > 0 ? path : undefined;
    if (keys.length !== 1) return undefined;
    const key = keys[0] as string;
    path.push(key);
    node = node[key];
  }
  // An array of tables, such as [[hooks.state."<key>"]], is never a target.
  return undefined;
}

function isTrustHeader(key: string): (line: string) => boolean {
  return (line) => {
    const path = headerPath(line);
    return path !== undefined && path[0] === "hooks" && path[1] === "state" && path[2] === key;
  };
}

/**
 * Replaces the first region `isTarget` finds with `table` and removes the
 * others, or appends `table` when there is none. An empty `table` removes
 * every region.
 */
function setRegions(
  lines: readonly string[],
  isTarget: (line: string) => boolean,
  table: readonly string[],
  eol: string,
): string[] {
  const regions = tableRegions([...lines], isTarget);
  const first = regions[0];
  if (!first) return table.length > 0 ? appendTable(lines, table, eol) : [...lines];
  const next = [...lines];
  for (const region of [...regions].reverse()) {
    const replacement = region === first ? [...table] : [];
    let start = region.start;
    if (replacement.length === 0) {
      // Drop the blank separator the installer added before an appended table.
      if (region.end >= next.length && start > 0 && stripEol(next[start - 1] ?? "").trim() === "") {
        start--;
      }
    } else if (!(next[region.end - 1] ?? "").endsWith("\n")) {
      // A region that ends at the end of a file without a final newline keeps that shape.
      const lastIndex = replacement.length - 1;
      replacement[lastIndex] = stripEol(replacement[lastIndex] ?? "");
    }
    next.splice(start, region.end - start, ...replacement);
  }
  return next;
}

function hooksStateOf(data: Record<string, unknown>): Record<string, unknown> {
  const hooks = data.hooks;
  if (!isPlainObject(hooks) || !isPlainObject(hooks.state)) return {};
  return hooks.state;
}

/**
 * Returns config.toml text with `[hooks.state."<key>"] trusted_hash` set for
 * each entry of `trust` and the table of each key in `remove` deleted. Only
 * those tables' lines change. The result must parse and hold exactly those
 * values; otherwise the file defines them in a form lines cannot replace, and
 * it is refused unchanged (component-installer §Codex trust).
 */
export function editCodexTrust(
  file: string,
  text: string,
  trust: ReadonlyMap<string, string>,
  remove: readonly string[],
): string {
  parseCodex(file, text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = splitLines(text);
  // Tables are removed from the end of the file backwards, so each one
  // removed is last when its turn comes and takes the blank line the
  // installer added before it, as a single removal does.
  const removals = remove
    .filter((key) => !trust.has(key))
    .map((key) => ({ key, start: tableRegions(lines, isTrustHeader(key))[0]?.start ?? -1 }))
    .sort((a, b) => b.start - a.start);
  for (const { key } of removals) {
    lines = setRegions(lines, isTrustHeader(key), [], eol);
  }
  for (const [key, hash] of trust) {
    const table = [
      `[hooks.state.${tomlString(key)}]${eol}`,
      `trusted_hash = ${tomlString(hash)}${eol}`,
    ];
    lines = setRegions(lines, isTrustHeader(key), table, eol);
  }
  const result = lines.join("");
  let state: Record<string, unknown> | undefined;
  try {
    state = hooksStateOf(parseToml(result) as Record<string, unknown>);
  } catch {
    // fall through to the refusal
  }
  const holds = (key: string, hash: string) => {
    const table = state?.[key];
    return isPlainObject(table) && Object.keys(table).length === 1 && table.trusted_hash === hash;
  };
  if (
    !state ||
    ![...trust].every(([key, hash]) => holds(key, hash)) ||
    !remove.every((key) => trust.has(key) || state?.[key] === undefined)
  ) {
    throw new InstallerError(
      `${file} defines hooks.state for the AgentDesk hook in a form the installer cannot replace; it was not changed.`,
    );
  }
  return result;
}

/**
 * Sets and removes `[hooks.state."<key>"]` tables in config.toml. Returns
 * whether the file changed; unchanged text is not rewritten.
 */
export function applyCodexTrust(
  file: string,
  trust: ReadonlyMap<string, string>,
  remove: readonly string[],
  backups: BackupRegistry,
): boolean {
  const exists = existsSync(file);
  if (!exists && trust.size === 0) return false;
  const text = exists ? readText(file) : "";
  const next = editCodexTrust(file, text, trust, remove);
  if (next === text) return false;
  backups.backupOnce(file);
  writeFileAtomic(file, next);
  return true;
}

// ---------------------------------------------------------------------------
// Harness-level operations

async function runClaude(ctx: Context, cli: string, args: readonly string[]): Promise<number> {
  try {
    const result = await ctx.run(cli, args);
    return result.code;
  } catch {
    // The runner's error can carry the command line, which holds the header.
    throw new InstallerError(`Could not run ${basename(cli)}.`);
  }
}

/**
 * Writes the harness's agentdesk MCP entry for `server` with `token`
 * (component-installer §Harnesses; DEC-6). Subprocess output is never shown,
 * because Claude Code can echo the header it was given.
 */
export async function writeMcpEntry(
  ctx: Context,
  harness: Harness,
  server: string,
  token: string,
  backups: BackupRegistry,
): Promise<void> {
  const file = harness.configPath(ctx);
  switch (harness.configFormat) {
    case "claude": {
      const cli = findExecutable(ctx, "claude");
      if (!cli) {
        setJsonMcpServer(
          file,
          { type: "http", url: mcpUrl(server), headers: { Authorization: bearer(token) } },
          backups,
        );
        return;
      }
      backups.backupOnce(file);
      await runClaude(ctx, cli, ["mcp", "remove", "--scope", "user", MCP_ENTRY_NAME]);
      const code = await runClaude(ctx, cli, [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        MCP_ENTRY_NAME,
        mcpUrl(server),
        "--header",
        `Authorization: ${bearer(token)}`,
      ]);
      if (code !== 0) throw new InstallerError(`claude mcp add exited with status ${code}.`);
      return;
    }
    case "codex-toml":
      setCodexEntry(file, server, token, backups);
      return;
    case "cursor-json":
      setJsonMcpServer(
        file,
        { url: mcpUrl(server), headers: { Authorization: bearer(token) } },
        backups,
      );
      return;
  }
}

/** Reads the harness's agentdesk entry; throws when the configuration cannot be read or parsed. */
export function readMcpEntry(ctx: Context, harness: Harness): McpEntry {
  const file = harness.configPath(ctx);
  return harness.configFormat === "codex-toml" ? readCodexEntry(file) : readJsonMcpServer(file);
}

/**
 * Removes the harness's agentdesk MCP entry. Returns whether an entry was
 * removed; throws when the entry may remain, so a failed removal is never
 * reported as done (AC-9.6).
 */
export async function removeMcpEntry(
  ctx: Context,
  harness: Harness,
  backups: BackupRegistry,
): Promise<boolean> {
  const file = harness.configPath(ctx);
  switch (harness.configFormat) {
    case "claude": {
      // Reading first refuses an unreadable or malformed file before any change.
      if (!readJsonMcpServer(file).present) return false;
      const cli = findExecutable(ctx, "claude");
      if (cli) {
        backups.backupOnce(file);
        const code = await runClaude(ctx, cli, [
          "mcp",
          "remove",
          "--scope",
          "user",
          MCP_ENTRY_NAME,
        ]);
        let after: McpEntry;
        try {
          after = readJsonMcpServer(file);
        } catch (error) {
          const detail =
            error instanceof InstallerError ? error.message : `${file} could not be read.`;
          throw new InstallerError(
            code === 0 ? detail : `claude mcp remove exited with status ${code}. ${detail}`,
          );
        }
        if (!after.present) return true;
      }
      // Without the CLI, or when the CLI left the entry, edit the file directly.
      if (!removeJsonMcpServer(file, backups)) return false;
      if (readJsonMcpServer(file).present) {
        throw new InstallerError(`The agentdesk entry is still in ${file}.`);
      }
      return true;
    }
    case "codex-toml":
      return removeCodexEntry(file, backups);
    case "cursor-json":
      return removeJsonMcpServer(file, backups);
  }
}
