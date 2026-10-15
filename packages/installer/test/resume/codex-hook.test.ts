import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askDecisionId,
  CODEX_HOOK_BUDGET_MS,
  HookCancelledError,
  runCodexStop,
  scanCodexTranscript,
  TranscriptRefusedError,
} from "../../src/resume/codex.js";
import { launchDetached, processIsAlive } from "../../src/resume/process.js";
import { ResumeStore } from "../../src/resume/storage.js";
import { cleanupSandboxes, makeContext, mode, write } from "../helpers.js";
import {
  deferred,
  FIXTURES,
  fakeAdapters,
  flush,
  installSandbox,
  pump,
  resumeRoot,
  stubWaiterScript,
} from "./helpers.js";

// component-resume §Codex stop hook: `agentdesk hook stop --harness codex`
// reads the transcript for completed `ask` results, starts one detached
// waiter per decision without a live waiter, and prints `{}` at once.

afterEach(cleanupSandboxes);

const THREAD = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";
const TRANSCRIPT = join(FIXTURES, "codex-transcript.jsonl");

function stopInput(transcript = TRANSCRIPT): string {
  return readFileSync(join(FIXTURES, "codex-stop-input.json"), "utf8").replace(
    "__TRANSCRIPT__",
    transcript,
  );
}

function waiterArgs(decisionId: string): string[] {
  return ["wait", "--harness", "codex", "--codex-thread", THREAD, decisionId];
}

describe("transcript scan", () => {
  it("yields completed agentdesk ask results only, deduplicated in order", async () => {
    expect(await scanCodexTranscript(TRANSCRIPT)).toEqual(["dec_phone1", "dec_phone2"]);
  });

  it("ignores other tools, other servers, failed and unfinished calls, and bad lines", () => {
    const lines = readFileSync(TRANSCRIPT, "utf8").split("\n");
    const ids = lines.map(askDecisionId);
    expect(ids.filter((id) => id !== undefined)).toEqual([
      "dec_phone1",
      "dec_phone2",
      "dec_phone1",
    ]);
  });
});

