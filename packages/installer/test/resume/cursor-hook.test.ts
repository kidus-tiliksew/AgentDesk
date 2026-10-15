import { existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_HOLD_LIMIT_MS,
  parseAfterMcpInput,
  runCursorAfterMcp,
  runCursorStop,
} from "../../src/resume/cursor.js";
import { ResumeStore } from "../../src/resume/storage.js";
import { cleanupSandboxes, makeContext, mode, write } from "../helpers.js";
import {
  decision,
  FIXTURES,
  fakeAdapters,
  installSandbox,
  pump,
  resumeContext,
  resumeRoot,
  TOKENS,
} from "./helpers.js";

// component-resume §Cursor hooks: `after-mcp` records each `ask` result's
// decision against its conversation; `stop` holds on the conversation's
// decisions for at most 50 minutes and returns the resume message as
// `followup_message`.

afterEach(cleanupSandboxes);

const CONVERSATION = "c0ffee00-1111-4222-8333-444455556666";
const AFTER_MCP = readFileSync(join(FIXTURES, "cursor-after-mcp-input.json"), "utf8");
const STOP = readFileSync(join(FIXTURES, "cursor-stop-input.json"), "utf8");

function message(id: string): string {
  return `AgentDesk decision ${id} settled. Read it with check, tell the user the answer and where it was given, then act on it.`;
}

function withFields(json: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(json), ...fields });
}

function recordDecisions(sandbox: ReturnType<typeof installSandbox>, ...ids: string[]) {
  const h = makeContext(sandbox);
  const store = new ResumeStore(h.ctx);
  for (const id of ids) store.recordCursorDecision(CONVERSATION, id);
}

describe("agentdesk hook after-mcp --harness cursor", () => {
  it("records the decision from the first content item of result_json and prints {}", async () => {
    const sandbox = installSandbox(["cursor"]);
    const h = makeContext(sandbox);
    expect(await runCursorAfterMcp(h.ctx, fakeAdapters(AFTER_MCP))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    const dir = join(resumeRoot(sandbox), "cursor", CONVERSATION);
    expect(readdirSync(dir)).toEqual(["dec_cursor1"]);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "dec_cursor1"))).toBe(0o600);
    expect(readFileSync(join(dir, "dec_cursor1"), "utf8")).toBe("");
  });

  it("accepts result_json given as an object", () => {
    const input = JSON.parse(AFTER_MCP);
    input.result_json = JSON.parse(input.result_json);
    expect(parseAfterMcpInput(JSON.stringify(input))).toEqual({
      conversationId: CONVERSATION,
      decisionId: "dec_cursor1",
    });
  });

  it.each([
    ["another tool", withFields(AFTER_MCP, { tool_name: "status" })],
    ["another server", withFields(AFTER_MCP, { mcp_server_name: "github" })],
    ["no input", undefined],
    ["input that is not JSON", "{"],
    ["result_json that is not JSON", withFields(AFTER_MCP, { result_json: "{" })],
    ["no content", withFields(AFTER_MCP, { result_json: JSON.stringify({ content: [] }) })],
    [
      "a first item that is not JSON",
      withFields(AFTER_MCP, {
        result_json: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      }),
    ],
    ["an unsafe conversation id", withFields(AFTER_MCP, { conversation_id: "../../x" })],
    [
      "an unsafe decision id",
      withFields(AFTER_MCP, {
        result_json: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ decision_id: "../x" }) }],
        }),
      }),
    ],
  ])("records nothing for %s and prints {}", async (_label, input) => {
    const sandbox = installSandbox(["cursor"]);
    const h = makeContext(sandbox);
    expect(await runCursorAfterMcp(h.ctx, fakeAdapters(input))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(existsSync(join(resumeRoot(sandbox), "cursor", CONVERSATION))).toBe(false);
  });
});

