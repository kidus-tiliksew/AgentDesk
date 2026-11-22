import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_HOLD_LIMIT_MS,
  classifyStep,
  MAX_LINE_BYTES,
  parseAntigravityStopInput,
  resultDecisionId,
  runAntigravityStop,
  scanAntigravityTranscript,
  transcriptLines,
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
    // ask followed by another call, an ask made beside another call, an ask
    // followed by the user's text or the agent's text that ends in an
    // ask-shaped object, a result with another key or a settled state, a
    // result after a step that is not an ask call, an ask call in a step that
    // is not the agent's, a result whose step index skips one, a repeated ask
    // result, and a last ask with no result; none of those names a decision.
    expect(await scanAntigravityTranscript(TRANSCRIPT)).toEqual(["dec_phone1", "dec_phone2"]);
  });

  it("accepts only the GENERIC step right after the agent's ask call as its result", () => {
    const ask = JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "call_mcp_tool",
          args: { ServerName: "agentdesk", ToolName: "ask", Arguments: {} },
        },
      ],
    });
    const result = '{"decision_id": "dec_1", "state": "pending"}';
    expect(classifyStep(ask)).toEqual({ kind: "ask-call", index: undefined });
    expect(classifyStep(JSON.stringify({ type: "GENERIC", content: result }))).toEqual({
      kind: "result",
      index: undefined,
      content: result,
    });
    expect(
      classifyStep(JSON.stringify({ type: "GENERIC", content: result, tool_calls: [] })),
    ).toMatchObject({ kind: "result" });
    for (const step of [
      { type: "USER_INPUT", content: result },
      { type: "PLANNER_RESPONSE", content: result },
      { type: "CHECKPOINT", content: result },
      { content: result },
      { type: "GENERIC", content: result, tool_calls: [{ name: "run_command", args: {} }] },
      { type: "GENERIC", content: { text: result } },
      { type: "USER_INPUT", tool_calls: JSON.parse(ask).tool_calls },
      { tool_calls: JSON.parse(ask).tool_calls },
    ]) {
      expect(classifyStep(JSON.stringify(step)), JSON.stringify(step)).toEqual({ kind: "other" });
    }
    expect(classifyStep("not json")).toEqual({ kind: "other" });
    expect(classifyStep(`${ask.slice(0, -1)}`)).toEqual({ kind: "other" });
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
    ["no state", '{"decision_id": "dec_1"}'],
    ["a settled state", '{"decision_id": "dec_1", "state": "answered"}'],
    ["another key", '{"decision_id": "dec_1", "state": "pending", "note": "x"}'],
    ["a nested ask result", '{"result": {"decision_id": "dec_1", "state": "pending"}}'],
    [
      "an ask result followed by another object",
      '{"decision_id": "dec_1", "state": "pending"}\n{"ok": true}',
    ],
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

  // Review round 1: an ask whose result is missing is followed by ordinary
  // text that ends in an ask-shaped object. That text names no decision, so
  // the hook opens no wait and takes no claim for it.
  it("opens no wait for unrelated text that follows an ask with no result", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const transcript = join(sandbox.root, "transcript_full.jsonl");
    const ask = (step_index: number) => ({
      step_index,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "call_mcp_tool",
          args: { ServerName: "agentdesk", ToolName: "ask", Arguments: { title: "Ship it?" } },
        },
      ],
    });
    const shaped = (id: string) => `{"decision_id": "${id}", "state": "pending"}`;
    const steps = [
      { step_index: 0, type: "USER_INPUT", content: "deploy the app" },
      ask(1),
      { step_index: 2, type: "USER_INPUT", content: `Use this one:\n${shaped("dec_user_text")}` },
      ask(3),
      { step_index: 4, type: "PLANNER_RESPONSE", content: `Earlier:\n${shaped("dec_agent_text")}` },
      ask(5),
      { step_index: 6, type: "CHECKPOINT", content: shaped("dec_checkpoint_text") },
      ask(7),
    ];
    write(transcript, steps.map((step) => `${JSON.stringify(step)}\n`).join(""));
    const h = resumeContext(sandbox);
    for (const id of ["dec_user_text", "dec_agent_text", "dec_checkpoint_text"]) {
      h.waits.script(id, [{ decision: decision(id, {}) }]);
    }
    expect(await scanAntigravityTranscript(transcript)).toEqual([]);
    expect(await runAntigravityStop(h.ctx, fakeAdapters(stopInput({}, transcript)))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
    for (const id of ["dec_user_text", "dec_agent_text", "dec_checkpoint_text"]) {
      expect(claimed(sandbox, id)).toBe(false);
    }
  });

  it("waits only on the fixture's two ask results", async () => {
    const sandbox = installSandbox(["antigravity"]);
    const h = resumeContext(sandbox);
    // Every decision the fixture's other steps name would resume at once.
    for (const id of [
      "dec_other_server",
      "dec_status_tool",
      "dec_after_other_call",
      "dec_ambiguous",
      "dec_user_text",
      "dec_agent_text",
      "dec_extra_key",
      "dec_settled",
      "dec_orphan_result",
      "dec_wrong_call_type",
      "dec_index_gap",
    ]) {
      h.waits.script(id, [{ decision: decision(id, {}) }]);
    }
    h.waits.script("dec_phone1", ["hang"]);
    h.waits.script("dec_phone2", ["pending", { decision: decision("dec_phone2", {}) }]);
    const run = runAntigravityStop(h.ctx, fakeAdapters(stopInput()));
    await afterScan(h, run, 2, { stepMs: 10_000 });
    expect(h.out).toEqual([continued("dec_phone2")]);
    expect(new Set(h.waits.requests.map((r) => r.body.decision_id))).toEqual(
      new Set(["dec_phone1", "dec_phone2"]),
    );
    expect(readdirSync(join(resumeRoot(sandbox), "claims"))).toEqual(["dec_phone2"]);
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

// Review round 2: the scan read only the first 256 MiB of the transcript, a
// bound the Codex hook keeps for its 8-second budget. No confirmed document
// sets a byte limit for Antigravity, so the scan now reads to the end in
// 1 MiB pieces, holding at most one line of at most 16 MiB, and only the
// 50-minute hold limit bounds it (AC-12.1, AC-12.2, AC-12.9).
describe("long Antigravity transcripts", () => {
  /** The 256 MiB the scan used to stop at. */
  const OLD_CUTOFF = 256 * 1024 * 1024;

  function askLines(id: string, from: number): string {
    return [
      {
        step_index: from,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "call_mcp_tool",
            args: { ServerName: "agentdesk", ToolName: "ask", Arguments: { title: "Late?" } },
          },
        ],
      },
      {
        step_index: from + 1,
        type: "GENERIC",
        content: `Created At: 2026-11-22T10:00:01Z\n{"decision_id": "${id}", "state": "pending"}`,
      },
    ]
      .map((step) => `${JSON.stringify(step)}\n`)
      .join("");
  }

  async function* chunked(text: Buffer, size: number): AsyncGenerator<Buffer> {
    for (let i = 0; i < text.length; i += size) yield text.subarray(i, i + size);
  }

  async function collect(text: Buffer, size: number, max?: number) {
    const lines: (string | undefined)[] = [];
    for await (const line of transcriptLines(chunked(text, size), max)) lines.push(line);
    return lines;
  }

  it("splits lines across pieces, keeps multibyte text whole, and drops CR and the last newline", async () => {
    const text = Buffer.from("first\r\nsé cond ✓\n\nlast", "utf8");
    for (const size of [1, 2, 3, 7, 64]) {
      expect(await collect(text, size)).toEqual(["first", "sé cond ✓", "", "last"]);
    }
    expect(await collect(Buffer.from("a\n"), 1)).toEqual(["a"]);
    expect(await collect(Buffer.alloc(0), 4)).toEqual([]);
  });

  it("reads past a line longer than the limit and yields undefined for it", async () => {
    const text = Buffer.from(`short\n${"x".repeat(20)}\nafter\n${"y".repeat(11)}`);
    for (const size of [1, 3, 8, 64]) {
      expect(await collect(text, size, 10)).toEqual(["short", undefined, "after", undefined]);
    }
    // A line of exactly the limit is kept.
    expect(await collect(Buffer.from(`${"z".repeat(10)}\n`), 4, 10)).toEqual(["z".repeat(10)]);
  });

  describe("a transcript longer than 256 MiB", () => {
    let dir: string;
    let transcript: string;
    let lateOffset: number;

    beforeAll(() => {
      // Valid JSONL steps up to past the old cutoff, then one ask and its
      // result. Written in 1 MiB blocks, so memory stays small.
      // Its own directory: the shared sandboxes are removed after each test.
      dir = mkdtempSync(join(tmpdir(), "agentdesk-long-transcript-"));
      transcript = join(dir, "transcript_full.jsonl");
      const fd = openSync(transcript, "w");
      try {
        const line = `${JSON.stringify({
          step_index: 0,
          type: "PLANNER_RESPONSE",
          content: "Reading the repository. ".repeat(40),
        })}\n`;
        const block = Buffer.from(line.repeat(Math.floor((1024 * 1024) / line.length)));
        let written = 0;
        while (written <= OLD_CUTOFF + 4 * 1024 * 1024) written += writeSync(fd, block);
        lateOffset = written;
        writeSync(fd, askLines("dec_late", 900_000));
      } finally {
        closeSync(fd);
      }
    }, 120_000);

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("finds an ask and its result after the first 256 MiB", async () => {
      expect(lateOffset).toBeGreaterThan(OLD_CUTOFF);
      expect(statSync(transcript).size).toBeGreaterThan(OLD_CUTOFF);
      expect(await scanAntigravityTranscript(transcript)).toEqual(["dec_late"]);
    }, 120_000);

    it("holds on that decision and continues for a phone answer", async () => {
      const sandbox = installSandbox(["antigravity"]);
      const h = resumeContext(sandbox);
      h.waits.script("dec_late", ["pending", { decision: decision("dec_late", {}) }]);
      const run = runAntigravityStop(h.ctx, fakeAdapters(stopInput({}, transcript)));
      let done = false;
      run.then(() => {
        done = true;
      });
      // The scan of the long file reads while the fake clock stands still.
      const deadline = Date.now() + 110_000;
      while (h.waits.requests.length < 1) {
        if (done || Date.now() > deadline) throw new Error("the hook opened no wait");
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(h.clock.now).toBe(0);
      await pump(h.clock, run, { stepMs: 10_000 });
      expect(h.out).toEqual([continued("dec_late")]);
      expect(h.clock.now).toBe(600_000);
    }, 120_000);

    it("stops reading at once when the hold's limit aborts the scan", async () => {
      const stop = new AbortController();
      const scan = scanAntigravityTranscript(transcript, stop.signal);
      await new Promise((resolve) => setImmediate(resolve));
      const started = Date.now();
      stop.abort();
      await expect(scan).rejects.toBeInstanceOf(HookCancelledError);
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 120_000);
  });

  it("reads past a line over 16 MiB and still finds a later ask", async () => {
    const sandbox = makeSandbox();
    const transcript = join(sandbox.root, "transcript_full.jsonl");
    // An ask call, then a line over 16 MiB that starts with `{` and runs on
    // as a sparse run of NUL bytes, so the test writes little. The ask names
    // nothing, because the long line is not its result. A later ask and its
    // result are found.
    const head = Buffer.from(`${askLines("dec_unused", 0).split("\n")[0]}\n{`);
    const longEnd = head.length + MAX_LINE_BYTES + 4096;
    const tail = Buffer.from(`\n${askLines("dec_after_long_line", 10)}`);
    const fd = openSync(transcript, "w");
    try {
      writeSync(fd, head, 0, head.length, 0);
      writeSync(fd, tail, 0, tail.length, longEnd);
    } finally {
      closeSync(fd);
    }
    expect(statSync(transcript).size).toBe(longEnd + tail.length);
    expect(await scanAntigravityTranscript(transcript)).toEqual(["dec_after_long_line"]);
  });
});
