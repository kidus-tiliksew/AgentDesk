import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookAdapters } from "../../src/resume/process.js";
import {
  type FakeClock,
  makeContext,
  makeSandbox,
  type Sandbox,
  SERVER,
  write,
} from "../helpers.js";

// Shared fixtures for the resume tests (component-resume §Verification): an
// installed sandbox, a fake `POST /device/wait` gateway on the fake clock that
// follows component-gateway §Waiter endpoint, and a pump that drives the clock.

export const FIXTURES = join(dirname(new URL(import.meta.url).pathname), "fixtures");

export const TOKENS = {
  "claude-code": `adc_claudecode${"k".repeat(32)}`,
  codex: `adc_codex${"x".repeat(32)}`,
  cursor: `adc_cursor${"c".repeat(32)}`,
} as const;

export type HarnessKey = keyof typeof TOKENS;

/** Writes the installer's state and each harness's MCP entry, as `install` leaves them. */
export function installSandbox(
  harnesses: readonly HarnessKey[] = ["claude-code", "codex", "cursor"],
  server = SERVER,
): Sandbox {
  const sandbox = makeSandbox();
  const records: Record<string, unknown> = {};
  for (const id of harnesses) {
    records[id] = { server, connectionId: `conn_${id}` };
    const header = { Authorization: `Bearer ${TOKENS[id]}` };
    if (id === "claude-code") {
      write(
        join(sandbox.home, ".claude.json"),
        JSON.stringify({
          mcpServers: { agentdesk: { type: "http", url: `${server}/mcp`, headers: header } },
        }),
      );
    } else if (id === "codex") {
      write(
        join(sandbox.home, ".codex", "config.toml"),
        `[mcp_servers.agentdesk]\nurl = "${server}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${TOKENS.codex}" }\n`,
      );
    } else {
      write(
        join(sandbox.home, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { agentdesk: { url: `${server}/mcp`, headers: header } } }),
      );
    }
  }
  write(
    join(sandbox.home, ".config", "agentdesk", "state.json"),
    JSON.stringify({ version: 1, server, harnesses: records }),
  );
  return sandbox;
}

export function resumeRoot(sandbox: Sandbox): string {
  return join(sandbox.home, ".config", "agentdesk", "resume");
}

/** A decision in the contract's read shape, settled as given. */
export function decision(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    topic: "acme/app",
    title: "Ship it?",
    body: null,
    input_type: "confirm",
    options: null,
    recommendation: null,
    priority: "normal",
    interactive: true,
    deadline: null,
    default: null,
    state: "answered",
    answer: { value: true },
    note: null,
    answered_at: "2026-10-15T10:00:00.000Z",
    answered_via: "app",
    chat_message: null,
    relayed_by_agent_session_id: null,
    applied_by_default: false,
    parent_id: null,
    follow_up_ids: [],
    agent_session_id: "sess_1",
    created_at: "2026-10-15T09:00:00.000Z",
    ...fields,
  };
}

export type WaitStep =
  /** The decision's settled read shape, delivered as `{"decision": ...}`. */
  | { decision: Record<string, unknown> }
  /** `{"state": "pending", "decision_id"}` after the 600-second limit. */
  | "pending"
  | "not_found"
  | "unavailable"
  /** A contract error event with this code. */
  | { errorCode: string }
  /** An HTTP answer with this status before the stream opens. */
  | { status: number }
  /** fetch rejects, as for a refused connection. */
  | "network"
  /** A keepalive and half an event, then the stream ends. */
  | "truncated"
  /** A message event whose data is not JSON. */
  | "garbage"
  /** The stream stays open with keepalives until the request is aborted. */
  | "hang";

export interface WaitRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
  accept: string | undefined;
  at: number;
}

/**
 * `POST /device/wait` on the fake clock. Each request for a decision takes
 * that decision's next step; the last step repeats. Settled steps answer at
 * once; `pending` answers after `timeout_seconds`, as the gateway's limit.
 */
export class FakeWaitGateway {
  requests: WaitRequest[] = [];
  scripts = new Map<string, WaitStep[]>();
  /** Splits each stream into chunks of this many bytes. */
  chunkSize = 0;
  lineEnding = "\n";
  /** Requests whose signal aborted. */
  aborted = 0;
  private positions = new Map<string, number>();

  constructor(private readonly clock: FakeClock) {}

  script(decisionId: string, steps: WaitStep[]): this {
    this.scripts.set(decisionId, steps);
    return this;
  }

