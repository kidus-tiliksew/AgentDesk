import { describe, expect, it } from "vitest";
import { type HelperProcess, runHelperProcess } from "../scripts/helper-process.js";
import {
  type AnswerHelper,
  CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_LEG_DEADLINE_MS,
  DEFAULT_LEG_TIMEOUT_SECONDS,
  MAX_KEEPALIVE_GAP_MS,
  McpClient,
  PROTOCOL_VERSION,
  readEventStream,
  runSmoke,
  SMOKE_CHAT_MESSAGE,
  SMOKE_CONFLICT_MESSAGE,
  SMOKE_NOTE,
  SMOKE_TOPIC,
  SmokeError,
} from "../scripts/smoke-mcp-steps.js";
import { decision } from "./fake.js";

// component-gateway §Verification: the smoke run's steps against a fake
// gateway on a fake clock, so a regression in its assertions is caught
// without a deployment or a real five-minute wait.

const URL = "https://gateway.example";
const TOKEN = `adc_${"s".repeat(43)}`;
const MCP_SESSION = "mcp_session_smoke";
const START = Date.parse("2026-10-11T10:00:00.000Z");

type Json = Record<string, unknown>;

function fakeClock() {
  const clock = { t: START, now: () => clock.t };
  return clock;
}
type FakeClock = ReturnType<typeof fakeClock>;

// One piece of a scripted event stream: text or raw bytes delivered when the
// clock reads `at` ms after the stream opened, optionally after `after`
// resolves.
interface Chunk {
  at: number;
  text?: string;
  bytes?: Uint8Array;
  after?: Promise<void>;
  // Errors the stream instead of delivering text.
  error?: Error;
}

