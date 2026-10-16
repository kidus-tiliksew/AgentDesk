import type { Decision } from "@agentdesk/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "../src/await.js";
import { ServiceError, UpstreamError } from "../src/convex.js";
import { handle } from "../src/index.js";
import { KEEPALIVE_MS } from "../src/sse.js";
import { AWAIT_AGAIN } from "../src/tools.js";
import {
  AGENT_SESSION,
  decision,
  env,
  fakeConvex,
  mcpRequest,
  parseEvents,
  rpc,
  USER,
} from "./fake.js";

// component-gateway §Verification: `await` timing under fake timers with the
// Convex client faked. Each test reads the event stream as it arrives.

const ANSWERED = decision({
  state: "answered",
  answer: { kind: "approve" },
  note: "Go ahead",
  answered_at: "2026-10-11T00:01:00.000Z",
  answered_via: "app",
});

// A decision whose state a test changes mid-wait. Each poll reads it when the
// poll starts and delivers that snapshot `latencyMs` later, so a settlement
// during the delay reaches the gateway only on the next poll.
function stored(latencyMs = 0) {
  const store: { current: Decision } = { current: decision() };
  const convex = fakeConvex({
    "decisions/poll": async () => {
      const snapshot = store.current;
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      return snapshot;
    },
  });
  const polls = () => convex.calls.filter((call) => call.route === "decisions/poll");
  return { store, convex, polls };
}

// Starts an `await` call and reads its stream in the background. `elapsed`
// is the fake-clock time since the call started.
async function start(
  svc: ReturnType<typeof fakeConvex>["svc"],
  args: Record<string, unknown>,
  init: { signal?: AbortSignal; id?: number } = {},
) {
  const request = mcpRequest(rpc("tools/call", { name: "await", arguments: args }, init.id ?? 1));
  const t0 = Date.now();
  const response = await handle(
    init.signal === undefined ? request : new Request(request, { signal: init.signal }),
    env,
    svc,
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const state = { text: "", ended: false, endedAt: -1 };
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        state.ended = true;
        state.endedAt = Date.now() - t0;
        return;
      }
      state.text += decoder.decode(chunk.value, { stream: true });
    }
  })();
  // Let the first poll run.
  await vi.advanceTimersByTimeAsync(0);
  return {
    response,
    reader,
    state,
    events: () => parseEvents(state.text),
    elapsed: () => Date.now() - t0,
  };
}

// Counts the abort listeners each signal holds, so a test can assert that a
// terminal path removed every one it added.
function trackAbortListeners() {
  type Listen = (this: EventTarget, type: string, listener: unknown, options?: unknown) => void;
  const proto = EventTarget.prototype as unknown as {
    addEventListener: Listen;
    removeEventListener: Listen;
  };
  const live = new Map<EventTarget, Set<unknown>>();
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  vi.spyOn(proto, "addEventListener").mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    if (type === "abort") {
      const set = live.get(this) ?? new Set();
      set.add(listener);
      live.set(this, set);
    }
    add.call(this, type, listener, options);
  });
  vi.spyOn(proto, "removeEventListener").mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    if (type === "abort") {
      live.get(this)?.delete(listener);
    }
    remove.call(this, type, listener, options);
  });
  return (target: EventTarget) => live.get(target)?.size ?? 0;
}

function resultOf(message: unknown) {
  const { result } = message as { result: { content: { text: string }[]; isError: boolean } };
  return result;
}

