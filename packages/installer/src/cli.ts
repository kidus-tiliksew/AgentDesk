import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  FORGET_UNREVOKED_FLAG,
  forget,
  install,
  skillInstall,
  status,
  uninstall,
} from "./commands.js";
import {
  type Context,
  InstallerError,
  type Io,
  type Runner,
  redactingIo,
  TerminalReadError,
} from "./context.js";
import {
  DEFAULT_SERVER_ORIGIN,
  EMBEDDED_GUIDANCE,
  EMBEDDED_SKILL,
  INSTALLER_VERSION,
} from "./defaults.js";
import { printContext, runningExecutable } from "./guidance.js";
import { HARNESS_IDS, HARNESSES, type HarnessId, harnessById, isHarnessId } from "./harnesses.js";
import { readStream } from "./install-key.js";
import { parseHookArgs, parseWaitArgs, runHook, runWait } from "./resume/commands.js";

export const USAGE = `Usage: agentdesk <command>

Commands:
  install [--server <url>] [--only <harnesses>] [--yes] [--key-file <path>]
                     Detect Claude Code, Codex, and Cursor, sign each in with a
                     short code approved in the AgentDesk app, or with an
                     install key, and install the MCP connection, the skill,
                     the session-start hook, and the resume hooks.
  skill install      Install or update only the skill, the session-start hook,
                     and the resume hooks for every detected harness.
  context --harness <id>
                     Print the AgentDesk guidance a session starts with; the
                     session-start hook runs this.
  wait --harness <id> [--codex-thread <thread>] <decision-id>
                     Wait on one decision and resume its agent session when it
                     settles outside the chat.
  hook <event> --harness <id>
                     Run a resume hook: stop for Codex and Cursor, after-mcp
                     for Cursor. The installer's hooks run this.
  status             Show each recorded harness, its connection, its skill
                     version, and its hooks.
  forget <connection-id>
                     Forget a connection the installer could not revoke, after
                     you revoked it in the AgentDesk app under Settings →
                     Connections. The installation stays in place.
  uninstall [--forget-unrevoked]
                     Revoke each connection and remove what the installer wrote.
                     --forget-unrevoked forgets every connection the installer
                     could not revoke, after you revoked each in the AgentDesk
                     app under Settings → Connections.

Options for install:
  --server <url>     Use this AgentDesk server instead of the default.
  --only <ids>       Comma-separated harnesses: ${HARNESS_IDS.join(", ")}.
  --yes, -y          Keep every detected harness without asking.
  --key-file <path>  Connect with the install key in this file instead of a
                     short code, so nothing waits for approval. Use - to read
                     the key from standard input.

The installer never opens a browser and never asks you to paste a credential.`;

function parseOnly(values: readonly string[] | undefined): HarnessId[] | undefined {
  if (!values) return undefined;
  const ids: HarnessId[] = [];
  for (const value of values.flatMap((v) => v.split(","))) {
    const id = value.trim();
    if (id.length === 0) continue;
    if (!isHarnessId(id)) {
      throw new InstallerError(
        `Unknown harness ${JSON.stringify(id)}. Use ${HARNESS_IDS.join(", ")}.`,
        2,
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new InstallerError("--only needs at least one harness.", 2);
  return ids;
}

function usageError(error: unknown): InstallerError {
  const detail = error instanceof Error ? error.message : String(error);
  return new InstallerError(`${detail}\n\n${USAGE}`, 2);
}

/** Parses `argv` (without the node and script paths) and runs one command. */
export async function runCli(argv: readonly string[], ctx: Context): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      ctx.io.out(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (command === "--version" || command === "-v") {
      ctx.io.out(INSTALLER_VERSION);
      return 0;
    }
    switch (command) {
      case "install": {
        let parsed: ReturnType<typeof parseInstall>;
        try {
          parsed = parseInstall(rest);
        } catch (error) {
          throw usageError(error);
        }
        const only = parseOnly(parsed.values.only);
        return await install(ctx, {
          yes: parsed.values.yes ?? false,
          ...(parsed.values.server !== undefined ? { server: parsed.values.server } : {}),
          ...(only ? { only } : {}),
          ...(parsed.values["key-file"] !== undefined
            ? { keyFile: parsed.values["key-file"] }
            : {}),
        });
      }
      case "skill": {
        if (rest.length !== 1 || rest[0] !== "install")
          throw usageError("Use: agentdesk skill install");
        return await skillInstall(ctx);
      }
      case "context": {
        let harness: string | undefined;
        try {
          harness = parseArgs({
            args: rest,
            strict: true,
            allowPositionals: false,
            options: { harness: { type: "string" } },
          }).values.harness;
        } catch (error) {
          throw usageError(error);
        }
        if (harness === undefined) throw usageError("Use: agentdesk context --harness <id>");
        if (!isHarnessId(harness)) {
          throw usageError(
            `Unknown harness ${JSON.stringify(harness)}. Use ${HARNESS_IDS.join(", ")}.`,
          );
        }
        return printContext(ctx, harnessById(ctx, harness));
      }
      case "wait": {
        let options: ReturnType<typeof parseWaitArgs>;
        try {
          options = parseWaitArgs(rest);
        } catch (error) {
          throw usageError(error);
        }
        return await runWait(ctx, options);
      }
      case "hook": {
        let options: ReturnType<typeof parseHookArgs>;
        try {
          options = parseHookArgs(rest);
        } catch (error) {
          throw usageError(error);
        }
        return await runHook(ctx, options);
      }
      case "status":
        if (rest.length > 0) throw usageError("status takes no arguments.");
        return await status(ctx);
      case "forget": {
        const [connectionId, ...extra] = rest;
        if (!connectionId || extra.length > 0 || connectionId.startsWith("-")) {
          throw usageError("Use: agentdesk forget <connection-id>");
        }
        return await forget(ctx, connectionId);
      }
      case "uninstall": {
        const forgetUnrevoked = rest.length === 1 && rest[0] === FORGET_UNREVOKED_FLAG;
        if (rest.length > 0 && !forgetUnrevoked) {
          throw usageError(`uninstall takes only ${FORGET_UNREVOKED_FLAG}.`);
        }
        return await uninstall(ctx, { forgetUnrevoked });
      }
      default:
        throw usageError(`Unknown command ${JSON.stringify(command)}.`);
    }
  } catch (error) {
    if (error instanceof InstallerError) {
      ctx.io.err(error.message);
      return error.exitCode;
    }
    // Unexpected errors print only their type: their text could hold a path
    // argument or a header value.
    ctx.io.err(
      `agentdesk failed with an unexpected ${error instanceof Error ? error.name : "error"}.`,
    );
    return 1;
  }
}

function parseInstall(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      server: { type: "string" },
      only: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
      "key-file": { type: "string" },
    },
  });
}