// A stream that delivers one chunk per read, setting the clock first, so each
// chunk arrives at its scripted time. It records whether a reader cancelled it.
function scripted(clock: FakeClock, chunks: Chunk[], signal?: AbortSignal) {
  const base = clock.t;
  const encoder = new TextEncoder();
  const queue = [...chunks];
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = queue.shift();
        if (next === undefined) {
          controller.close();
          return;
        }
        await next.after;
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        clock.t = Math.max(clock.t, base + next.at);
        if (next.error !== undefined) {
          controller.error(next.error);
          return;
        }
        controller.enqueue(next.bytes ?? encoder.encode(next.text ?? ""));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

function message(id: unknown, result: unknown): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

// Keepalive comments every 15 seconds from the opening up to `untilMs`.
function keepalives(untilMs: number, everyMs = 15_000): Chunk[] {
  const chunks: Chunk[] = [];
  for (let at = everyMs; at <= untilMs; at += everyMs) {
    chunks.push({ at, text: ": keepalive\n\n" });
  }
  return chunks;
}

interface Received {
  method: string;
  headers: Headers;
  body: Json;
}

interface AwaitCall {
  id: unknown;
  args: Json;
  // 1 for the answered leg, 2 for the default leg.
  n: number;
  clock: FakeClock;
  signal: AbortSignal | undefined;
  // The arguments of the latest `ask`.
  asked: Json;
}

// A tool result the fake answers with: its JSON and whether it is an error.
interface FakeResult {
  value: unknown;
  isError?: boolean;
}

interface FakeOptions {
  tools?: string[];
  sessionHeader?: string | null;
  initializeStatus?: number;
  status?: (args: Json) => unknown;
  ask?: (args: Json, n: number) => unknown;
  // Answers the nth `resolve` call given every call so far; the default
  // answers the first with the relayed decision and the second with a
  // conflict carrying it.
  resolve?: (args: Json, n: number, calls: Json[]) => FakeResult;
  // Answers each `await` call; the default answers the first after the
  // helper runs and expires the second after 300 seconds of keepalives.
  await?: (call: AwaitCall, answered: Promise<void>) => Response;
  // Replaces a whole JSON-RPC response for one method or tool.
  override?: (method: string, id: unknown, params: Json) => Response | undefined;
}

const STATUS_SESSION = "agent_1";
const RELAYED = decision({
  id: "decision_relayed",
  topic: SMOKE_TOPIC,
  state: "answered",
  interactive: true,
  answer: { kind: "approve" },
  answered_via: "chat",
  answered_at: "2026-10-11T10:00:00.000Z",
  chat_message: SMOKE_CHAT_MESSAGE,
  relayed_by_agent_session_id: STATUS_SESSION,
});
const ANSWERED = decision({
  id: "decision_answered",
  topic: SMOKE_TOPIC,
  state: "answered",
  answer: { kind: "approve" },
  note: SMOKE_NOTE,
  answered_via: "app",
});
const EXPIRED = decision({
  id: "decision_default",
  topic: SMOKE_TOPIC,
  state: "expired",
  answer: { kind: "reject" },
  answered_via: "default",
  applied_by_default: true,
});

// The first `resolve` records its message; a later one conflicts with it.
function defaultResolve(_args: Json, n: number, calls: Json[]): FakeResult {
  const stored = { ...RELAYED, chat_message: calls[0]?.chat_message };
  if (n === 1) {
    return { value: stored };
  }
  return {
    value: {
      error: { code: "conflict", message: "Decision is already answered" },
      decision: stored,
    },
    isError: true,
  };
}

// The decision id for an `ask`, chosen by its leg's idempotency key.
function askedId(args: Json): string {
  const key = String(args.idempotency_key);
  if (key.endsWith("-relayed")) {
    return RELAYED.id;
  }
  return key.endsWith("-answered") ? ANSWERED.id : EXPIRED.id;
}

// The expired decision for the default leg's `ask`, settled at its deadline.
function expiredFor(call: AwaitCall) {
  return { ...EXPIRED, deadline: call.asked.deadline, answered_at: call.asked.deadline };
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function defaultAwait(call: AwaitCall, answered: Promise<void>): Response {
  if (call.n === 1) {
    // One comment before the answer, then the result 3 seconds after it.
    return sseResponse(
      scripted(call.clock, [
        { at: 0, text: ": keepalive\n\n" },
        { at: 0, after: answered, text: "" },
        { at: 0, text: message(call.id, toolResult(ANSWERED)) },
      ]).body,
    );
  }
  return sseResponse(
    scripted(call.clock, [
      ...keepalives(300_000),
      { at: 307_000, text: message(call.id, toolResult(expiredFor(call))) },
    ]).body,
  );
}

function fakeGateway(clock: FakeClock, options: FakeOptions = {}) {
  const received: Received[] = [];
  const awaits: AwaitCall[] = [];
  const asks: Json[] = [];
  const resolves: Json[] = [];
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe(`${URL}/mcp`);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Json;
    const method = String(body.method);
    received.push({ method, headers, body });
    const id = body.id;
    const params = (body.params ?? {}) as Json;
    const overridden = options.override?.(method, id, params);
    if (overridden !== undefined) {
      return overridden;
    }
    const rpc = (result: unknown, extra: Record<string, string> = {}) =>
      Response.json({ jsonrpc: "2.0", id, result }, { headers: extra });

    switch (method) {
      case "initialize": {
        const extra: Record<string, string> = {};
        const header = options.sessionHeader === undefined ? MCP_SESSION : options.sessionHeader;
        if (header !== null) {
          extra["Mcp-Session-Id"] = header;
        }
        if (options.initializeStatus !== undefined) {
          return new Response("unauthorized", { status: options.initializeStatus });
        }
        return rpc(
          { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: {} },
          extra,
        );
      }
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return rpc({
          tools: (options.tools ?? ["ask", "await", "check", "cancel", "resolve", "status"]).map(
            (name) => ({ name }),
          ),
        });
      case "tools/call": {
        const args = (params.arguments ?? {}) as Json;
        switch (params.name) {
          case "status":
            return rpc(
              toolResult(options.status?.(args) ?? { id: STATUS_SESSION, state: args.state }),
            );
          case "ask": {
            asks.push(args);
            const n = asks.length;
            return rpc(
              toolResult(
                options.ask?.(args, n) ?? {
                  decision_id: askedId(args),
                  state: "pending",
                },
              ),
            );
          }
          case "resolve": {
            resolves.push(args);
            const answered = (options.resolve ?? defaultResolve)(args, resolves.length, resolves);
            return rpc(toolResult(answered.value, answered.isError ?? false));
          }
          case "await": {
            const call = {
              id,
              args,
              n: awaits.length + 1,
              clock,
              signal: init?.signal ?? undefined,
              asked: asks.at(-1) ?? {},
            };
            awaits.push(call);
            return (options.await ?? defaultAwait)(call, answered);
          }
        }
        throw new Error(`unexpected tool ${String(params.name)}`);
      }
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { fetch, received, awaits, asks, resolves, answer: () => answer() };
}

interface Run {
  quick?: boolean;
  gateway?: FakeOptions;
  // Replaces the helper; the default settles the decision 5 seconds into the
  // wait.
  answer?: (fake: ReturnType<typeof fakeGateway>, clock: FakeClock) => AnswerHelper;
}

async function run(options: Run = {}) {
  const clock = fakeClock();
  const fake = fakeGateway(clock, options.gateway);
  const lines: string[] = [];
  const helperCalls: { args: Parameters<AnswerHelper>[0]; awaitsBefore: number }[] = [];
  const answer: AnswerHelper =
    options.answer?.(fake, clock) ??
    (async (args) => {
      helperCalls.push({ args, awaitsBefore: fake.awaits.length });
      clock.t += 5_000;
      fake.answer();
    });
  const client = new McpClient({ url: URL, token: TOKEN, fetch: fake.fetch, clock });
  const result = runSmoke({
    client,
    answer,
    clock,
    runId: "run_1",
    quick: options.quick ?? false,
    log: (line) => lines.push(line),
  });
  return { result, fake, lines, helperCalls, clock };
}

async function failure(promise: Promise<unknown>): Promise<SmokeError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the smoke run to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SmokeError);
  return error as SmokeError;
}

describe("runSmoke", () => {
  it("runs every step in order and reports keepalive timing for the default leg", async () => {
    const { result, fake, lines, helperCalls } = await run();
    const report = await result;

    expect(fake.received.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(fake.received.map((r) => (r.body.params as Json | undefined)?.name)).toEqual([
      undefined,
      undefined,
      undefined,
      "status",
      "ask",
      "resolve",
      "resolve",
      "ask",
      "await",
      "ask",
      "await",
    ]);
    expect(report).toEqual({
      sessionId: MCP_SESSION,
      relayed: { decisionId: RELAYED.id },
      answered: { decisionId: ANSWERED.id, settleLatencyMs: 0 },
      defaulted: {
        decisionId: EXPIRED.id,
        keepalive: {
          elapsedMs: 307_000,
          comments: 20,
          firstAtMs: 15_000,
          lastAtMs: 300_000,
          maxGapMs: 15_000,
        },
      },
    });
    expect(lines[0]).toBe(`ok initialize: protocol ${PROTOCOL_VERSION}, Mcp-Session-Id received`);
    expect(lines).toContain(
      `ok relayed leg: ${RELAYED.id} answered in chat by agent session ${STATUS_SESSION}; ` +
        "a second resolve got conflict with the first answer",
    );
    expect(lines.at(-1)).toContain("20 keepalives");
    expect(helperCalls).toEqual([
      {
        args: {
          decisionId: ANSWERED.id,
          answer: { kind: "approve" },
          note: SMOKE_NOTE,
          answeredVia: "app",
        },
        awaitsBefore: 1,
      },
    ]);
  });

  it("sends the credential on every request and the session and version after initialize", async () => {
    const { result, fake } = await run({ quick: true });
    await result;
    for (const [index, request] of fake.received.entries()) {
      expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(request.headers.get("Accept")).toBe("application/json, text/event-stream");
      expect(request.headers.get("Mcp-Session-Id")).toBe(index === 0 ? null : MCP_SESSION);
      expect(request.headers.get("MCP-Protocol-Version")).toBe(
        index === 0 ? null : PROTOCOL_VERSION,
      );
    }
    expect(fake.received[0]?.body.params).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "agentdesk-smoke" },
    });
  });

  it("asks with the smoke topic, fresh idempotency keys, and a five-minute deadline with a default", async () => {
    const { result, fake, clock } = await run();
    const askedAt = START;
    await result;
    expect(fake.asks[0]).toEqual({
      title: "Smoke: approve this decision in chat",
      input_type: "approve_reject",
      topic: SMOKE_TOPIC,
      interactive: true,
      idempotency_key: "smoke-run_1-relayed",
    });
    expect(fake.asks[1]).toEqual({
      title: "Smoke: approve this decision",
      input_type: "approve_reject",
      topic: SMOKE_TOPIC,
      idempotency_key: "smoke-run_1-answered",
    });
    expect(fake.asks[2]).toMatchObject({
      input_type: "approve_reject",
      topic: SMOKE_TOPIC,
      default: { kind: "reject" },
      idempotency_key: "smoke-run_1-default",
    });
    // The answered leg moved the clock 5 seconds before the default leg's ask.
    expect(fake.asks[2]?.deadline).toBe(
      new Date(askedAt + 5_000 + DEFAULT_LEG_DEADLINE_MS).toISOString(),
    );
    expect(fake.awaits.map((call) => call.args.timeout_seconds)).toEqual([
      120,
      DEFAULT_LEG_TIMEOUT_SECONDS,
    ]);
    expect(clock.t).toBeGreaterThan(askedAt);
  });

  it("starts reading the await stream before the answer helper runs", async () => {
    const seen: ReadableStream[] = [];
    const locked: boolean[] = [];
    const { result } = await run({
      quick: true,
      gateway: {
        await: (call, answered) => {
          const stream = scripted(call.clock, [
            { at: 0, after: answered, text: message(call.id, toolResult(ANSWERED)) },
          ]);
          seen.push(stream.body);
          return sseResponse(stream.body);
        },
      },
      answer: (fake) => async () => {
        // The stream is locked to the smoke run's reader.
        locked.push(seen[0]?.locked ?? false);
        fake.answer();
      },
    });
    await result;
    expect(locked).toEqual([true]);
  });

  it("skips only the default leg with --quick", async () => {
    const { result, fake, lines } = await run({ quick: true });
    const report = await result;
    expect(report.defaulted).toBeNull();
    expect(report.relayed).toEqual({ decisionId: RELAYED.id });
    expect(fake.asks).toHaveLength(2);
    expect(fake.resolves).toHaveLength(2);
    expect(fake.awaits).toHaveLength(1);
    expect(lines.at(-1)).toContain("skipped default leg (--quick)");
  });

  it("fails initialize without an Mcp-Session-Id header", async () => {
    const error = await failure((await run({ gateway: { sessionHeader: null } })).result);
    expect(error.step).toBe("initialize");
    expect(error.message).toContain("Mcp-Session-Id");
  });

  it("fails initialize on an HTTP error", async () => {
    const error = await failure((await run({ gateway: { initializeStatus: 401 } })).result);
    expect(error.step).toBe("initialize");
    expect(error.message).toContain("HTTP 401");
  });

  it("fails tools/list unless exactly the six tools are listed", async () => {
    for (const tools of [
      ["ask", "await", "check", "cancel", "status"],
      ["ask", "await", "check", "cancel", "resolve", "status", "answer"],
      ["ask", "await", "check", "cancel", "resolve", "status", "status"],
    ]) {
      const error = await failure((await run({ gateway: { tools } })).result);
      expect(error.step).toBe("tools/list");
    }
  });

  it("fails status when the tool returns an error or another state", async () => {
    const error = await failure(
      (
        await run({
          gateway: {
            override: (method, id, params) =>
              method === "tools/call" && params.name === "status"
                ? Response.json({
                    jsonrpc: "2.0",
                    id,
                    result: toolResult({ error: { code: "invalid", message: "bad topic" } }, true),
                  })
                : undefined,
          },
        })
      ).result,
    );
    expect(error.step).toBe("status");
    expect(error.message).toContain("tool error");

    const wrong = await failure(
      (await run({ gateway: { status: () => ({ state: "blocked" }) } })).result,
    );
    expect(wrong.step).toBe("status");
    expect(wrong.message).toContain('state is "blocked"');
  });

  it("fails ask when the decision is not pending", async () => {
    const error = await failure(
      (await run({ gateway: { ask: () => ({ decision_id: "d", state: "answered" }) } })).result,
    );
    expect(error.step).toBe("relayed: ask");
  });

  it("relays an approve with the fixed chat message, then a reject that must conflict", async () => {
    const { result, fake } = await run({ quick: true });
    await result;
    expect(fake.resolves).toEqual([
      { decision_id: RELAYED.id, answer: { kind: "approve" }, chat_message: SMOKE_CHAT_MESSAGE },
      { decision_id: RELAYED.id, answer: { kind: "reject" }, chat_message: SMOKE_CONFLICT_MESSAGE },
    ]);
  });

  it("fails status without an agent session id", async () => {
    const error = await failure(
      (await run({ gateway: { status: (args) => ({ state: args.state }) } })).result,
    );
    expect(error.step).toBe("status");
    expect(error.message).toContain("no agent session id");
  });

  it.each([
    ["the surface", { answered_via: "app" }, "answered_via"],
    ["the interactive flag", { interactive: false }, "interactive"],
    ["a trimmed message", { chat_message: SMOKE_CHAT_MESSAGE.trim() }, "chat_message"],
    [
      "another relaying session",
      { relayed_by_agent_session_id: "agent_2" },
      "relayed_by_agent_session_id",
    ],
    ["the answer", { answer: { kind: "reject" } }, "answer"],
    ["the state", { state: "pending" }, "state"],
    ["the decision id", { id: "decision_other" }, "decision id"],
  ])("fails the relayed leg on a wrong %s", async (_name, change, field) => {
    const error = await failure(
      (
        await run({
          quick: true,
          gateway: { resolve: () => ({ value: { ...RELAYED, ...change } }) },
        })
      ).result,
    );
    expect(error.step).toBe("relayed: resolve");
    expect(error.message).toContain(`${field} is`);
  });

  it("fails the relayed leg when resolve returns a tool error", async () => {
    const error = await failure(
      (
        await run({
          quick: true,
          gateway: {
            resolve: () => ({
              value: { error: { code: "invalid", message: "chat_message is required" } },
              isError: true,
            }),
          },
        })
      ).result,
    );
    expect(error.step).toBe("relayed: resolve");
    expect(error.message).toContain("tool error");
  });

  it("fails the conflict check when the second resolve succeeds", async () => {
    const error = await failure(
      (await run({ quick: true, gateway: { resolve: () => ({ value: RELAYED }) } })).result,
    );
    expect(error.step).toBe("relayed: conflict");
    expect(error.message).toContain("expected a tool error");
  });

  it.each([
    [
      "another error code",
      { error: { code: "invalid", message: "Answer is invalid" }, decision: RELAYED },
      "error is",
    ],
    [
      "another stored state in the message",
      { error: { code: "conflict", message: "Decision is already expired" }, decision: RELAYED },
      "error is",
    ],
    [
      "no stored decision",
      { error: { code: "conflict", message: "Decision is already answered" } },
      "conflict decision is not an object",
    ],
    [
      "the second answer stored",
      {
        error: { code: "conflict", message: "Decision is already answered" },
        decision: { ...RELAYED, answer: { kind: "reject" } },
      },
      "answer is",
    ],
    [
      "the second message stored",
      {
        error: { code: "conflict", message: "Decision is already answered" },
        decision: { ...RELAYED, chat_message: SMOKE_CONFLICT_MESSAGE },
      },
      "chat_message is",
    ],
  ])("fails the conflict check with %s", async (_name, value, expected) => {
    const error = await failure(
      (
        await run({
          quick: true,
          gateway: {
            resolve: (args, n, calls) =>
              n === 1 ? defaultResolve(args, n, calls) : { value, isError: true },
          },
        })
      ).result,
    );
    expect(error.step).toBe("relayed: conflict");
    expect(error.message).toContain(expected);
  });

  it("fails on a JSON-RPC response for another id or a JSON-RPC error", async () => {
    const wrongId = await failure(
      (
        await run({
          gateway: {
            override: (method) =>
              method === "tools/list"
                ? Response.json({ jsonrpc: "2.0", id: 99, result: { tools: [] } })
                : undefined,
          },
        })
      ).result,
    );
    expect(wrongId.step).toBe("tools/list");
    expect(wrongId.message).toContain("does not match");

    const rpcError = await failure(
      (
        await run({
          gateway: {
            await: (call) =>
              sseResponse(
                scripted(call.clock, [
                  {
                    at: 0,
                    text: `event: message\ndata: ${JSON.stringify({
                      jsonrpc: "2.0",
                      id: call.id,
                      error: { code: -32603, message: "AgentDesk is temporarily unavailable" },
                    })}\n\n`,
                  },
                ]).body,
              ),
          },
        })
      ).result,
    );
    expect(rpcError.step).toBe("answered: await");
    expect(rpcError.message).toContain("-32603");
  });

  it("fails the answered leg on a wrong answer or note", async () => {
    for (const settled of [
      { ...ANSWERED, note: "Something else" },
      { ...ANSWERED, answer: { kind: "reject" } },
      { ...ANSWERED, state: "cancelled" },
      { ...ANSWERED, id: "decision_other" },
    ]) {
      const error = await failure(
        (
          await run({
            gateway: {
              await: (call, answered) =>
                sseResponse(
                  scripted(call.clock, [
                    { at: 0, after: answered, text: message(call.id, toolResult(settled)) },
                  ]).body,
                ),
            },
          })
        ).result,
      );
      expect(error.step).toBe("answered: await");
    }
  });

  it("fails the answered leg when await returns more than 30 seconds after the answer", async () => {
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call, answered) =>
              sseResponse(
                scripted(call.clock, [
                  { at: 0, after: answered, text: ": keepalive\n\n" },
                  { at: 35_001, text: message(call.id, toolResult(ANSWERED)) },
                ]).body,
              ),
          },
        })
      ).result,
    );
    expect(error.step).toBe("answered: await");
    expect(error.message).toContain("30001 ms after the answer");
  });

  it("names the helper step and cancels the stream when the answer helper fails", async () => {
    const streams: { cancelled: boolean }[] = [];
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call, answered) => {
              const stream = scripted(call.clock, [
                { at: 0, after: answered, text: message(call.id, toolResult(ANSWERED)) },
              ]);
              streams.push(stream.state);
              return sseResponse(stream.body);
            },
          },
          answer: () => async () => {
            throw new Error("npx convex run failed (exit 1)");
          },
        })
      ).result,
    );
    expect(error.step).toBe("answered: answer helper");
    expect(error.message).toContain("npx convex run failed");
    expect(streams[0]?.cancelled).toBe(true);
  });

  it("fails await answered with JSON instead of an event stream", async () => {
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call) =>
              Response.json({ jsonrpc: "2.0", id: call.id, result: toolResult(ANSWERED) }),
          },
        })
      ).result,
    );
    expect(error.step).toBe("answered: await");
    expect(error.message).toContain("not text/event-stream");
  });

  it("fails a stream that ends mid-event or without a message", async () => {
    for (const chunks of [
      [{ at: 0, text: `event: message\ndata: {"jsonrpc":"2.0"` }],
      [{ at: 0, text: ": keepalive\n\n" }],
    ]) {
      const error = await failure(
        (
          await run({
            gateway: { await: (call) => sseResponse(scripted(call.clock, chunks).body) },
            answer: () => async () => {},
          })
        ).result,
      );
      expect(error.step).toBe("answered: await");
    }
  });

  it("fails the default leg when the decision does not expire with its default", async () => {
    for (const settled of [
      (call: AwaitCall) => ({ ...expiredFor(call), applied_by_default: false }),
      (call: AwaitCall) => ({ ...expiredFor(call), answer: { kind: "approve" } }),
      (call: AwaitCall) => ({ ...expiredFor(call), state: "answered", answered_via: "app" }),
      (call: AwaitCall) => ({ ...expiredFor(call), answered_via: "app" }),
      // Another deadline than the one asked for.
      (call: AwaitCall) => ({ ...expiredFor(call), deadline: "2026-10-11T10:00:00.000Z" }),
      // Expired a second before its deadline.
      (call: AwaitCall) => ({
        ...expiredFor(call),
        answered_at: new Date(Date.parse(String(call.asked.deadline)) - 1_000).toISOString(),
      }),
      (call: AwaitCall) => ({ ...expiredFor(call), answered_at: null }),
    ]) {
      const error = await failure(
        (
          await run({
            gateway: {
              await: (call, answered) =>
                call.n === 1
                  ? defaultAwait(call, answered)
                  : sseResponse(
                      scripted(call.clock, [
                        ...keepalives(300_000),
                        { at: 301_000, text: message(call.id, toolResult(settled(call))) },
                      ]).body,
                    ),
            },
          })
        ).result,
      );
      expect(error.step).toBe("default: await");
    }
  });

  it("fails the default leg when the decision is still pending at the wait limit", async () => {
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call, answered) =>
              call.n === 1
                ? defaultAwait(call, answered)
                : sseResponse(
                    scripted(call.clock, [
                      ...keepalives(330_000),
                      {
                        at: 330_000,
                        text: message(call.id, {
                          content: [
                            {
                              type: "text",
                              text: JSON.stringify({ state: "pending", decision_id: EXPIRED.id }),
                            },
                            { type: "text", text: "Call await again with the same decision_id" },
                          ],
                          isError: false,
                        }),
                      },
                    ]).body,
                  ),
          },
        })
      ).result,
    );
    expect(error.step).toBe("default: await");
    expect(error.message).toContain("still pending when the 330-second limit elapsed");
  });

  it("fails the default leg when keepalives arrive only at settlement", async () => {
    const buffered: Chunk[] = keepalives(300_000).map((chunk) => ({ ...chunk, at: 301_000 }));
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call, answered) =>
              call.n === 1
                ? defaultAwait(call, answered)
                : sseResponse(
                    scripted(call.clock, [
                      ...buffered,
                      { at: 301_000, text: message(call.id, toolResult(expiredFor(call))) },
                    ]).body,
                  ),
          },
        })
      ).result,
    );
    expect(error.step).toBe("default: await");
    expect(error.message).toContain("largest gap 301000 ms");
  });

  it("fails the default leg without keepalives", async () => {
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call, answered) =>
              call.n === 1
                ? defaultAwait(call, answered)
                : sseResponse(
                    scripted(call.clock, [
                      { at: 301_000, text: message(call.id, toolResult(expiredFor(call))) },
                    ]).body,
                  ),
          },
        })
      ).result,
    );
    expect(error.step).toBe("default: await");
    expect(error.message).toContain("0 comments");
  });

  it("fails the default leg when it settles before the five-minute wait", async () => {
    // A valid expired payload 20 seconds into the wait, after one keepalive.
    const error = await failure(
      (
        await run({
          gateway: {
            await: (call, answered) =>
              call.n === 1
                ? defaultAwait(call, answered)
                : sseResponse(
                    scripted(call.clock, [
                      { at: 15_000, text: ": keepalive\n\n" },
                      { at: 20_000, text: message(call.id, toolResult(expiredFor(call))) },
                    ]).body,
                  ),
          },
        })
      ).result,
    );
    expect(error.step).toBe("default: await");
    expect(error.message).toContain("the five-minute wait was not exercised");
  });

  it("allows the default leg to return up to the clock tolerance before the deadline", async () => {
    // The second ask runs 5 seconds after the start, when the stream opens, so
    // the deadline is DEFAULT_LEG_DEADLINE_MS after the stream opens.
    const returningAt = (offsetMs: number) =>
      run({
        gateway: {
          await: (call, answered) =>
            call.n === 1
              ? defaultAwait(call, answered)
              : sseResponse(
                  scripted(call.clock, [
                    ...keepalives(offsetMs),
                    { at: offsetMs, text: message(call.id, toolResult(expiredFor(call))) },
                  ]).body,
                ),
        },
      });
    const earliest = DEFAULT_LEG_DEADLINE_MS - CLOCK_SKEW_TOLERANCE_MS;
    const passed = await (await returningAt(earliest)).result;
    expect(passed.defaulted?.keepalive.elapsedMs).toBe(earliest);

    const error = await failure((await returningAt(earliest - 1)).result);
    expect(error.step).toBe("default: await");
    expect(error.message).toContain(`${CLOCK_SKEW_TOLERANCE_MS + 1} ms before the deadline`);
  });

  it("allows keepalive gaps up to the tolerance and fails one past it", async () => {
    const withGap = (gapMs: number) =>
      run({
        gateway: {
          await: (call, answered) =>
            call.n === 1
              ? defaultAwait(call, answered)
              : sseResponse(
                  scripted(call.clock, [
                    ...keepalives(150_000),
                    { at: 150_000 + gapMs, text: ": keepalive\n\n" },
                    ...keepalives(300_000).filter((chunk) => chunk.at > 150_000 + gapMs),
                    { at: 301_000, text: message(call.id, toolResult(expiredFor(call))) },
                  ]).body,
                ),
        },
      });
    const passed = await (await withGap(MAX_KEEPALIVE_GAP_MS)).result;
    expect(passed.defaulted?.keepalive.maxGapMs).toBe(MAX_KEEPALIVE_GAP_MS);

    const error = await failure((await withGap(MAX_KEEPALIVE_GAP_MS + 1)).result);
    expect(error.step).toBe("default: await");
    expect(error.message).toContain(`largest gap ${MAX_KEEPALIVE_GAP_MS + 1} ms`);
  });

  it("stops reading an await stream when the run is interrupted", async () => {
    const clock = fakeClock();
    const fake = fakeGateway(clock, {
      await: (call) =>
        sseResponse(
          scripted(call.clock, [{ at: 0, after: new Promise(() => {}), text: "" }], call.signal)
            .body,
        ),
    });
    const stop = new AbortController();
    const client = new McpClient({
      url: URL,
      token: TOKEN,
      fetch: fake.fetch,
      clock,
      signal: stop.signal,
    });
    await client.initialize("initialize");
    const waiting = client.awaitDecision("answered: await", {
      decision_id: ANSWERED.id,
      timeout_seconds: 120,
    });
    expect(fake.awaits[0]?.signal?.aborted).toBe(false);
    stop.abort(new Error("interrupted by SIGINT"));
    expect(fake.awaits[0]?.signal?.aborted).toBe(true);
    const error = await failure(waiting);
    expect(error.message).toContain("interrupted by SIGINT");
  });

  it("stops the answer helper and waits for it when the stream fails while it runs", async () => {
    const blocked = blockedHelper();
    const { result } = await run({
      quick: true,
      gateway: {
        await: (call) =>
          sseResponse(
            scripted(call.clock, [
              { at: 0, text: ": keepalive\n\n" },
              { at: 1_000, after: blocked.started, error: new Error("connection reset") },
            ]).body,
          ),
      },
      answer: () => blocked.helper,
    });
    const error = await failure(result);
    expect(error.step).toBe("answered: await");
    expect(error.message).toContain("connection reset");
    expect(blocked.state).toEqual({ started: true, aborted: true, settled: true });
  });

  it("stops the answer helper and waits for it when the stream ends without a valid result", async () => {
    const endings: [string, (id: unknown) => string][] = [
      ["event stream ended mid-event", () => 'event: message\ndata: {"jsonrpc":"2.0"'],
      ["carried 0 message events", () => ": keepalive\n\n"],
      [
        "JSON-RPC error",
        (id) =>
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: "AgentDesk is temporarily unavailable" },
          })}\n\n`,
      ],
      [
        "tool error",
        (id) =>
          message(id, toolResult({ error: { code: "not_found", message: "Not found" } }, true)),
      ],
    ];
    for (const [reason, ending] of endings) {
      const blocked = blockedHelper();
      const { result } = await run({
        quick: true,
        gateway: {
          await: (call) =>
            sseResponse(
              scripted(call.clock, [{ at: 1_000, after: blocked.started, text: ending(call.id) }])
                .body,
            ),
        },
        answer: () => blocked.helper,
      });
      const error = await failure(result);
      expect(error.step).toBe("answered: await");
      expect(error.message).toContain(reason);
      expect(blocked.state).toEqual({ started: true, aborted: true, settled: true });
    }
  });

  it("stops the answer helper and waits for it when the run is interrupted", async () => {
    const clock = fakeClock();
    const stop = new AbortController();
    const blocked = blockedHelper(() => stop.abort(new Error("interrupted by SIGINT")));
    const fake = fakeGateway(clock, {
      await: (call) =>
        sseResponse(
          scripted(call.clock, [{ at: 0, after: new Promise(() => {}), text: "" }], call.signal)
            .body,
        ),
    });
    const error = await failure(
      runSmoke({
        client: new McpClient({
          url: URL,
          token: TOKEN,
          fetch: fake.fetch,
          clock,
          signal: stop.signal,
        }),
        answer: blocked.helper,
        clock,
        runId: "run_1",
        quick: true,
        log: () => {},
      }),
    );
    expect(error.message).toContain("interrupted by SIGINT");
    expect(blocked.state).toEqual({ started: true, aborted: true, settled: true });
  });
});

// An answer helper that runs until its signal aborts, then settles a tick
// later, the way a killed process exits after its signal. `onStart` runs once
// it has started.
function blockedHelper(onStart: () => void = () => {}) {
  const state = { started: false, aborted: false, settled: false };
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const helper: AnswerHelper = (_args, signal) =>
    new Promise((_resolve, fail) => {
      state.started = true;
      markStarted();
      signal.addEventListener("abort", () => {
        state.aborted = true;
        setTimeout(() => {
          state.settled = true;
          fail(signal.reason);
        }, 0);
      });
      setTimeout(onStart, 0);
    });
  return { helper, state, started };
}

describe("runHelperProcess", () => {
  // A fake process that exits with `code` when `finish` is called, or on the
  // first kill signal it obeys.
  function fakeProcess(obeys: "SIGTERM" | "SIGKILL" = "SIGTERM", stderr = "") {
    const kills: string[] = [];
    const state = { exited: false };
    let exit: (value: { code: number | null; signal: string | null }) => void = () => {};
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      exit = (value) => {
        state.exited = true;
        resolve(value);
      };
    });
    const process: HelperProcess = {
      exited,
      kill(signal) {
        kills.push(signal);
        if (signal === obeys || signal === "SIGKILL") {
          setTimeout(() => exit({ code: null, signal }), 0);
        }
      },
      stderr: () => stderr,
    };
    return { process, kills, state, finish: (code: number) => exit({ code, signal: null }) };
  }

  const limits = (signal: AbortSignal, timeoutMs = 5_000) => ({ signal, timeoutMs, graceMs: 20 });

  it("resolves when the process exits with status 0", async () => {
    const fake = fakeProcess();
    const running = runHelperProcess(() => fake.process, limits(new AbortController().signal));
    fake.finish(0);
    await running;
    expect(fake.kills).toEqual([]);
  });

  it("reports a non-zero exit with the tail of standard error", async () => {
    const fake = fakeProcess("SIGTERM", "Error: Decision not found");
    const running = runHelperProcess(() => fake.process, limits(new AbortController().signal));
    fake.finish(1);
    await expect(running).rejects.toThrow(/exit 1\)\nError: Decision not found/);
  });

  it("terminates the process on abort and rejects only after it exits", async () => {
    const fake = fakeProcess("SIGTERM");
    const stop = new AbortController();
    const running = runHelperProcess(() => fake.process, limits(stop.signal));
    stop.abort(new Error("interrupted by SIGINT"));
    await expect(running).rejects.toThrow("interrupted by SIGINT");
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect(fake.state.exited).toBe(true);
  });

  it("kills a process that ignores SIGTERM once the grace period ends", async () => {
    const fake = fakeProcess("SIGKILL");
    const stop = new AbortController();
    const running = runHelperProcess(() => fake.process, limits(stop.signal));
    stop.abort(new Error("interrupted by SIGINT"));
    await expect(running).rejects.toThrow("interrupted by SIGINT");
    expect(fake.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fake.state.exited).toBe(true);
  });

  it("terminates the process at its timeout", async () => {
    const fake = fakeProcess("SIGTERM");
    const running = runHelperProcess(() => fake.process, limits(new AbortController().signal, 10));
    await expect(running).rejects.toThrow("helper timed out after 10 ms");
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect(fake.state.exited).toBe(true);
  });

  it("starts nothing when the signal has already aborted", async () => {
    const stop = new AbortController();
    stop.abort(new Error("interrupted by SIGINT"));
    let started = false;
    await expect(
      runHelperProcess(() => {
        started = true;
        return fakeProcess().process;
      }, limits(stop.signal)),
    ).rejects.toThrow("interrupted by SIGINT");
    expect(started).toBe(false);
  });
});

describe("readEventStream", () => {
  it("parses events split across UTF-8 sequences and CRLF pairs", async () => {
    const clock = fakeClock();
    const bytes = new TextEncoder().encode(
      ': keepalive\r\n\r\nevent: message\r\ndata: {"note":"héllo ✓"}\r\n\r\n',
    );
    // One byte per chunk, so every boundary falls inside a sequence or pair.
    const chunks: Chunk[] = [...bytes].map((byte, index) => ({
      at: index,
      bytes: new Uint8Array([byte]),
    }));
    const read = await readEventStream(scripted(clock, chunks).body, clock);
    expect(read.truncated).toBe(false);
    expect(read.comments.map((comment) => comment.text)).toEqual([": keepalive"]);
    expect(read.events).toHaveLength(1);
    expect(read.events[0]).toMatchObject({ event: "message", data: '{"note":"héllo ✓"}' });
    expect(JSON.parse(read.events[0]?.data ?? "")).toEqual({ note: "héllo ✓" });
  });

  it("stamps each comment with the time its chunk arrived", async () => {
    const clock = fakeClock();
    const read = await readEventStream(
      scripted(clock, [
        { at: 15_000, text: ": keep" },
        { at: 16_000, text: "alive\n\n: keepalive\n" },
        { at: 30_000, text: "\n" },
      ]).body,
      clock,
    );
    expect(read.comments.map((comment) => comment.at - START)).toEqual([16_000, 16_000]);
    expect(read.truncated).toBe(false);
  });

  it("joins multi-line data and reports a body that ends mid-event", async () => {
    const clock = fakeClock();
    const read = await readEventStream(
      scripted(clock, [{ at: 0, text: "data: a\ndata: b\n\nevent: message\ndata: c" }]).body,
      clock,
    );
    expect(read.events.map((event) => event.data)).toEqual(["a\nb"]);
    expect(read.truncated).toBe(true);
  });
});