describe("await", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers with an event stream", async () => {
    const { convex } = stored();
    const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: 5 });

    expect(wait.response.status).toBe(200);
    expect(wait.response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(wait.response.headers.get("Cache-Control")).toBe("no-cache");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wait.state.ended).toBe(true);
  });

  it.each([
    ["answered", ANSWERED],
    [
      "expired",
      decision({ state: "expired", answer: { kind: "reject" }, applied_by_default: true }),
    ],
    ["cancelled", decision({ state: "cancelled" })],
  ])("returns an already %s decision on the first poll and leaves no timer", async (_, settled) => {
    const convex = fakeConvex({ "decisions/poll": () => settled });

    const wait = await start(convex.svc, { decision_id: "decision_1" });

    expect(wait.state.ended).toBe(true);
    expect(wait.state.endedAt).toBe(0);
    expect(convex.routes().filter((route) => route === "decisions/poll")).toHaveLength(1);
    const { comments, messages } = wait.events();
    expect(comments).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(resultOf(messages[0])).toEqual({
      content: [{ type: "text", text: JSON.stringify(settled) }],
      isError: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls every 15 seconds", () => {
    expect(POLL_INTERVAL_MS).toBe(15_000);
  });

  it.each([
    // A poll at 0 s reads pending; the decision settles 1 ms later. The poll
    // at 15 s reads it and answers just under the 10-second service timeout.
    ["after the first poll's snapshot", 1, 15_000],
    // The same after the second poll's snapshot, at 15 s.
    ["after a later poll's snapshot", 15_001, 30_000],
  ])(
    "returns a decision settled just %s within 25 seconds, with 9,999 ms latency",
    async (_, settleAt, nextPoll) => {
      const latency = 9_999;
      const { store, convex, polls } = stored(latency);
      const wait = await start(convex.svc, { decision_id: "decision_1" });

      await vi.advanceTimersByTimeAsync(settleAt);
      store.current = ANSWERED;
      const returnAt = nextPoll + latency;

      await vi.advanceTimersByTimeAsync(returnAt - settleAt - 1);
      expect(wait.state.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(wait.state.ended).toBe(true);
      expect(wait.state.endedAt).toBe(returnAt);
      expect(wait.state.endedAt - settleAt).toBeLessThanOrEqual(25_000);
      expect(wait.state.endedAt - settleAt).toBeLessThan(30_000);
      expect(polls()).toHaveLength(nextPoll / 15_000 + 1);
      expect(resultOf(wait.events().messages.at(-1))).toEqual({
        content: [{ type: "text", text: JSON.stringify(ANSWERED) }],
        isError: false,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("starts polls 15 seconds apart on the call's clock, whatever the latency", async () => {
    const { convex, polls } = stored(3_000);
    const startedAt: number[] = [];
    const t0 = Date.now();
    const svc: typeof convex.svc = (route, body, signal) => {
      if (route === "decisions/poll") {
        startedAt.push(Date.now() - t0);
      }
      return convex.svc(route, body, signal);
    };

    await start(svc, { decision_id: "decision_1", timeout_seconds: 100 });
    await vi.advanceTimersByTimeAsync(100_000);

    expect(startedAt).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);
    expect(polls()).toHaveLength(7);
  });

  it.each([
    [1, 1],
    [15, 1],
    [16, 2],
    [30, 2],
    [300, 20],
    [600, 40],
  ])(
    "with timeout_seconds %i polls %i times and returns pending at the limit",
    async (seconds, expected) => {
      const { convex, polls } = stored();
      const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: seconds });

      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(wait.state.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(wait.state.ended).toBe(true);
      expect(wait.state.endedAt).toBe(seconds * 1000);

      expect(polls()).toHaveLength(expected);
      // Nothing but polls: the decision is unchanged (req-agent-tools AC-3.2).
      expect(new Set(convex.routes().slice(2))).toEqual(new Set(["decisions/poll"]));
      const { messages } = wait.events();
      expect(messages).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ state: "pending", decision_id: "decision_1" }),
              },
              { type: "text", text: AWAIT_AGAIN },
            ],
            isError: false,
          },
        },
      ]);
      expect(AWAIT_AGAIN).toBe("Call await again with the same decision_id");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("waits 300 seconds when called without timeout_seconds", async () => {
    const { convex, polls } = stored();
    const wait = await start(convex.svc, { decision_id: "decision_1" });

    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(wait.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.state.ended).toBe(true);
    expect(polls()).toHaveLength(20);
  });

  it("returns pending at the limit when a poll hangs past it, and cancels that poll", async () => {
    const signals: AbortSignal[] = [];
    const convex = fakeConvex({
      "decisions/poll": (_body, signal) => {
        if (signal !== undefined) {
          signals.push(signal);
        }
        // The second poll never answers and ignores its signal.
        return signals.length === 1 ? decision() : new Promise(() => {});
      },
    });
    const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: 30 });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(wait.state.ended).toBe(true);
    expect(wait.state.endedAt).toBe(30_000);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(true);
    const text = resultOf(wait.events().messages[0]).content[0]?.text;
    expect(JSON.parse(text ?? "")).toEqual({ state: "pending", decision_id: "decision_1" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["the limit", false],
    ["a client disconnect", true],
  ])(
    "removes every abort listener when %s abandons a poll that never settles",
    async (_, disconnect) => {
      const listeners = trackAbortListeners();
      const signals: AbortSignal[] = [];
      const convex = fakeConvex({
        "decisions/poll": (_body, signal) => {
          if (signal !== undefined) {
            signals.push(signal);
          }
          return new Promise(() => {});
        },
      });
      const client = new AbortController();
      const wait = await start(
        convex.svc,
        { decision_id: "decision_1", timeout_seconds: 30 },
        { signal: client.signal },
      );
      expect(signals).toHaveLength(1);
      const poll = signals[0] as AbortSignal;
      expect(listeners(poll)).toBeGreaterThan(0);

      if (disconnect) {
        await vi.advanceTimersByTimeAsync(10_000);
        client.abort();
      }
      await vi.advanceTimersByTimeAsync(30_000);

      expect(wait.state.ended).toBe(true);
      expect(poll.aborted).toBe(true);
      expect(listeners(poll)).toBe(0);
      expect(listeners(client.signal)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["answers", false],
    ["fails", true],
  ])("writes nothing more when a cancelled poll %s late", async (_, fails) => {
    let settle: (() => void) | undefined;
    const convex = fakeConvex({
      // The poll ignores its signal and settles only when the test says.
      "decisions/poll": () =>
        new Promise((resolve, reject) => {
          settle = () =>
            fails
              ? reject(new UpstreamError("Service call decisions/poll failed"))
              : resolve(ANSWERED);
        }),
    });
    const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: 5 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(wait.state.ended).toBe(true);
    const text = wait.state.text;
    settle?.();
    await vi.advanceTimersByTimeAsync(60_000);

    // An unobserved rejection would fail this test run.
    expect(wait.state.text).toBe(text);
    expect(wait.events().messages).toHaveLength(1);
    expect(JSON.parse(resultOf(wait.events().messages[0]).content[0]?.text ?? "")).toEqual({
      state: "pending",
      decision_id: "decision_1",
    });
    expect(convex.routes().filter((route) => route === "decisions/poll")).toHaveLength(1);
  });

  it("sends a keepalive comment every 15 seconds, then one message, then ends", async () => {
    const { convex } = stored();
    const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: 50 });

    for (const keepalives of [1, 2, 3]) {
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS - 1);
      expect(wait.events().comments).toHaveLength(keepalives - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wait.events().comments).toHaveLength(keepalives);
    }
    expect(wait.events().messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(wait.state.ended).toBe(true);
    expect(
      wait.state.text.startsWith(": keepalive\n\n: keepalive\n\n: keepalive\n\nevent: message\n"),
    ).toBe(true);
    expect(wait.events()).toMatchObject({
      comments: [": keepalive", ": keepalive", ": keepalive"],
      messages: [{ jsonrpc: "2.0", id: 1 }],
    });
  });

  it("carries the request id in the final message", async () => {
    const convex = fakeConvex({ "decisions/poll": () => ANSWERED });
    const wait = await start(convex.svc, { decision_id: "decision_1" }, { id: 42 });

    expect(wait.events().messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 42,
        result: { content: [{ type: "text", text: JSON.stringify(ANSWERED) }], isError: false },
      },
    ]);
  });

  it("stops polling when the client disconnects between polls", async () => {
    const { convex, polls } = stored();
    const client = new AbortController();
    const wait = await start(convex.svc, { decision_id: "decision_1" }, { signal: client.signal });

    // Between the polls at 0 and 15 s.
    await vi.advanceTimersByTimeAsync(10_000);
    client.abort();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(polls()).toHaveLength(1);
    expect(wait.state.ended).toBe(true);
    expect(wait.events().messages).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a poll in flight when the client disconnects", async () => {
    const signals: AbortSignal[] = [];
    const convex = fakeConvex({
      "decisions/poll": (_body, signal) => {
        if (signal !== undefined) {
          signals.push(signal);
        }
        return signals.length === 1 ? decision() : new Promise(() => {});
      },
    });
    const client = new AbortController();
    const wait = await start(convex.svc, { decision_id: "decision_1" }, { signal: client.signal });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    client.abort();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(signals[1]?.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(wait.events().messages).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops polling when the stream is cancelled", async () => {
    const { convex, polls } = stored();
    const wait = await start(convex.svc, { decision_id: "decision_1" });

    await vi.advanceTimersByTimeAsync(10_000);
    await wait.reader.cancel();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(polls()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls nothing for a request whose client already disconnected", async () => {
    const { convex, polls } = stored();
    const client = new AbortController();
    client.abort();

    const wait = await start(convex.svc, { decision_id: "decision_1" }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(600_000);

    expect(polls()).toHaveLength(0);
    expect(wait.state.ended).toBe(true);
    expect(wait.state.text).toBe("");
  });

  it("returns every concurrent wait on one decision when it settles", async () => {
    const { store, convex, polls } = stored();
    const first = await start(convex.svc, { decision_id: "decision_1" });
    await vi.advanceTimersByTimeAsync(5_000);
    const second = await start(convex.svc, { decision_id: "decision_1" });

    // The decision settles at 16 s, after the polls at 0, 5, and 15 s.
    await vi.advanceTimersByTimeAsync(11_000);
    store.current = ANSWERED;
    await vi.advanceTimersByTimeAsync(15_000);

    // Each call polled on its own clock: the first at 0, 15, and 30 s, the
    // second at 5 and 20 s.
    expect(polls()).toHaveLength(5);
    expect(first.state.endedAt).toBe(30_000);
    expect(second.state.endedAt).toBe(15_000);
    for (const wait of [first, second]) {
      expect(wait.state.ended).toBe(true);
      expect(resultOf(wait.events().messages[0]).content[0]?.text).toBe(JSON.stringify(ANSWERED));
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls with the authenticated caller, never an asserted identity", async () => {
    const { store, convex, polls } = stored();
    store.current = ANSWERED;

    await start(convex.svc, {
      decision_id: "decision_1",
      userId: "user_b",
      agentSessionId: "agent_session_b",
    });

    expect(polls()[0]?.body).toEqual({
      userId: USER,
      agentSessionId: AGENT_SESSION,
      decisionId: "decision_1",
    });
  });

  it("passes not_found through as a tool error in the final message", async () => {
    const convex = fakeConvex({
      "decisions/poll": () => {
        throw new ServiceError("not_found", "Not found");
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_other" });

    expect(wait.state.ended).toBe(true);
    expect(resultOf(wait.events().messages[0])).toEqual({
      content: [{ type: "text", text: '{"error":{"code":"not_found","message":"Not found"}}' }],
      isError: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a validation error in the stream without polling", async () => {
    const { convex, polls } = stored();

    const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: 601 });

    expect(polls()).toHaveLength(0);
    expect(wait.state.ended).toBe(true);
    const result = resultOf(wait.events().messages[0]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      error: { code: "invalid", field: "timeout_seconds" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the stream with a JSON-RPC error when Convex fails mid-wait", async () => {
    let count = 0;
    const convex = fakeConvex({
      "decisions/poll": () => {
        count += 1;
        if (count === 2) {
          throw new UpstreamError("Service call decisions/poll timed out");
        }
        return decision();
      },
    });
    const wait = await start(convex.svc, { decision_id: "decision_1" });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(wait.state.ended).toBe(true);
    expect(wait.events().messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message: "AgentDesk is temporarily unavailable",
          data: { code: "unavailable" },
        },
      },
    ]);
    expect(wait.state.text).not.toContain("service-secret-value");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the stream with Internal error, without detail, for an unexpected failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const convex = fakeConvex({
      "decisions/poll": () => {
        throw new Error("secret detail at /svc/decisions/poll");
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_1" }, { id: 7 });

    expect(wait.events().messages).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Internal error" } },
    ]);
    expect(wait.state.text).not.toContain("secret detail");
    expect(wait.state.text).not.toContain("/svc/");
  });

  it.each([
    [
      "a malformed id",
      new ServiceError("invalid", "Invalid decisionId", "decisionId"),
      { code: "invalid", message: "decision_id is not a valid decision id", field: "decision_id" },
    ],
    [
      "an unknown or foreign id",
      new ServiceError("not_found", "Decision not found"),
      { code: "not_found", message: "Decision not found", field: "decision_id" },
    ],
    [
      "a malformed caller session",
      new ServiceError("invalid", "Invalid agentSessionId", "agentSessionId"),
      {
        code: "invalid",
        message: "This MCP session could not be resolved; initialize a new session",
      },
    ],
    [
      "a missing caller session",
      new ServiceError("not_found", "Agent session not found"),
      { code: "not_found", message: "Agent session not found" },
    ],
  ])("names the tool's own argument for %s", async (_, failure, expected) => {
    const convex = fakeConvex({
      "decisions/poll": () => {
        throw failure;
      },
    });

    const wait = await start(convex.svc, { decision_id: "abc" });

    const result = resultOf(wait.events().messages[0]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ error: expected });
    expect(wait.state.text).not.toContain("decisionId");
    expect(wait.state.text).not.toContain("agentSessionId");
  });
});

describe("transport for other methods", () => {
  it("keeps JSON responses for every other tool and method", async () => {
    const convex = fakeConvex({ "decisions/check": () => [ANSWERED] });

    for (const body of [
      rpc("ping"),
      rpc("tools/list"),
      rpc("tools/call", { name: "check", arguments: { decision_ids: ["decision_1"] } }),
    ]) {
      const response = await handle(mcpRequest(body), env, convex.svc);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    }
  });
});
