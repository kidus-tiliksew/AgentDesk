import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askDecisionId,
  CODEX_HOOK_BUDGET_MS,
  runCodexStop,
  scanCodexTranscript,
} from "../../src/resume/codex.js";
import { launchDetached, processIsAlive } from "../../src/resume/process.js";
import { ResumeStore } from "../../src/resume/storage.js";
import { cleanupSandboxes, makeContext, mode, write } from "../helpers.js";
import {
  FIXTURES,
  fakeAdapters,
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
