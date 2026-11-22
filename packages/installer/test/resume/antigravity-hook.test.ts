import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_HOLD_LIMIT_MS,
  parseAntigravityStopInput,
  resultDecisionId,
  runAntigravityStop,
  scanAntigravityTranscript,
} from "../../src/resume/antigravity.js";
import { HookCancelledError, TranscriptRefusedError } from "../../src/resume/codex.js";
import { parseHookArgs, runHook } from "../../src/resume/commands.js";
import { ResumeStore } from "../../src/resume/storage.js";
import { cleanupSandboxes, makeSandbox, write } from "../helpers.js";
import {
  decision,
  deferred,
  FIXTURES,
  fakeAdapters,
  flush,
  installSandbox,
  malformedDecisions,
  pump,
  resumeContext,
  resumeRoot,
  TOKENS,
} from "./helpers.js";

// component-resume §Antigravity stop hook and §Verification: the hook reads
// the `ask` results of the `agentdesk` server from the transcript, holds on
// each unclaimed decision for at most 50 minutes, and continues the loop with
// the resume message for the first decision that settles outside the chat
// (DEC-24(3), (4); req-installation-and-agent-guidance AC-12.1 to AC-12.4,
// AC-12.9).

afterEach(cleanupSandboxes);

const TRANSCRIPT = join(FIXTURES, "antigravity-transcript.jsonl");
const STOP_TEMPLATE = readFileSync(join(FIXTURES, "antigravity-stop.json"), "utf8");

function stopInput(fields: Record<string, unknown> = {}, transcript = TRANSCRIPT): string {
  const input = JSON.parse(STOP_TEMPLATE.replace("__TRANSCRIPT__", transcript));
  return JSON.stringify({ ...input, ...fields });
}

function message(id: string): string {
  return `AgentDesk decision ${id} settled. Read it with check, tell the user the answer and where it was given, then act on it.`;
}

function continued(id: string): string {
  return JSON.stringify({ decision: "continue", reason: message(id) });
}

function claimed(sandbox: ReturnType<typeof installSandbox>, id: string): boolean {
  return existsSync(join(resumeRoot(sandbox), "claims", id));
}

/**
 * Lets the hook read its real transcript while the fake clock stands still,
 * until it has opened `requests` waits, then drives the clock with `pump`.
 * Returns the hook's status and the clock time when it returned, counted
 * from the hook's start.
 */
