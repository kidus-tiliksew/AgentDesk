import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isPlainObject } from "./config.js";
import { type Context, startTimer } from "./context.js";
import { APP_SERVER_TIMEOUT_MS, INSTALLER_VERSION } from "./defaults.js";
import { findExecutable } from "./harnesses.js";

// component-installer §Codex trust: Codex skips a user hook until config.toml
// records its hash. `codex app-server` reports each hook's key and hash.

/** One hook as `hooks/list` reports it. */
export interface ListedHook {
  key: string;
  command: string | undefined;
  currentHash: string | undefined;
  trustStatus: string | undefined;
  source: string | undefined;
}

export type HookList =
  | { kind: "listed"; hooks: ListedHook[] }
  | { kind: "unavailable"; reason: string };

/**
 * The step that trusts one AgentDesk hook by hand (AC-10.3), such as the
 * "session-start hook" or the "Stop hook".
 */
export function trustStep(label: string): string {
  return `In Codex, run /hooks and trust the AgentDesk ${label}.`;
}

const unavailable = (reason: string): HookList => ({ kind: "unavailable", reason });

function stringField(value: Record<string, unknown>, name: string): string | undefined {
  const field = value[name];
  return typeof field === "string" ? field : undefined;
}

function hooksOf(result: Record<string, unknown>): ListedHook[] {
  const hooks: ListedHook[] = [];
  const data = Array.isArray(result.data) ? result.data : [];
  for (const scope of data) {
    if (!isPlainObject(scope) || !Array.isArray(scope.hooks)) continue;
    for (const hook of scope.hooks) {
      if (!isPlainObject(hook)) continue;
      const key = stringField(hook, "key");
      if (key === undefined) continue;
      hooks.push({
        key,
        command: stringField(hook, "command"),
        currentHash: stringField(hook, "currentHash"),
        trustStatus: stringField(hook, "trustStatus"),
        source: stringField(hook, "source"),
      });
    }
  }
  return hooks;
}

/**
 * Sends `initialize`, the `initialized` notification, and `hooks/list` with
 * the home directory. Responses are matched by request id; notifications and
 * requests from the server are ignored.
 */
function exchange(child: ChildProcessWithoutNullStreams, home: string): Promise<HookList> {
  return new Promise((resolve) => {
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    // Output is never shown; standard error is drained and dropped.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => resolve(unavailable("codex app-server could not start")));
    child.on("close", (code) =>
      resolve(unavailable(`codex app-server exited with status ${code ?? "unknown"}`)),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isPlainObject(message) || "method" in message || typeof message.id !== "number") return;
      waiting.get(message.id)?.(message);
    });
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const request = (id: number, method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((answer) => {
        waiting.set(id, answer);
        send({ id, method, params });
      });
    (async () => {
      const initialized = await request(1, "initialize", {
        clientInfo: { name: "agentdesk", version: INSTALLER_VERSION },
      });
      if (!isPlainObject(initialized.result)) {
        resolve(unavailable("codex app-server refused initialize"));
        return;
      }
      send({ method: "initialized" });
      const listed = await request(2, "hooks/list", { cwds: [home] });
      if (!isPlainObject(listed.result)) {
        resolve(unavailable("codex app-server could not list hooks"));
        return;
      }
      resolve({ kind: "listed", hooks: hooksOf(listed.result) });
    })();
  });
}

/**
 * Lists Codex hooks through `codex app-server` over stdio. App-server is
 * stopped once `hooks/list` answers or after 10 seconds.
 */
export async function listCodexHooks(ctx: Context): Promise<HookList> {
  const cli = findExecutable(ctx, "codex");
  if (!cli) return unavailable("codex is not on PATH");
  const timer = startTimer(ctx, APP_SERVER_TIMEOUT_MS);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(cli, ["app-server"], {
      env: { ...ctx.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    timer.cancel();
    return unavailable("codex app-server could not start");
  }
  try {
    return await Promise.race([
      exchange(child, ctx.home),
      timer.promise.then(() => unavailable("codex app-server did not answer within 10 seconds")),
    ]);
  } finally {
    timer.cancel();
    child.stdin.destroy();
    child.kill();
  }
}

/** Finds the user hook whose command is `command`, with its key and hash. */
export function findListedHook(
  list: HookList,
  command: string,
): (ListedHook & { currentHash: string }) | undefined {
  if (list.kind !== "listed") return undefined;
  const hook = list.hooks.find(
    (h) => h.source === "user" && h.command === command && h.currentHash !== undefined,
  );
  return hook as (ListedHook & { currentHash: string }) | undefined;
}

/** The events whose Codex hooks the installer writes and whose keys a removal can change. */
export type KeyedEvent = "session_start" | "stop";

/**
 * Splits a Codex hook key, `<hooks.json path>:<event>:<group>:<handler>`,
 * for the events `session_start` and `stop`.
 */
export function parseHookKey(
  key: string,
): { file: string; event: KeyedEvent; position: string } | undefined {
  const match = /^(.*):(session_start|stop):(\d+):(\d+)$/.exec(key);
  if (!match) return undefined;
  return {
    file: match[1] as string,
    event: match[2] as KeyedEvent,
    position: `${match[3]}:${match[4]}`,
  };
}
