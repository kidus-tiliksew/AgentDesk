import { describe, expect, it } from "vitest";
import {
  type AnswerHelper,
  DEFAULT_LEG_DEADLINE_MS,
  DEFAULT_LEG_TIMEOUT_SECONDS,
  MAX_KEEPALIVE_GAP_MS,
  McpClient,
  PROTOCOL_VERSION,
  readEventStream,
  runSmoke,
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
}

interface FakeOptions {
  tools?: string[];
  sessionHeader?: string | null;
  initializeStatus?: number;
  status?: (args: Json) => unknown;
  ask?: (args: Json, n: number) => unknown;
  // Answers each `await` call; the default answers the first after the
  // helper runs and expires the second after 300 seconds of keepalives.
  await?: (call: AwaitCall, answered: Promise<void>) => Response;
  // Replaces a whole JSON-RPC response for one method or tool.
  override?: (method: string, id: unknown, params: Json) => Response | undefined;
}

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
      { at: 307_000, text: message(call.id, toolResult(EXPIRED)) },
    ]).body,
  );
}

function fakeGateway(clock: FakeClock, options: FakeOptions = {}) {
  const received: Received[] = [];
  const awaits: AwaitCall[] = [];
  const asks: Json[] = [];
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
          tools: (options.tools ?? ["ask", "await", "check", "cancel", "status"]).map((name) => ({
            name,
          })),
        });
      case "tools/call": {
        const args = (params.arguments ?? {}) as Json;
        switch (params.name) {
          case "status":
            return rpc(toolResult(options.status?.(args) ?? { id: "agent_1", state: args.state }));
          case "ask": {
            asks.push(args);
            const n = asks.length;
            return rpc(
              toolResult(
                options.ask?.(args, n) ?? {
                  decision_id: n === 1 ? ANSWERED.id : EXPIRED.id,
                  state: "pending",
                },
              ),
            );
          }
          case "await": {
            const call = {
              id,
              args,
              n: awaits.length + 1,
              clock,
              signal: init?.signal ?? undefined,
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
  return { fetch, received, awaits, asks, answer: () => answer() };
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
    ]);
    expect(fake.received.map((r) => (r.body.params as Json | undefined)?.name)).toEqual([
      undefined,
      undefined,
      undefined,
      "status",
      "ask",
      "await",
      "ask",
      "await",
    ]);
    expect(report).toEqual({
      sessionId: MCP_SESSION,
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
      title: "Smoke: approve this decision",
      input_type: "approve_reject",
      topic: SMOKE_TOPIC,
      idempotency_key: "smoke-run_1-answered",
    });
    expect(fake.asks[1]).toMatchObject({
      input_type: "approve_reject",
      topic: SMOKE_TOPIC,
      default: { kind: "reject" },
      idempotency_key: "smoke-run_1-default",
    });
    // The answered leg moved the clock 5 seconds before the second ask.
    expect(fake.asks[1]?.deadline).toBe(
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
    expect(fake.asks).toHaveLength(1);
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

  it("fails tools/list unless exactly the five tools are listed", async () => {
    for (const tools of [
      ["ask", "await", "check", "cancel"],
      ["ask", "await", "check", "cancel", "status", "answer"],
      ["ask", "await", "check", "cancel", "status", "status"],
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
    expect(error.step).toBe("answered: ask");
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
      { ...EXPIRED, applied_by_default: false },
      { ...EXPIRED, answer: { kind: "approve" } },
      { ...EXPIRED, state: "answered", answered_via: "app" },
      { ...EXPIRED, answered_via: "app" },
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
                        { at: 301_000, text: message(call.id, toolResult(settled)) },
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
                      { at: 301_000, text: message(call.id, toolResult(EXPIRED)) },
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
                      { at: 20_000, text: message(call.id, toolResult(EXPIRED)) },
                    ]).body,
                  ),
          },
        })
      ).result,
    );
    expect(error.step).toBe("default: await");
    expect(error.message).toContain("0 comments");
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
                    { at: 301_000, text: message(call.id, toolResult(EXPIRED)) },
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