  /** Requests still open. */
  get open(): number {
    return this.opened - this.closed;
  }
  private opened = 0;
  private closed = 0;

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const signal = init?.signal ?? undefined;
    this.requests.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body,
      authorization: headers.authorization,
      accept: headers.accept,
      at: this.clock.now,
    });
    if (url.pathname !== "/device/wait" || init?.method !== "POST") {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no" } }), {
        status: 404,
      });
    }
    const decisionId = String(body.decision_id);
    const steps = this.scripts.get(decisionId) ?? ["not_found"];
    const index = this.positions.get(decisionId) ?? 0;
    this.positions.set(decisionId, index + 1);
    const step = steps[Math.min(index, steps.length - 1)] as WaitStep;

    if (step === "network") throw new TypeError("fetch failed");
    if (typeof step === "object" && "status" in step) {
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "down" } }), {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    }
    const nl = this.lineEnding;
    const keepalive = `: keepalive${nl}${nl}`;
    const event = (value: unknown) =>
      `${keepalive}event: message${nl}data: ${JSON.stringify(value)}${nl}${nl}`;
    let text: string | undefined;
    let delayMs = 0;
    if (step === "pending") {
      text = event({ state: "pending", decision_id: decisionId });
      delayMs = Number(body.timeout_seconds) * 1000;
    } else if (step === "not_found") {
      text = event({ error: { code: "not_found", message: "Decision not found" } });
    } else if (step === "unavailable") {
      text = event({
        error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
      });
    } else if (step === "truncated") {
      text = `${keepalive}event: message${nl}data: {"decision":`;
    } else if (step === "garbage") {
      text = `${keepalive}event: message${nl}data: not json${nl}${nl}`;
    } else if (step === "hang") {
      text = undefined;
    } else if ("errorCode" in step) {
      text = event({ error: { code: step.errorCode, message: "refused" } });
    } else {
      text = event({ decision: step.decision });
    }

    const encoder = new TextEncoder();
    const clock = this.clock;
    const chunkSize = this.chunkSize;
    this.opened++;
    let closed = false;
    const markClosed = () => {
      if (!closed) {
        closed = true;
        this.closed++;
      }
    };
    const onAborted = () => {
      this.aborted++;
    };
    signal?.addEventListener("abort", onAborted, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const fail = () => {
          markClosed();
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {}
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
        if (text === undefined) {
          controller.enqueue(encoder.encode(keepalive));
          return; // open until aborted
        }
        if (delayMs > 0) {
          controller.enqueue(encoder.encode(keepalive));
          const timer = clock.startTimer(delayMs);
          signal?.addEventListener("abort", () => timer.cancel(), { once: true });
          await timer.promise;
          if (signal?.aborted) return;
        }
        const bytes = encoder.encode(text);
        const size = chunkSize > 0 ? chunkSize : bytes.length;
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        signal?.removeEventListener("abort", fail);
        markClosed();
        controller.close();
      },
      cancel() {
        markClosed();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  waitRequests(decisionId?: string): WaitRequest[] {
    return this.requests.filter(
      (r) =>
        r.path === "/device/wait" &&
        (decisionId === undefined || r.body.decision_id === decisionId),
    );
  }
}

/** A context with the fake wait gateway, for a sandbox from installSandbox. */
export function resumeContext(sandbox: Sandbox, options: { now?: number } = {}) {
  const harnessed = makeContext(sandbox);
  const gateway = new FakeWaitGateway(harnessed.clock);
  harnessed.ctx.fetch = gateway.fetch;
  if (options.now !== undefined) harnessed.clock.now = options.now;
  return { ...harnessed, waits: gateway };
}

/**
 * Settles `promise` while moving the fake clock forward `stepMs` whenever a
 * timer waits and nothing else can run. Returns the value and the clock time
 * it took.
 */
export async function pump<T>(
  clock: FakeClock,
  promise: Promise<T>,
  options: { stepMs?: number; maxMs?: number } = {},
): Promise<{ value: T; elapsed: number }> {
  const stepMs = options.stepMs ?? 1000;
  const maxMs = options.maxMs ?? 4 * 60 * 60 * 1000;
  const start = clock.now;
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e: unknown) => {
      settled = true;
      failed = true;
      error = e;
    },
  );
  const realDeadline = Date.now() + 20_000;
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    if (settled) break;
    if (clock.pendingTimers > 0) {
      clock.advance(stepMs);
      if (clock.now - start > maxMs)
        throw new Error("the promise did not settle on the fake clock");
    } else if (Date.now() > realDeadline) {
      throw new Error("the promise did not settle");
    }
  }
  if (failed) throw error;
  return { value: value as T, elapsed: clock.now - start };
}

/** Hook adapters with a fixed input, a set of live process ids, and a recording launcher. */
export function fakeAdapters(input: string | undefined | (() => Promise<string | undefined>)) {
  const launches: { command: string; args: string[] }[] = [];
  const live = new Set<number>();
  let nextPid = 40_000;
  const adapters: HookAdapters & {
    launches: typeof launches;
    live: Set<number>;
    launchImpl?: (command: string, args: readonly string[]) => Promise<number>;
  } = {
    launches,
    live,
    readInput: typeof input === "function" ? input : async () => input,
    isAlive: (pid) => live.has(pid),
    launch: async (command, args) => {
      if (adapters.launchImpl) return adapters.launchImpl(command, args);
      launches.push({ command, args: [...args] });
      const pid = nextPid++;
      live.add(pid);
      return pid;
    },
  };
  return adapters;
}

/** Puts a stub `codex` on the sandbox PATH that records `codex queue` and exits with `status`. */
export function stubCodex(sandbox: Sandbox, status = 0): string {
  const log = join(sandbox.root, "codex-queue.log");
  const script = join(sandbox.bin, "codex");
  writeFileSync(
    script,
    `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${JSON.stringify(log)} "$@"\necho "queued with output that must stay private"\necho "codex stderr" >&2\nexit ${status}\n`,
  );
  chmodSync(script, 0o755);
  return log;
}

/**
 * A stub `agentdesk` for the detached waiter: a Node script that records its
 * process id and arguments under `out`, then stays alive for `aliveMs`.
 */
export function stubWaiterScript(sandbox: Sandbox, aliveMs: number): { path: string; out: string } {
  const out = join(sandbox.root, "waiters-started");
  mkdirSync(out, { recursive: true });
  const path = join(sandbox.root, "app", "agentdesk.mjs");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)} + "/" + process.pid + ".json", JSON.stringify({ args: process.argv.slice(2), stdin: process.stdin.isTTY ?? null }));\nsetTimeout(() => {}, ${aliveMs});\n`,
  );
  return { path, out };
}