describe("agentdesk hook stop --harness cursor", () => {
  it("prints {} at once without records", async () => {
    const sandbox = installSandbox(["cursor"]);
    const h = resumeContext(sandbox);
    expect(await runCursorStop(h.ctx, fakeAdapters(STOP))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
  });

  it.each(["aborted", "error", undefined])("prints {} at once for status %s", async (status) => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    h.waits.script("dec_cursor1", [{ decision: decision("dec_cursor1", {}) }]);
    expect(await runCursorStop(h.ctx, fakeAdapters(withFields(STOP, { status })))).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
  });

  it.each([
    ["no input", undefined],
    ["input that is not JSON", "nope"],
    ["an unsafe conversation id", withFields(STOP, { conversation_id: "../x" })],
  ])("prints {} for %s", async (_label, input) => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    expect(await runCursorStop(h.ctx, fakeAdapters(input))).toBe(0);
    expect(h.out).toEqual(["{}"]);
  });

  it("returns one followup_message for a phone answer after holding while it was pending", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    h.waits.script("dec_cursor1", [
      "pending",
      { decision: decision("dec_cursor1", { answered_via: "app" }) },
    ]);
    const { value, elapsed } = await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)), {
      stepMs: 10_000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual([JSON.stringify({ followup_message: message("dec_cursor1") })]);
    expect(elapsed).toBe(600_000);
    expect(h.waits.requests[0]?.authorization).toBe(`Bearer ${TOKENS.cursor}`);
    expect(h.waits.requests[0]?.body).toEqual({ decision_id: "dec_cursor1", timeout_seconds: 600 });
    expect(existsSync(join(resumeRoot(sandbox), "claims", "dec_cursor1"))).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("returns a followup_message for an expiry with the default applied", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    h.waits.script("dec_cursor1", [
      {
        decision: decision("dec_cursor1", {
          state: "expired",
          answered_via: "default",
          applied_by_default: true,
        }),
      },
    ]);
    await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)));
    expect(h.out).toEqual([JSON.stringify({ followup_message: message("dec_cursor1") })]);
  });

  it.each([
    ["a chat settlement", { answered_via: "chat", chat_message: "ship it" }],
    ["a cancel", { state: "cancelled", answer: null, answered_via: null }],
  ])("prints {} on %s and keeps the record", async (_label, fields) => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    h.waits.script("dec_cursor1", ["pending", { decision: decision("dec_cursor1", fields) }]);
    const { value } = await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)), {
      stepMs: 10_000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(existsSync(join(resumeRoot(sandbox), "claims", "dec_cursor1"))).toBe(false);
    expect(readdirSync(join(resumeRoot(sandbox), "cursor", CONVERSATION))).toEqual(["dec_cursor1"]);
  });

  it("prints {} when the decision's claim exists", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    new ResumeStore(h.ctx).claim("dec_cursor1");
    h.waits.script("dec_cursor1", [{ decision: decision("dec_cursor1", {}) }]);
    await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)));
    expect(h.out).toEqual(["{}"]);
  });

  it("prints {} 50 minutes after the hold starts and stops its requests and timers", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_a", "dec_b");
    const h = resumeContext(sandbox);
    h.waits.script("dec_a", ["pending"]);
    h.waits.script("dec_b", ["network"]);
    const { value, elapsed } = await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)), {
      stepMs: 1000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual(["{}"]);
    expect(elapsed).toBe(CURSOR_HOLD_LIMIT_MS);
    // The pending request open at the limit was aborted, and nothing waits.
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.waits.open).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
    // dec_b retried every 15 seconds for the whole hold.
    expect(h.waits.waitRequests("dec_b").length).toBe(CURSOR_HOLD_LIMIT_MS / 15_000);
  });

  it("delivers a settled decision while another recorded decision stays pending", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_a_pending", "dec_b_phone");
    const h = resumeContext(sandbox);
    h.waits.script("dec_a_pending", ["hang"]);
    h.waits.script("dec_b_phone", ["pending", { decision: decision("dec_b_phone", {}) }]);
    const { elapsed } = await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)), {
      stepMs: 10_000,
    });
    expect(h.out).toEqual([JSON.stringify({ followup_message: message("dec_b_phone") })]);
    expect(elapsed).toBe(600_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.waits.open).toBe(0);
    expect(h.waits.aborted).toBeGreaterThanOrEqual(1);
  });

  it("two concurrent holds on one conversation deliver once", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const a = resumeContext(sandbox);
    const b = resumeContext(sandbox);
    for (const h of [a, b]) {
      h.waits.script("dec_cursor1", ["pending", { decision: decision("dec_cursor1", {}) }]);
    }
    await Promise.all([
      pump(a.clock, runCursorStop(a.ctx, fakeAdapters(STOP)), { stepMs: 60_000 }),
      pump(b.clock, runCursorStop(b.ctx, fakeAdapters(STOP)), { stepMs: 60_000 }),
    ]);
    const outputs = [...a.out, ...b.out].sort();
    expect(outputs).toEqual(
      [JSON.stringify({ followup_message: message("dec_cursor1") }), "{}"].sort(),
    );
  });

  it("an overtaken hold and the newer hold share the claim, and a waiter on the same decision stays silent", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const older = resumeContext(sandbox);
    older.waits.script("dec_cursor1", [{ decision: decision("dec_cursor1", {}) }]);
    await pump(older.clock, runCursorStop(older.ctx, fakeAdapters(STOP)));
    expect(older.out).toEqual([JSON.stringify({ followup_message: message("dec_cursor1") })]);
    const newer = resumeContext(sandbox);
    newer.waits.script("dec_cursor1", [{ decision: decision("dec_cursor1", {}) }]);
    await pump(
      newer.clock,
      runCursorStop(newer.ctx, fakeAdapters(withFields(STOP, { loop_count: 1 }))),
    );
    expect(newer.out).toEqual(["{}"]);
    const waiter = resumeContext(sandbox);
    waiter.waits.script("dec_cursor1", [{ decision: decision("dec_cursor1", {}) }]);
    await pump(waiter.clock, waiter.run(["wait", "--harness", "cursor", "dec_cursor1"]));
    expect(waiter.output()).toBe("");
  });

  it("deletes records older than 7 days and prints {} when none remain", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_old");
    const other = join(resumeRoot(sandbox), "cursor", "conv-other", "dec_recent");
    write(other, "");
    const now = Date.now();
    const day = 24 * 60 * 60;
    const old = join(resumeRoot(sandbox), "cursor", CONVERSATION, "dec_old");
    utimesSync(old, now / 1000 - 8 * day, now / 1000 - 8 * day);
    utimesSync(other, now / 1000 - 6 * day, now / 1000 - 6 * day);
    const h = resumeContext(sandbox, { now });
    h.waits.script("dec_old", [{ decision: decision("dec_old", {}) }]);
    await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)));
    expect(h.out).toEqual(["{}"]);
    expect(h.waits.requests).toEqual([]);
    expect(existsSync(join(resumeRoot(sandbox), "cursor", CONVERSATION))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("prints {} when Cursor's connection is revoked", async () => {
    const sandbox = installSandbox(["cursor"]);
    recordDecisions(sandbox, "dec_cursor1");
    const h = resumeContext(sandbox);
    h.waits.script("dec_cursor1", [{ status: 401 }]);
    await pump(h.clock, runCursorStop(h.ctx, fakeAdapters(STOP)));
    expect(h.out).toEqual(["{}"]);
    expect(h.err).toEqual([]);
  });
});
