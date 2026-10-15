import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { type Context, type Runner, redactingIo, type Timer } from "../src/context.js";
import { HARNESSES, type Harness } from "../src/harnesses.js";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_FILE = resolve(PACKAGE_DIR, "..", "skill", "agentdesk", "SKILL.md");
export const GUIDANCE_FILE = resolve(PACKAGE_DIR, "..", "skill", "agentdesk", "GUIDANCE.md");
export const SERVER = "https://agentdesk.test";
export const HOSTNAME = "devbox-1";

export function skillContent(version: string): string {
  return `---\nname: agentdesk\ndescription: test skill\nmetadata:\n  version: "${version}"\n---\n\n# AgentDesk ${version}\n`;
}

export interface Sandbox {
  root: string;
  home: string;
  bin: string;
  log: string;
  /** The agentdesk executable path the sandbox's runs report; it need not exist. */
  executable: string;
  env: Record<string, string>;
}

const sandboxes: string[] = [];

/** A temporary home and an empty fake PATH. */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-installer-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const log = join(root, "commands.log");
  const executable = join(root, "app", "agentdesk");
  return {
    root,
    home,
    bin,
    log,
    executable,
    env: { HOME: home, PATH: bin, AGENTDESK_TEST_LOG: log },
  };
}

export function cleanupSandboxes(): void {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
}

const FAKE_HARNESS = join(PACKAGE_DIR, "test", "fixtures", "fake-harness.mjs");

/** Puts a stub executable that records its arguments on the fake PATH. */
export function stubExecutable(sandbox: Sandbox, name: string): string {
  const path = join(sandbox.bin, name);
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HARNESS)} ${name} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

export interface Invocation {
  name: string;
  args: string[];
}

export function invocations(sandbox: Sandbox): Invocation[] {
  if (!existsSync(sandbox.log)) return [];
  return readFileSync(sandbox.log, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Invocation);
}

/** Invocations other than `codex app-server`, which reads and never writes. */
export function writingInvocations(sandbox: Sandbox): Invocation[] {
  return invocations(sandbox).filter((i) => !(i.name === "codex" && i.args[0] === "app-server"));
}

/** The JSON-RPC messages the stub `codex app-server` received. */
export function appServerMessages(sandbox: Sandbox): Record<string, unknown>[] {
  const file = `${sandbox.log}.rpc`;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The hash the stub `codex app-server` reports for a hook in `event`
 * (`session_start` or `stop`); it matches test/fixtures/fake-harness.mjs. It
 * covers the event and the handler's definition, never its position.
 */
export function codexHookHash(
  matcher: string | undefined,
  handler: { type?: string; command?: string; timeout?: number },
  event: "session_start" | "stop" = "session_start",
): string {
  const definition = JSON.stringify([
    event,
    matcher ?? null,
    handler.type ?? null,
    handler.command ?? null,
    handler.timeout ?? null,
  ]);
  return `sha256:${createHash("sha256").update(definition).digest("hex")}`;
}

/** Runs harness CLIs with the sandbox environment, never the real HOME. */
export function sandboxRunner(env: Record<string, string>): Runner {
  return (command, args) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
}

// ---------------------------------------------------------------------------
// Fake gateway (component-gateway §Sign-in endpoints) on a fake clock.

export type PollStep = "pending" | "approved" | "declined" | "expired" | "not_found" | number;

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
  at: number;
}

export class FakeClock {
  now = 0;
  sleeps: number[] = [];
  private timers: { at: number; fire: () => void }[] = [];
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.advance(ms);
  };
  /** Moves the clock forward and fires every timer that is then due. */
  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((t) => t.at <= this.now);
    this.timers = this.timers.filter((t) => t.at > this.now);
    for (const timer of due) timer.fire();
  }
  startTimer = (ms: number): Timer => {
    let fire = () => {};
    const promise = new Promise<void>((resolvePromise) => {
      fire = resolvePromise;
    });
    const timer = { at: this.now + ms, fire };
    this.timers.push(timer);
    return {
      promise,
      cancel: () => {
        this.timers = this.timers.filter((t) => t !== timer);
      },
    };
  };
  /** Timers started and neither fired nor cancelled. */
  get pendingTimers(): number {
    return this.timers.length;
  }
}

export class FakeGateway {
  requests: RecordedRequest[] = [];
  /** One script per /device/start; each poll takes the next step, and the last step repeats. */
  scripts: PollStep[][] = [];
  /** Overrides the approved connections with a raw value. */
  approvedOverride: unknown;
  startStatus = 200;
  expiresIn = 600;
  /** Tokens the gateway answers 401 for on GET /device/connection. */
  refused = new Set<string>();
  /** Status for DELETE /device/connection, per token. */
  deleteStatus = new Map<string, number>();
  /** Status for every DELETE /device/connection, when set. */
  deleteStatusAll: number | undefined;
  revoked: string[] = [];
  issued: { harness: string; connectionId: string; token: string }[] = [];
  deviceSecrets: string[] = [];
  private starts = 0;
  private minted = 0;
  private current:
    | { script: PollStep[]; index: number; harnesses: string[]; secret: string }
    | undefined;

  constructor(private readonly clock: FakeClock) {}

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    // A server under a path prefix serves the same routes below it.
    const path = url.pathname.replace(/^.*?(\/device\/)/, "$1");
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const authorization = headers.authorization;
    this.requests.push({ method, url: url.href, path, body, authorization, at: this.clock.now });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    const token = authorization?.replace(/^Bearer /, "");