describe("transcript checks and cancellation", () => {
  it("refuses a FIFO, a link to one, a device, and a directory without opening a stalled read", async () => {
    const sandbox = installSandbox(["codex"]);
    const fifo = join(sandbox.root, "t.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const linked = join(sandbox.root, "t-link.jsonl");
    symlinkSync(fifo, linked);
    for (const path of [fifo, linked, "/dev/zero", "/dev/null", FIXTURES]) {
      const started = Date.now();
      await expect(scanCodexTranscript(path)).rejects.toBeInstanceOf(TranscriptRefusedError);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it("follows a link to a regular transcript", async () => {
    const sandbox = installSandbox(["codex"]);
    const linked = join(sandbox.root, "t-link.jsonl");
    symlinkSync(TRANSCRIPT, linked);
    expect(await scanCodexTranscript(linked)).toEqual(["dec_phone1", "dec_phone2"]);
  });

  it("rejects at once with an aborted signal, and closes the reader when aborted mid-scan", async () => {
    const sandbox = installSandbox(["codex"]);
    const done = new AbortController();
    done.abort();
    await expect(scanCodexTranscript(TRANSCRIPT, done.signal)).rejects.toBeInstanceOf(
      HookCancelledError,
    );
    // A large transcript, aborted at its tenth line: the reader closes and no
    // later line is read.
    const big = join(sandbox.root, "big.jsonl");
    const line = `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1000) } })}\n`;
    writeFileSync(big, line.repeat(100_000));
    const stop = new AbortController();
    let seen = 0;
    const scan = scanCodexTranscript(big, stop.signal, () => {
      seen++;
      if (seen === 10) stop.abort();
    });
    await expect(scan).rejects.toBeInstanceOf(HookCancelledError);
    expect(seen).toBe(10);
  });

  it("rejects with HookCancelledError when aborted while the transcript is being opened", async () => {
    const stop = new AbortController();
    let seen = 0;
    const scan = scanCodexTranscript(TRANSCRIPT, stop.signal, () => {
      seen++;
    });
    // stat has not answered yet: the abort lands before the open.
    stop.abort();
    await expect(scan).rejects.toBeInstanceOf(HookCancelledError);
    expect(seen).toBe(0);
  });
});

describe("agentdesk hook stop --harness codex", () => {
  it("starts one detached waiter per decision, records its process id, and prints {}", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(stopInput());
    expect(await runCodexStop(h.ctx, adapters)).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.err).toEqual([]);
    const tail = adapters.launches.map((l) => l.args.slice(-6));
    expect(tail).toEqual([waiterArgs("dec_phone1"), waiterArgs("dec_phone2")]);
    const store = new ResumeStore(h.ctx);
    expect(store.waiterPid("dec_phone1")).toBe(40_000);
    expect(store.waiterPid("dec_phone2")).toBe(40_001);
    const waiters = join(resumeRoot(sandbox), "waiters");
    expect(mode(waiters)).toBe(0o700);
    expect(mode(join(waiters, "dec_phone1"))).toBe(0o600);
    // No start lock is left behind.
    expect(readdirSync(waiters).sort()).toEqual(["dec_phone1", "dec_phone2"]);
  });

  it("starts the running executable: Node with the bundle, or the binary itself", async () => {
    const sandbox = installSandbox(["codex"]);
    const bundle = makeContext(sandbox, { executable: "/opt/agentdesk/agentdesk.mjs" });
    const a = fakeAdapters(stopInput());
    await runCodexStop(bundle.ctx, a);
    // Vitest runs under Node, so the bundle runs through Node's own executable.
    expect(a.launches[0]).toEqual({
      command: process.execPath,
      args: ["/opt/agentdesk/agentdesk.mjs", ...waiterArgs("dec_phone1")],
    });
  });

  it("starts no second waiter while one is live, and replaces a dead one", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(stopInput());
    await runCodexStop(h.ctx, adapters);
    expect(adapters.launches).toHaveLength(2);
    // Both waiters still run: the next Stop starts nothing.
    await runCodexStop(h.ctx, adapters);
    expect(adapters.launches).toHaveLength(2);
    // dec_phone2's waiter exited: only it is started again.
    adapters.live.delete(40_001);
    await runCodexStop(h.ctx, adapters);
    expect(adapters.launches.map((l) => l.args.at(-1))).toEqual([
      "dec_phone1",
      "dec_phone2",
      "dec_phone2",
    ]);
    expect(new ResumeStore(h.ctx).waiterPid("dec_phone2")).toBe(40_002);
  });

  it("two Stop hooks at once start one waiter per decision", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(stopInput());
    let pid = 50_000;
    adapters.launchImpl = async (command, args) => {
      adapters.launches.push({ command, args: [...args] });
      // The start takes a while, as a real spawn does.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = pid++;
      adapters.live.add(started);
      return started;
    };
    const results = await Promise.all([
      runCodexStop(h.ctx, adapters),
      runCodexStop(h.ctx, adapters),
      runCodexStop(h.ctx, adapters),
    ]);
    expect(results).toEqual([0, 0, 0]);
    expect(h.out).toEqual(["{}", "{}", "{}"]);
    expect(adapters.launches.map((l) => l.args.at(-1)).sort()).toEqual([
      "dec_phone1",
      "dec_phone2",
    ]);
  });

  it("records nothing for a waiter that could not start, so the next Stop retries", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(stopInput());
    adapters.launchImpl = async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    expect(await runCodexStop(h.ctx, adapters)).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(existsSync(join(resumeRoot(sandbox), "waiters", "dec_phone1"))).toBe(false);
    adapters.launchImpl = undefined;
    await runCodexStop(h.ctx, adapters);
    expect(adapters.launches).toHaveLength(2);
  });

  it.each([
    ["no input", undefined],
    ["input that is not JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["a missing session_id", JSON.stringify({ transcript_path: TRANSCRIPT })],
    ["an unsafe session_id", JSON.stringify({ session_id: "--x", transcript_path: TRANSCRIPT })],
    [
      "a relative transcript_path",
      JSON.stringify({ session_id: THREAD, transcript_path: "t.jsonl" }),
    ],
    [
      "a missing transcript",
      JSON.stringify({ session_id: THREAD, transcript_path: "/nonexistent/t.jsonl" }),
    ],
    [
      "a transcript that is a directory",
      JSON.stringify({ session_id: THREAD, transcript_path: FIXTURES }),
    ],
  ])("prints {} and exits 0 on %s without starting a waiter", async (_label, input) => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(input);
    expect(await runCodexStop(h.ctx, adapters)).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.err).toEqual([]);
    expect(adapters.launches).toEqual([]);
  });

  it("prints {} within its budget when the input never arrives", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(() => new Promise(() => {}));
    const { value, elapsed } = await pump(h.clock, runCodexStop(h.ctx, adapters), { stepMs: 500 });
    expect(value).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(elapsed).toBe(CODEX_HOOK_BUDGET_MS);
    expect(elapsed).toBeLessThan(10_000);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("starts no waiter after the budget expires while a start is in flight, closes the input read, and asks the process to exit", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(stopInput());
    const exits: number[] = [];
    let readSignal: AbortSignal | undefined;
    const input = stopInput();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<number>();
    adapters.launchImpl = async (command, args) => {
      adapters.launches.push({ command, args: [...args] });
      firstStarted.resolve();
      return releaseFirst.promise;
    };
    const hook = runCodexStop(h.ctx, {
      ...adapters,
      readInput: async (signal?: AbortSignal) => {
        readSignal = signal;
        return input;
      },
      exitAfterOutput: (code: number) => exits.push(code),
    });
    let returned = false;
    hook.then(() => {
      returned = true;
    });
    // The scan reads the real transcript while the fake clock stands still,
    // so the first start begins before any budget time passes.
    await firstStarted.promise;
    expect(h.clock.now).toBe(0);
    expect(adapters.launches.map((l) => l.args.at(-1))).toEqual(["dec_phone1"]);
    expect(h.out).toEqual([]);

    // One millisecond before the budget, the hook still waits on the start.
    h.clock.advance(CODEX_HOOK_BUDGET_MS - 1);
    await flush();
    expect(returned).toBe(false);
    expect(h.out).toEqual([]);
    expect(readSignal?.aborted).toBe(false);

    // At the budget the hook prints {}, aborts its signal, and asks to exit.
    h.clock.advance(1);
    expect(await hook).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(exits).toEqual([0]);
    expect(readSignal?.aborted).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);

    // The start in flight finishes and is recorded; the next decision never starts.
    releaseFirst.resolve(60_000);
    await flush();
    expect(adapters.launches.map((l) => l.args.at(-1))).toEqual(["dec_phone1"]);
    const store = new ResumeStore(h.ctx);
    expect(store.waiterPid("dec_phone1")).toBe(60_000);
    expect(store.waiterPid("dec_phone2")).toBeUndefined();
    // The start lock was released.
    expect(readdirSync(join(resumeRoot(sandbox), "waiters"))).toEqual(["dec_phone1"]);
  });

  it("starts nothing when the budget expires before the input arrives", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(undefined);
    const exits: number[] = [];
    const input = deferred<string | undefined>();
    let readSignal: AbortSignal | undefined;
    const hook = runCodexStop(h.ctx, {
      ...adapters,
      readInput: (signal?: AbortSignal) => {
        readSignal = signal;
        return input.promise;
      },
      exitAfterOutput: (code: number) => exits.push(code),
    });
    await flush();
    expect(readSignal?.aborted).toBe(false);
    h.clock.advance(CODEX_HOOK_BUDGET_MS);
    expect(await hook).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(exits).toEqual([0]);
    expect(readSignal?.aborted).toBe(true);
    // Valid input arriving after the budget starts no scan and no waiter.
    input.resolve(stopInput());
    await flush();
    expect(adapters.launches).toEqual([]);
    expect(existsSync(resumeRoot(sandbox))).toBe(false);
  });

  it("does not ask the process to exit when it finishes within the budget", async () => {
    const sandbox = installSandbox(["codex"]);
    const h = makeContext(sandbox);
    const exits: number[] = [];
    const adapters = {
      ...fakeAdapters(stopInput()),
      exitAfterOutput: (c: number) => exits.push(c),
    };
    expect(await runCodexStop(h.ctx, adapters)).toBe(0);
    expect(exits).toEqual([]);
  });

  it("returns at once for a transcript with no ask result", async () => {
    const sandbox = installSandbox(["codex"]);
    const transcript = join(sandbox.root, "empty.jsonl");
    write(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n`);
    const h = makeContext(sandbox);
    const adapters = fakeAdapters(stopInput(transcript));
    expect(await runCodexStop(h.ctx, adapters)).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(adapters.launches).toEqual([]);
    expect(existsSync(resumeRoot(sandbox))).toBe(false);
  });
});

describe("detached waiter start", () => {
  it("starts a real detached process with closed standard streams that outlives the call", async () => {
    const sandbox = installSandbox(["codex"]);
    const stub = stubWaiterScript(sandbox, 3000);
    const h = makeContext(sandbox, { executable: stub.path });
    const adapters = {
      ...fakeAdapters(stopInput()),
      launch: launchDetached,
      isAlive: processIsAlive,
    };
    expect(await runCodexStop(h.ctx, adapters)).toBe(0);
    expect(h.out).toEqual(["{}"]);
    const store = new ResumeStore(h.ctx);
    const pid = store.waiterPid("dec_phone1");
    expect(pid).toBeGreaterThan(0);
    expect(processIsAlive(pid as number)).toBe(true);
    // The stub records its arguments once it runs.
    const deadline = Date.now() + 10_000;
    while (readdirSync(stub.out).length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const started = readdirSync(stub.out).map(
      (f) => JSON.parse(readFileSync(join(stub.out, f), "utf8")) as { args: string[] },
    );
    expect(started.map((s) => s.args).sort()).toEqual(
      [waiterArgs("dec_phone1"), waiterArgs("dec_phone2")].sort(),
    );
    // A live waiter is not started again.
    await runCodexStop(h.ctx, adapters);
    expect(readdirSync(stub.out)).toHaveLength(2);
    for (const id of ["dec_phone1", "dec_phone2"]) {
      const recorded = store.waiterPid(id);
      if (recorded) process.kill(recorded);
    }
  });

  it("rejects when the executable cannot start", async () => {
    await expect(launchDetached("/nonexistent/agentdesk", ["wait"])).rejects.toThrow();
  });
});