async function afterScan(
  h: ReturnType<typeof resumeContext>,
  run: Promise<number>,
  requests: number,
  options: { stepMs?: number } = {},
): Promise<{ value: number; elapsed: number }> {
  let done = false;
  run.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const deadline = Date.now() + 10_000;
  while (!done && h.waits.requests.length < requests) {
    if (Date.now() > deadline) throw new Error("the hook opened no wait");
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(h.clock.now).toBe(0);
  const { value } = await pump(h.clock, run, options);
  return { value, elapsed: h.clock.now };
}

describe("Antigravity transcript", () => {
  it("names only the decisions of agentdesk ask results, once each, in order", async () => {
    // The fixture also holds another server's tool, another AgentDesk tool, an
    // ask followed by another call, an ask made beside another call, a repeated
    // ask result, and a last ask with no result; none of those names a decision.
    expect(await scanAntigravityTranscript(TRANSCRIPT)).toEqual(["dec_phone1", "dec_phone2"]);
  });

  it("reads the JSON object after the timestamp lines of a result", () => {
    expect(
      resultDecisionId(
        'Created At: 2026-11-22T10:00:01Z\nCompleted At: 2026-11-22T10:00:02Z\n{"decision_id": "dec_probe123", "state": "pending"}',
      ),
    ).toBe("dec_probe123");
    expect(resultDecisionId('{"decision_id": "dec_1", "state": "pending"}\n')).toBe("dec_1");
    expect(
      resultDecisionId(
        '2026-11-22T10:00:01Z\n{\n  "decision_id": "dec_2",\n  "state": "pending"\n}',
      ),
    ).toBe("dec_2");
  });

  it.each([
    ["text after the JSON", '{"decision_id": "dec_1"}\nDone.'],
    ["no JSON", "Created At: 2026-11-22T10:00:01Z\nThe call failed."],
    ["JSON without decision_id", '{"state": "pending"}'],
    ["an unsafe decision id", '{"decision_id": "../dec"}'],
    ["a decision id that is not a string", '{"decision_id": 7}'],
    ["a JSON list", '[{"decision_id": "dec_1"}]'],
    ["JSON that starts inside a line", 'result: {"decision_id": "dec_1"}'],
  ])("names nothing for a result with %s", (_label, content) => {
    expect(resultDecisionId(content)).toBeUndefined();
  });

  it("refuses a transcript that is a directory or a FIFO", async () => {
    const sandbox = makeSandbox();
    const fifo = join(sandbox.root, "transcript.fifo");
    execFileSync("mkfifo", [fifo]);
    for (const path of [FIXTURES, fifo]) {
      await expect(scanAntigravityTranscript(path)).rejects.toBeInstanceOf(TranscriptRefusedError);
    }
  });

  it("rejects at once with an aborted signal", async () => {
    const done = new AbortController();
    done.abort();
    await expect(scanAntigravityTranscript(TRANSCRIPT, done.signal)).rejects.toBeInstanceOf(
      HookCancelledError,
    );
  });

  it("reads the hook input and never requires continuationActive or executionNum", () => {
    expect(parseAntigravityStopInput(stopInput())).toEqual({
      conversationId: "5b1f0c2e-8d4a-4f6b-9c3e-7a2d1e0f9b8c",
      transcriptPath: TRANSCRIPT,
      terminationReason: "NO_TOOL_CALL",
    });
    const bare = JSON.parse(stopInput());
    delete bare.continuationActive;
    delete bare.executionNum;
    expect(parseAntigravityStopInput(JSON.stringify(bare))?.terminationReason).toBe("NO_TOOL_CALL");
  });
});

describe("agentdesk hook stop --harness antigravity", () => {
  it("is dispatched by the hook command", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    h.waits.script("dec_phone2", ["hang"]);
    const options = parseHookArgs(["stop", "--harness", "antigravity"]);
    const { value } = await afterScan(h, runHook(h.ctx, options, fakeAdapters(stopInput())), 2);
    expect(value).toBe(0);
    expect(h.out).toEqual([continued("dec_phone1")]);
  });

  it.each([["MAX_STEPS"], ["USER_CANCELLED"], ["ERROR"], [""]])(
    "prints {} at once for terminationReason %j",
    async (terminationReason) => {
      const sandbox = installSandbox(["antigravity"]);
      const h = resumeContext(sandbox);
      h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
      const adapters = fakeAdapters(stopInput({ terminationReason }));
      expect(await runAntigravityStop(h.ctx, adapters)).toBe(0);
      expect(h.out).toEqual(["{}"]);
      expect(h.waits.requests).toEqual([]);
      expect(claimed(sandbox, "dec_phone1")).toBe(false);
    },
  );

  it.each([
    ["no input", undefined],
    ["input that is not JSON", "nope"],
    ["a JSON list", "[]"],
    ["a missing terminationReason", stopInput({ terminationReason: undefined })],
    ["a terminationReason that is not a string", stopInput({ terminationReason: 1 })],
    ["a missing conversationId", stopInput({ conversationId: undefined })],
    ["an unsafe conversationId", stopInput({ conversationId: "../x" })],
    ["a missing transcriptPath", stopInput({ transcriptPath: undefined })],
    ["a relative transcriptPath", stopInput({ transcriptPath: "transcript_full.jsonl" })],
    ["a missing transcript", stopInput({}, "/nonexistent/transcript_full.jsonl")],
    ["a transcript that is a directory", stopInput({}, FIXTURES)],
  ])("prints {} for %s with no wait", async (_label, input) => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    expect(await runAntigravityStop(h.ctx, fakeAdapters(input))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.err).toEqual([]);
    expect(h.waits.requests).toEqual([]);
  });

  it("prints {} at once for a transcript with no ask result", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const transcript = join(sandbox.root, "transcript_full.jsonl");
    write(transcript, `${JSON.stringify({ type: "USER_INPUT", content: "hi" })}\n`);
    const h = resumeContext(sandbox);
    expect(await runAntigravityStop(h.ctx, fakeAdapters(stopInput({}, transcript)))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
  });

  it("prints {} when AgentDesk is not installed for Antigravity", async () => {
    const sandbox = installSandbox(["cursor"]);
    const h = resumeContext(sandbox);
    expect(await runAntigravityStop(h.ctx, fakeAdapters(stopInput()))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
  });

  it("continues once with the resume message for a phone answer after holding while it was pending", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [
      "pending",
      {
        decision: decision("dec_phone1", {
          answered_via: "app",
          answer: { value: "the private answer" },
        }),
      },
    ]);
    h.waits.script("dec_phone2", ["hang"]);
    const adapters = fakeAdapters(stopInput());
    let exited: number | undefined;
    adapters.exitAfterOutput = (code) => {
      exited = code;
    };
    const { value, elapsed } = await afterScan(h, runAntigravityStop(h.ctx, adapters), 2, {
      stepMs: 10_000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual([continued("dec_phone1")]);
    // The message never carries the answer (DEC-15(7)).
    expect(h.output()).not.toContain("the private answer");
    expect(elapsed).toBe(600_000);
    // The existing waiter route and Antigravity's own connection.
    const first = h.waits.waitRequests("dec_phone1")[0];
    expect(first?.path).toBe("/device/wait");
    expect(first?.method).toBe("POST");
    expect(first?.authorization).toBe(`Bearer ${TOKENS.antigravity}`);
    expect(first?.body).toEqual({ decision_id: "dec_phone1", timeout_seconds: 600 });
    // Only matched AgentDesk ask results were waited on.
    expect(new Set(h.waits.requests.map((r) => r.body.decision_id))).toEqual(
      new Set(["dec_phone1", "dec_phone2"]),
    );
    expect(claimed(sandbox, "dec_phone1")).toBe(true);
    expect(claimed(sandbox, "dec_phone2")).toBe(false);
    // The other decision's wait was stopped, and nothing waits.
    await flush();
    expect(h.waits.open).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
    expect(exited).toBeUndefined();
  });

  it("continues for an expiry with the default applied", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [
      {
        decision: decision("dec_phone1", {
          state: "expired",
          answered_via: "default",
          applied_by_default: true,
        }),
      },
    ]);
    h.waits.script("dec_phone2", ["hang"]);
    await afterScan(h, runAntigravityStop(h.ctx, fakeAdapters(stopInput())), 2);
    expect(h.out).toEqual([continued("dec_phone1")]);
  });

  it("holds while continuationActive is true, which it never reads", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    h.waits.script("dec_phone2", ["hang"]);
    const input = stopInput({ continuationActive: true, executionNum: 10 });
    await afterScan(h, runAntigravityStop(h.ctx, fakeAdapters(input)), 2);
    expect(h.out).toEqual([continued("dec_phone1")]);
  });

  it.each([
    ["a chat settlement", { answered_via: "chat", chat_message: "ship it" }],
    ["a cancel", { state: "cancelled", answer: null, answered_via: null }],
    ["an expiry without a default", { state: "expired", answered_via: null, answer: null }],
  ])("prints {} on %s with no claim", async (_label, fields) => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", ["pending", { decision: decision("dec_phone1", fields) }]);
    h.waits.script("dec_phone2", ["pending", { decision: decision("dec_phone2", fields) }]);
    const run = runAntigravityStop(h.ctx, fakeAdapters(stopInput()));
    const { value } = await afterScan(h, run, 2, { stepMs: 10_000 });
    expect(value).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(claimed(sandbox, "dec_phone1")).toBe(false);
    expect(claimed(sandbox, "dec_phone2")).toBe(false);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it.each(malformedDecisions("dec_phone1"))(
    "prints {} with no claim for a decision with %s",
    async (_label, malformed) => {
      const sandbox = installSandbox(["antigravity"]);
      const h = resumeContext(sandbox);
      h.waits.script("dec_phone1", [{ decision: malformed }]);
      h.waits.script("dec_phone2", ["not_found"]);
      await afterScan(h, runAntigravityStop(h.ctx, fakeAdapters(stopInput())), 2);
      expect(h.out).toEqual(["{}"]);
      expect(h.err).toEqual([]);
      expect(claimed(sandbox, "dec_phone1")).toBe(false);
    },
  );

  it("prints {} when Antigravity's connection is revoked", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [{ status: 401 }]);
    h.waits.script("dec_phone2", [{ status: 401 }]);
    await afterScan(h, runAntigravityStop(h.ctx, fakeAdapters(stopInput())), 2);
    expect(h.out).toEqual(["{}"]);
    expect(h.err).toEqual([]);
  });

  it("delivers a decision that settles while another stays pending", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", ["hang"]);
    h.waits.script("dec_phone2", ["pending", { decision: decision("dec_phone2", {}) }]);
    const run = runAntigravityStop(h.ctx, fakeAdapters(stopInput()));
    const { elapsed } = await afterScan(h, run, 2, { stepMs: 10_000 });
    expect(h.out).toEqual([continued("dec_phone2")]);
    expect(elapsed).toBe(600_000);
    await flush();
    expect(h.waits.open).toBe(0);
    expect(h.waits.aborted).toBeGreaterThanOrEqual(1);
    expect(claimed(sandbox, "dec_phone1")).toBe(false);
  });

  it("a decision that settles without resuming does not end the hold for another", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", { answered_via: "chat" }) }]);
    h.waits.script("dec_phone2", ["pending", "pending", { decision: decision("dec_phone2", {}) }]);
    const run = runAntigravityStop(h.ctx, fakeAdapters(stopInput()));
    const { elapsed } = await afterScan(h, run, 2, { stepMs: 10_000 });
    expect(h.out).toEqual([continued("dec_phone2")]);
    expect(elapsed).toBe(1_200_000);
    expect(claimed(sandbox, "dec_phone1")).toBe(false);
  });

  it("prints {} 50 minutes after the hook starts and stops its requests and timers", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", ["pending"]);
    h.waits.script("dec_phone2", ["network"]);
    const adapters = fakeAdapters(stopInput());
    let exited: number | undefined;
    adapters.exitAfterOutput = (code) => {
      exited = code;
    };
    const { value, elapsed } = await afterScan(h, runAntigravityStop(h.ctx, adapters), 2, {
      stepMs: 1000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(elapsed).toBe(ANTIGRAVITY_HOLD_LIMIT_MS);
    expect(exited).toBe(0);
    await flush();
    expect(h.waits.open).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
    // dec_phone2 retried every 15 seconds for the whole hold.
    expect(h.waits.waitRequests("dec_phone2").length).toBe(ANTIGRAVITY_HOLD_LIMIT_MS / 15_000);
    expect(claimed(sandbox, "dec_phone1")).toBe(false);
  });

  it("counts the 50 minutes from the hook's start, through a late input", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    const input = deferred<string | undefined>();
    const { value, elapsed } = await pump(
      h.clock,
      runAntigravityStop(
        h.ctx,
        fakeAdapters(() => input.promise),
      ),
      { stepMs: 60_000 },
    );
    expect(value).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(elapsed).toBe(ANTIGRAVITY_HOLD_LIMIT_MS);
    // Input that arrives after the limit starts no wait.
    input.resolve(stopInput());
    await flush();
    expect(h.waits.requests).toEqual([]);
  });

  it("lets no settlement that arrives after the limit claim or resume", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    const late = deferred<void>();
    const fetch = h.ctx.fetch;
    // Each request is answered only once the test releases it, after the hold.
    h.ctx.fetch = async (input, init) => {
      await late.promise;
      return fetch(input, init);
    };
    h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    h.waits.script("dec_phone2", [{ decision: decision("dec_phone2", {}) }]);
    const { elapsed } = await pump(h.clock, runAntigravityStop(h.ctx, fakeAdapters(stopInput())), {
      stepMs: 60_000,
    });
    expect(elapsed).toBe(ANTIGRAVITY_HOLD_LIMIT_MS);
    expect(h.out).toEqual(["{}"]);
    late.resolve();
    await flush(10);
    expect(claimed(sandbox, "dec_phone1")).toBe(false);
    expect(claimed(sandbox, "dec_phone2")).toBe(false);
    expect(h.out).toEqual(["{}"]);
  });

  it("does not hold for a resumed decision when it runs again over the same transcript", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const first = resumeContext(sandbox);
    first.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    first.waits.script("dec_phone2", ["hang"]);
    await afterScan(first, runAntigravityStop(first.ctx, fakeAdapters(stopInput())), 2);
    expect(first.out).toEqual([continued("dec_phone1")]);

    // The continuation ends with a new stop: the claimed decision is skipped
    // before any wait, and the other one is still waited on.
    const second = resumeContext(sandbox);
    second.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    second.waits.script("dec_phone2", ["pending", { decision: decision("dec_phone2", {}) }]);
    const input = stopInput({ executionNum: 2, continuationActive: false });
    const { elapsed } = await afterScan(
      second,
      runAntigravityStop(second.ctx, fakeAdapters(input)),
      1,
      { stepMs: 10_000 },
    );
    expect(elapsed).toBe(600_000);
    expect(second.out).toEqual([continued("dec_phone2")]);
    expect(second.waits.waitRequests("dec_phone1")).toEqual([]);

    // Once both are claimed, a third stop prints {} at once with no wait.
    const third = resumeContext(sandbox);
    await afterScan(third, runAntigravityStop(third.ctx, fakeAdapters(stopInput())), 2);
    expect(third.out).toEqual(["{}"]);
    expect(third.waits.requests).toEqual([]);
  });

  it("two concurrent holds over one transcript continue once per decision", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const a = resumeContext(sandbox);
    const b = resumeContext(sandbox);
    for (const h of [a, b]) {
      h.waits.script("dec_phone1", ["pending", { decision: decision("dec_phone1", {}) }]);
      h.waits.script("dec_phone2", ["hang"]);
    }
    await Promise.all([
      afterScan(a, runAntigravityStop(a.ctx, fakeAdapters(stopInput())), 2, { stepMs: 60_000 }),
      afterScan(b, runAntigravityStop(b.ctx, fakeAdapters(stopInput())), 2, { stepMs: 60_000 }),
    ]);
    const outputs = [...a.out, ...b.out].sort();
    expect(outputs).toEqual([continued("dec_phone1"), "{}"].sort());
  });

  it("a waiter on a decision the hold resumed stays silent", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const hold = resumeContext(sandbox);
    hold.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    hold.waits.script("dec_phone2", ["hang"]);
    await afterScan(hold, runAntigravityStop(hold.ctx, fakeAdapters(stopInput())), 2);
    expect(hold.out).toEqual([continued("dec_phone1")]);
    const waiter = resumeContext(sandbox);
    waiter.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    await pump(waiter.clock, waiter.run(["wait", "--harness", "antigravity", "dec_phone1"]));
    expect(waiter.output()).toBe("");
  });

  it("does not wait on a decision whose claim exists before the hold", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    const store = new ResumeStore(h.ctx);
    store.claim("dec_phone1");
    store.claim("dec_phone2");
    h.waits.script("dec_phone1", [{ decision: decision("dec_phone1", {}) }]);
    expect(await runAntigravityStop(h.ctx, fakeAdapters(stopInput()))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
  });

  it("drops a decision whose claim another waiter wins during the hold", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    h.waits.script("dec_phone1", ["pending", { decision: decision("dec_phone1", {}) }]);
    h.waits.script("dec_phone2", ["pending", "pending", { decision: decision("dec_phone2", {}) }]);
    const run = runAntigravityStop(h.ctx, fakeAdapters(stopInput()));
    // Another waiter claims dec_phone1 while the hold waits on it.
    while (h.waits.requests.length < 2) await flush(1);
    new ResumeStore(h.ctx).claim("dec_phone1");
    const { elapsed } = await afterScan(h, run, 2, { stepMs: 10_000 });
    expect(h.out).toEqual([continued("dec_phone2")]);
    expect(elapsed).toBe(1_200_000);
  });
});
