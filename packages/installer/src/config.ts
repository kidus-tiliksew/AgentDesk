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
  url?: string;
  token?: string;
}

// ---------------------------------------------------------------------------
// JSON configuration (~/.claude.json fallback and ~/.cursor/mcp.json)

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface JsonFile {
  data: JsonObject;
  indent: string;
}

function readJsonFile(file: string): JsonFile | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  if (text.trim().length === 0) return { data: {}, indent: "  " };
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
  return { data, indent };
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

export function readJsonMcpServer(file: string): McpEntry {
  let current: JsonFile | undefined;
  try {
    current = readJsonFile(file);
  } catch {
    return {};
  }
  if (!current || !isPlainObject(current.data.mcpServers)) return {};
  const entry = current.data.mcpServers[MCP_ENTRY_NAME];
  if (!isPlainObject(entry)) return {};
  const headers = isPlainObject(entry.headers) ? entry.headers : {};
  const result: McpEntry = {};
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
 * Finds the line ranges of `[mcp_servers.agentdesk]` and its subtables. Each
 * range runs from the header to the next other header, minus trailing blank
 * and comment lines, which belong to whatever follows.
 */
function agentdeskRegions(lines: string[]): Region[] {
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
    const isOurs = AGENTDESK_HEADER.test(line);
    if (isOurs && open !== undefined) return; // a subtable inside the open region
    close(index);
    if (isOurs) open = index;
  });
  close(lines.length);
  return regions;
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
  if (!isPlainObject(servers)) return {};
  const entry = servers[MCP_ENTRY_NAME];
  if (!isPlainObject(entry)) return {};
  const result: McpEntry = {};
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
    next = [...lines];
    if (next.length > 0) {
      const lastIndex = next.length - 1;
      const last = next[lastIndex] ?? "";
      if (!last.endsWith("\n")) next[lastIndex] = last + eol;
      if (stripEol(next[lastIndex] ?? "").trim().length > 0) next.push(eol);
    }
    next.push(...table);
  }
  const result = next.join("");
  // The edited text must parse and hold exactly the new entry; otherwise the
  // file defines the entry in a form (inline or dotted keys) lines cannot replace.
  let check: McpEntry = {};
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
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = replaceCodexTable(file, text, server, token);
  backups.backupOnce(file);
  writeFileAtomic(file, next);
}

export function removeCodexEntry(file: string, backups: BackupRegistry): boolean {
  if (!existsSync(file)) return false;
  const next = removeCodexTableText(file, readFileSync(file, "utf8"));
  if (next === undefined) return false;
  backups.backupOnce(file);
  writeFileAtomic(file, next);
  return true;
}

export function readCodexEntry(file: string): McpEntry {
  if (!existsSync(file)) return {};
  try {
    return codexEntryOf(parseToml(readFileSync(file, "utf8")) as Record<string, unknown>);
  } catch {
    return {};
  }
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

export function readMcpEntry(ctx: Context, harness: Harness): McpEntry {
  const file = harness.configPath(ctx);
  return harness.configFormat === "codex-toml" ? readCodexEntry(file) : readJsonMcpServer(file);
}

/** Removes the harness's agentdesk MCP entry; returns whether one was removed. */
export async function removeMcpEntry(
  ctx: Context,
  harness: Harness,
  backups: BackupRegistry,
): Promise<boolean> {
  const file = harness.configPath(ctx);
  switch (harness.configFormat) {
    case "claude": {
      const cli = findExecutable(ctx, "claude");
      let removed = false;
      if (cli) {
        backups.backupOnce(file);
        removed =
          (await runClaude(ctx, cli, ["mcp", "remove", "--scope", "user", MCP_ENTRY_NAME])) === 0;
      }
      // Without the CLI, or when the CLI left the entry, edit the file directly.
      if (
        readJsonMcpServer(file).url !== undefined ||
        readJsonMcpServer(file).token !== undefined
      ) {
        removed = removeJsonMcpServer(file, backups) || removed;
      }
      return removed;
    }
    case "codex-toml":
      return removeCodexEntry(file, backups);
    case "cursor-json":
      return removeJsonMcpServer(file, backups);
  }
}