    if (method === "POST" && path === "/device/start") {
      if (this.startStatus !== 200)
        return json(this.startStatus, { error: { code: "rate_limited" } });
      const script = this.scripts[this.starts] ?? ["approved"];
      this.starts++;
      const code = `ABCD${String(1000 + this.starts).slice(-4)}`.replace(/[ILOU]/g, "X");
      const secret = `devsecret-${this.starts}-${"s".repeat(30)}`;
      this.deviceSecrets.push(secret);
      this.current = { script, index: 0, harnesses: body.harnesses, secret };
      return json(200, {
        user_code: code,
        device_secret: secret,
        interval: 2,
        expires_in: this.expiresIn,
      });
    }
    if (method === "POST" && path === "/device/poll") {
      const current = this.current;
      if (!current || body?.device_secret !== current.secret)
        return json(200, { status: "not_found" });
      const step = current.script[Math.min(current.index, current.script.length - 1)] as PollStep;
      current.index++;
      if (typeof step === "number") return json(step, { error: { code: "unavailable" } });
      if (step !== "approved") return json(200, { status: step });
      if (this.approvedOverride !== undefined) {
        return json(200, { status: "approved", connections: this.approvedOverride });
      }
      const connections = current.harnesses.map((harness) => {
        this.minted++;
        const issued = {
          harness,
          connectionId: `conn_${harness}_${this.minted}`,
          token: `adc_${harness.replace("-", "")}${this.minted}${"t".repeat(32)}`,
        };
        this.issued.push(issued);
        return { harness, connection_id: issued.connectionId, token: issued.token };
      });
      return json(200, { status: "approved", connections });
    }
    if (path === "/device/connection") {
      const known =
        this.issued.some((i) => i.token === token) && !this.revoked.includes(token ?? "");
      if (method === "GET") {
        return known && !this.refused.has(token ?? "")
          ? json(200, { ok: true })
          : json(401, { error: { code: "unauthenticated" } });
      }
      if (method === "DELETE") {
        const status = this.deleteStatusAll ?? this.deleteStatus.get(token ?? "");
        if (status) return json(status, { error: { code: "unavailable" } });
        if (!known) return json(401, { error: { code: "unauthenticated" } });
        this.revoked.push(token ?? "");
        return json(200, { revoked: true });
      }
    }
    return json(404, { error: { code: "not_found" } });
  };

  startRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path === "/device/start");
  }

  tokenFor(harness: string): string {
    const issued = [...this.issued].reverse().find((i) => i.harness === harness);
    if (!issued) throw new Error(`no token issued for ${harness}`);
    return issued.token;
  }
}

export interface Harnessed {
  ctx: Context;
  out: string[];
  err: string[];
  prompts: string[];
  clock: FakeClock;
  gateway: FakeGateway;
  run(argv: string[]): Promise<number>;
  output(): string;
}

export interface ContextOptions {
  /** Answers to prompts in order; an Error makes that prompt reject with it. */
  answers?: (string | Error)[];
  skill?: { content: string; version: string };
  harnesses?: readonly Harness[];
  defaultServer?: string | undefined;
  env?: Record<string, string>;
  gateway?: FakeGateway;
  clock?: FakeClock;
  executable?: string;
  guidance?: string;
}

/** Builds a context against the sandbox, a fake gateway, and a fake clock. */
export function makeContext(sandbox: Sandbox, options: ContextOptions = {}): Harnessed {
  const clock = options.clock ?? new FakeClock();
  const gateway = options.gateway ?? new FakeGateway(clock);
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const answers = options.answers ? [...options.answers] : undefined;
  const secrets = new Set<string>();
  const env = { ...sandbox.env, ...options.env };
  const ctx: Context = {
    env,
    home: sandbox.home,
    hostname: HOSTNAME,
    fetch: gateway.fetch,
    now: () => clock.now,
    sleep: clock.sleep,
    run: sandboxRunner(env),
    io: redactingIo(
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        ...(answers
          ? {
              prompt: async (question: string) => {
                prompts.push(question);
                const answer = answers.shift();
                if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
                if (answer instanceof Error) throw answer;
                return answer;
              },
            }
          : {}),
      },
      secrets,
    ),
    skill: options.skill ?? { content: readFileSync(SKILL_FILE, "utf8"), version: "1.0.0" },
    defaultServer: "defaultServer" in options ? options.defaultServer : SERVER,
    harnesses: options.harnesses ?? HARNESSES,
    guidance: options.guidance ?? readFileSync(GUIDANCE_FILE, "utf8"),
    executable: options.executable ?? sandbox.executable,
    startTimer: clock.startTimer,
    secrets,
  };
  return {
    ctx,
    out,
    err,
    prompts,
    clock,
    gateway,
    run: (argv) => runCli(argv, ctx),
    output: () => [...out, ...err].join("\n"),
  };
}

export function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

export function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Every file under `dir`, recursively. */
export function allFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...allFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The read error Bun raises on macOS when it cannot poll /dev/tty. */
export function kqueueError(): Error {
  return Object.assign(new Error("EINVAL: invalid argument, kqueue"), {
    code: "EINVAL",
    syscall: "kqueue",
  });
}