/** Runs a harness CLI with captured output; nothing is forwarded to the terminal. */
export const nodeRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/**
 * Asks one question on `input`. An error on `input`, which readline forwards
 * as its own `error` event, rejects with TerminalReadError instead of escaping
 * as an unhandled error; Bun on macOS raises `EINVAL` from kqueue that way.
 * The question's own rejection, such as Ctrl+C, passes through unchanged.
 */
export function askQuestion(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tty = input as NodeJS.ReadableStream & {
      isRaw?: boolean;
      setRawMode?: (mode: boolean) => unknown;
    };
    // What the input holds before readline attaches its listeners and enters
    // raw mode, so a construction that fails can be undone without an
    // interface to close.
    const listenersBefore = new Map(input.eventNames().map((e) => [e, input.listeners(e)]));
    const wasRaw = Boolean(tty.isRaw);
    const undoConstruction = () => {
      for (const event of input.eventNames()) {
        const before = listenersBefore.get(event) ?? [];
        for (const listener of input.listeners(event)) {
          if (!before.includes(listener)) {
            input.removeListener(event, listener as (...args: unknown[]) => void);
          }
        }
      }
      input.pause();
      if (typeof tty.setRawMode === "function" && Boolean(tty.isRaw) !== wasRaw) {
        tty.setRawMode(wasRaw);
      }
    };

    let rl: Interface | undefined;
    let constructing = true;
    let outcome: (() => void) | undefined;
    const finish = (result: () => void) => {
      input.off("error", onReadError);
      try {
        // Leaving raw mode can fail again on a terminal that failed to read.
        if (rl) rl.close();
        else undoConstruction();
      } catch {
        try {
          undoConstruction();
        } catch {}
      }
      result();
    };
    // The interface keeps its own error listener after this settles: readline
    // may still forward the same input error to it, and an unheard error throws.
    const settle = (result: () => void) => {
      if (outcome) return;
      outcome = result;
      // An error raised while readline is constructed settles first; the
      // cleanup waits until construction has returned or thrown.
      if (!constructing) finish(result);
    };
    function onReadError(error: unknown) {
      settle(() => reject(new TerminalReadError(error)));
    }

    input.on("error", onReadError);
    try {
      rl = createInterface({ input, output });
      rl.on("error", onReadError);
    } catch (error) {
      onReadError(error);
    }
    constructing = false;
    if (outcome) {
      finish(outcome);
      return;
    }
    (rl as Interface).question(question).then(
      (answer) => settle(() => resolve(answer)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/**
 * The interactive prompt on `input` and `output`. After one terminal read
 * error, every later prompt rejects with that error without touching `input`
 * again: the cleanup of a failed construction can leave it unable to prompt.
 */
export function terminalPrompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): (question: string) => Promise<string> {
  let unreadable: TerminalReadError | undefined;
  return async (question) => {
    if (unreadable) throw unreadable;
    try {
      return await askQuestion(input, output, question);
    } catch (error) {
      if (error instanceof TerminalReadError) unreadable = error;
      throw error;
    }
  };
}

/** Builds the context for a real run from the process. */
export function createNodeContext(): Context {
  const secrets = new Set<string>();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const io: Io = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ...(interactive ? { prompt: terminalPrompt(process.stdin, process.stdout) } : {}),
  };
  if (!EMBEDDED_SKILL || EMBEDDED_GUIDANCE === undefined)
    throw new Error("this build carries no skill or guidance; build it with scripts/build.mjs");
  return {
    env: process.env,
    home: process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir(),
    hostname: hostname(),
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: nodeRunner,
    io: redactingIo(io, secrets),
    skill: EMBEDDED_SKILL,
    defaultServer: DEFAULT_SERVER_ORIGIN,
    harnesses: HARNESSES,
    guidance: EMBEDDED_GUIDANCE,
    executable: runningExecutable(),
    readStdin: () => readStream(process.stdin),
    secrets,
  };
}
