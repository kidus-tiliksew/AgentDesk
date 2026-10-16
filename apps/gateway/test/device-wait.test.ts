import type { Decision } from "@agentdesk/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "../src/await.js";
import { ServiceError, UpstreamError } from "../src/convex.js";
import { handle } from "../src/index.js";
import { KEEPALIVE_MS } from "../src/sse.js";
import { decision, env, fakeConvex, parseEvents, routeRequest, TOKEN, USER } from "./fake.js";

// component-gateway §Verification: `POST /device/wait` with the Convex client
// faked and timers faked. Each test that reaches the stream reads it as it
// arrives, and every test checks that no `/svc/agents/*` route was called
// (req-installation-and-agent-guidance AC-12.7).

const ANSWERED = decision({
  state: "answered",
  answer: { kind: "approve" },
  note: "Go ahead",
  answered_at: "2026-10-11T00:01:00.000Z",
  answered_via: "app",
});

function waitRequest(body: unknown, headers: Record<string, string | null> = {}): Request {
  return routeRequest("POST", "/device/wait", body, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "text/event-stream",
    ...headers,
  });
}

// A decision whose state a test changes mid-wait. Each watch reads it when it
// starts and delivers that snapshot `latencyMs` later.
function stored(latencyMs = 0) {
  const store: { current: Decision } = { current: decision() };
  const convex = fakeConvex({
    "decisions/watch": async () => {
      const snapshot = store.current;
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      return snapshot;
    },
  });
  return { store, convex, watches: () => watches(convex) };
}

function watches(convex: ReturnType<typeof fakeConvex>) {
  return convex.calls.filter((call) => call.route === "decisions/watch");
}

// Every route this endpoint may call. Anything else, such as `agents/open` or
// `agents/session`, fails the test.
function expectNoAgentCalls(convex: ReturnType<typeof fakeConvex>) {
  for (const route of convex.routes()) {
    expect(route.startsWith("agents/")).toBe(false);
    expect(["identity/resolve-token", "decisions/watch"]).toContain(route);
  }
}

// Sends a wait and reads its stream in the background. `elapsed` is the
// fake-clock time since the request started.
async function start(
  svc: ReturnType<typeof fakeConvex>["svc"],
  body: unknown,
  init: { signal?: AbortSignal } = {},
) {
  const request = waitRequest(body);
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
  // Let the first watch run.
  await vi.advanceTimersByTimeAsync(0);
  return { response, reader, state, events: () => parseEvents(state.text) };
}

describe("POST /device/wait refusals", () => {
  it.each([
    ["a missing credential", null],
    ["a malformed credential", "Bearer not-a-token"],
    ["a non-bearer scheme", `Basic ${TOKEN}`],
    ["an API token", `Bearer adp_${"a".repeat(43)}`],
    ["an unknown connection token", `Bearer adc_${"b".repeat(43)}`],
  ])("answers 401 before any stream for %s", async (_, authorization) => {
    const convex = fakeConvex({ "decisions/watch": () => ANSWERED });

    const response = await handle(
      waitRequest({ decision_id: "decision_1" }, { Authorization: authorization }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Missing or invalid credential" },
    });
    expect(watches(convex)).toHaveLength(0);
    expectNoAgentCalls(convex);
  });

  it("does not send an API token or a malformed credential to identity", async () => {
    const convex = fakeConvex();
    for (const authorization of [null, "Bearer not-a-token", `Bearer adp_${"a".repeat(43)}`]) {
      await handle(
        waitRequest({ decision_id: "decision_1" }, { Authorization: authorization }),
        env,
        convex.svc,
      );
    }
    expect(convex.calls).toEqual([]);
  });

  it("answers 401 for a revoked connection token", async () => {
    const convex = fakeConvex({
      "identity/resolve-token": () => {
        throw new ServiceError("unauthenticated", "Credential revoked");
      },
      "decisions/watch": () => ANSWERED,
    });

    const response = await handle(waitRequest({ decision_id: "decision_1" }), env, convex.svc);

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unauthenticated",
    );
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("answers 401 when the token resolves to another credential kind", async () => {
    const convex = fakeConvex({
      "identity/resolve-token": () => ({ userId: USER, credentialId: "cred_a", kind: "api_token" }),
      "decisions/watch": () => ANSWERED,
    });

    const response = await handle(waitRequest({ decision_id: "decision_1" }), env, convex.svc);

    expect(response.status).toBe(401);
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("answers 503, not 401, when identity is unavailable", async () => {
    const convex = fakeConvex({
      "identity/resolve-token": () => {
        throw new UpstreamError("Service call identity/resolve-token timed out");
      },
      "decisions/watch": () => ANSWERED,
    });

    const response = await handle(waitRequest({ decision_id: "decision_1" }), env, convex.svc);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
    });
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("authenticates before reading the body", async () => {
    const convex = fakeConvex();

    const response = await handle(
      waitRequest("not json", { Authorization: null }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
    expect(convex.calls).toEqual([]);
  });

  it.each([
    ["text that is not JSON", "{"],
    ["an array", [{ decision_id: "decision_1" }]],
    ["null", null],
    ["a string", JSON.stringify("decision_1")],
    ["no body", undefined],
  ])("answers 400 for a body that is %s", async (_, body) => {
    const convex = fakeConvex({ "decisions/watch": () => ANSWERED });

    const response = await handle(waitRequest(body), env, convex.svc);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid", message: "Body must be a JSON object" },
    });
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it.each([
    ["missing", {}],
    ["empty", { decision_id: "" }],
    ["a number", { decision_id: 1 }],
    ["null", { decision_id: null }],
    ["a list", { decision_id: ["decision_1"] }],
  ])("answers 400 naming decision_id when it is %s", async (_, body) => {
    const convex = fakeConvex({ "decisions/watch": () => ANSWERED });

    const response = await handle(waitRequest(body), env, convex.svc);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid",
        message: "decision_id must be a non-empty string",
        field: "decision_id",
      },
    });
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it.each([
    ["null", null],
    ["a string", "30"],
    ["a fraction", 1.5],
    ["zero", 0],
    ["negative", -1],
    ["above 600", 601],
    ["a boolean", true],
  ])("answers 400 naming timeout_seconds when it is %s", async (_, timeout) => {
    const convex = fakeConvex({ "decisions/watch": () => ANSWERED });

    const response = await handle(
      waitRequest({ decision_id: "decision_1", timeout_seconds: timeout }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid",
        message: "timeout_seconds must be an integer from 1 to 600",
        field: "timeout_seconds",
      },
    });
    expect(convex.routes()).toEqual(["identity/resolve-token"]);
  });

  it("answers 404 for a method other than POST", async () => {
    const convex = fakeConvex();

    const response = await handle(
      routeRequest("GET", "/device/wait", undefined, { Authorization: `Bearer ${TOKEN}` }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(404);
    expect(convex.calls).toEqual([]);
  });
});

describe("POST /device/wait stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers an event stream and watches with only the caller and decision", async () => {
    const convex = fakeConvex({ "decisions/watch": () => ANSWERED });

    const wait = await start(convex.svc, {
      decision_id: "decision_1",
      timeout_seconds: 5,
      // Identity fields in the body never reach Convex.
      userId: "user_b",
      user_id: "user_b",
      agentSessionId: "agent_session_b",
    });

    expect(wait.response.status).toBe(200);
    expect(wait.response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(wait.response.headers.get("Cache-Control")).toBe("no-cache");
    expect(watches(convex).map((call) => call.body)).toEqual([
      { userId: USER, decisionId: "decision_1" },
    ]);
    expectNoAgentCalls(convex);
  });

  it.each([
    ["answered", ANSWERED],
    [
      "expired",
      decision({ state: "expired", answer: { kind: "reject" }, applied_by_default: true }),
    ],
    ["cancelled", decision({ state: "cancelled" })],
  ])("sends an already %s decision from the first watch and ends", async (_, settled) => {
    const convex = fakeConvex({ "decisions/watch": () => settled });

    const wait = await start(convex.svc, { decision_id: "decision_1" });

    expect(wait.state.ended).toBe(true);
    expect(wait.state.endedAt).toBe(0);
    expect(watches(convex)).toHaveLength(1);
    expect(wait.state.text).toBe(
      `event: message\ndata: ${JSON.stringify({ decision: settled })}\n\n`,
    );
    expect(wait.events()).toEqual({ comments: [], messages: [{ decision: settled }] });
    expect(vi.getTimerCount()).toBe(0);
    expectNoAgentCalls(convex);
  });

  it("sends a decision settled mid-wait from the next watch", async () => {
    const latency = 2_000;
    const { store, convex, watches: calls } = stored(latency);
    const wait = await start(convex.svc, { decision_id: "decision_1" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(wait.state.ended).toBe(false);
    store.current = ANSWERED;
    // The watch at 30 s reads the settlement and answers 2 s later.
    await vi.advanceTimersByTimeAsync(30_000 + latency - 20_000 - 1);
    expect(wait.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(wait.state.ended).toBe(true);
    expect(wait.state.endedAt).toBe(30_000 + latency);
    expect(calls()).toHaveLength(3);
    expect(wait.events().messages).toEqual([{ decision: ANSWERED }]);
    expect(vi.getTimerCount()).toBe(0);
    expectNoAgentCalls(convex);
  });

  it("starts watches 15 seconds apart on the request's clock, whatever the latency", async () => {
    const { convex } = stored(3_000);
    const startedAt: number[] = [];
    const t0 = Date.now();
    const svc: typeof convex.svc = (route, body, signal) => {
      if (route === "decisions/watch") {
        startedAt.push(Date.now() - t0);
      }
      return convex.svc(route, body, signal);
    };

    await start(svc, { decision_id: "decision_1", timeout_seconds: 100 });
    await vi.advanceTimersByTimeAsync(100_000);

    expect(POLL_INTERVAL_MS).toBe(15_000);
    expect(startedAt).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);
    expectNoAgentCalls(convex);
  });

  it.each([
    [1, 1],
    [16, 2],
    [600, 40],
  ])(
    "with timeout_seconds %i watches %i times and sends pending at the limit",
    async (seconds, expected) => {
      const { convex, watches: calls } = stored();
      const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: seconds });

      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(wait.state.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(wait.state.ended).toBe(true);
      expect(wait.state.endedAt).toBe(seconds * 1000);
      expect(calls()).toHaveLength(expected);
      expect(wait.events().messages).toEqual([{ state: "pending", decision_id: "decision_1" }]);
      expect(vi.getTimerCount()).toBe(0);
      expectNoAgentCalls(convex);
    },
  );

  it("waits 300 seconds when timeout_seconds is omitted", async () => {
    const { convex, watches: calls } = stored();
    const wait = await start(convex.svc, { decision_id: "decision_1" });

    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(wait.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(wait.state.ended).toBe(true);
    expect(calls()).toHaveLength(20);
    expect(wait.events().messages).toEqual([{ state: "pending", decision_id: "decision_1" }]);
  });

  it("sends pending at the limit when a watch hangs past it, and cancels that watch", async () => {
    const signals: AbortSignal[] = [];
    const convex = fakeConvex({
      "decisions/watch": (_body, signal) => {
        if (signal !== undefined) {
          signals.push(signal);
        }
        // The second watch never answers and ignores its signal.
        return signals.length === 1 ? decision() : new Promise(() => {});
      },
    });
    const wait = await start(convex.svc, { decision_id: "decision_1", timeout_seconds: 30 });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(wait.state.ended).toBe(true);
    expect(wait.state.endedAt).toBe(30_000);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(wait.events().messages).toEqual([{ state: "pending", decision_id: "decision_1" }]);
    expect(vi.getTimerCount()).toBe(0);
    expectNoAgentCalls(convex);
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
    expect(wait.state.text).toBe(
      `: keepalive\n\n: keepalive\n\n: keepalive\n\nevent: message\ndata: ${JSON.stringify({
        state: "pending",
        decision_id: "decision_1",
      })}\n\n`,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the contract error body for not_found and ends", async () => {
    const convex = fakeConvex({
      "decisions/watch": () => {
        throw new ServiceError("not_found", "Decision not found");
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_9" });

    expect(wait.response.status).toBe(200);
    expect(wait.state.ended).toBe(true);
    expect(wait.events()).toEqual({
      comments: [],
      messages: [
        { error: { code: "not_found", message: "Decision not found", field: "decision_id" } },
      ],
    });
    expect(vi.getTimerCount()).toBe(0);
    expectNoAgentCalls(convex);
  });

  it("passes another service error through with its field named as the body field", async () => {
    const convex = fakeConvex({
      "decisions/watch": () => {
        throw new ServiceError("invalid", "decisionId is not an id", "decisionId");
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_1" });

    expect(wait.events().messages).toEqual([
      { error: { code: "invalid", message: "decision_id is not an id", field: "decision_id" } },
    ]);
  });

  it("restates Convex's malformed id refusal with decision_id", async () => {
    const convex = fakeConvex({
      "decisions/watch": () => {
        throw new ServiceError("invalid", "Invalid decisionId", "decisionId");
      },
    });

    const wait = await start(convex.svc, { decision_id: "abc" });

    expect(wait.events().messages).toEqual([
      {
        error: {
          code: "invalid",
          message: "decision_id is not a valid decision id",
          field: "decision_id",
        },
      },
    ]);
    expect(wait.state.text).not.toContain("decisionId");
  });

  it("names no field for a refusal of the caller's user", async () => {
    const convex = fakeConvex({
      "decisions/watch": () => {
        throw new ServiceError("invalid", "Invalid userId", "userId");
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_1" });

    expect(wait.events().messages).toEqual([
      { error: { code: "invalid", message: "The connection's user could not be resolved" } },
    ]);
    expect(wait.state.text).not.toContain("userId");
    expect(wait.state.text).not.toContain(USER);
  });

  it.each([
    ["the first watch", 1],
    ["a later watch", 3],
  ])("sends unavailable when %s fails after the stream opened", async (_, failingWatch) => {
    let count = 0;
    const convex = fakeConvex({
      "decisions/watch": () => {
        count++;
        if (count === failingWatch) {
          throw new UpstreamError("Service call decisions/watch timed out");
        }
        return decision();
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_1" });
    await vi.advanceTimersByTimeAsync((failingWatch - 1) * POLL_INTERVAL_MS);

    expect(wait.response.status).toBe(200);
    expect(wait.state.ended).toBe(true);
    expect(wait.state.endedAt).toBe((failingWatch - 1) * POLL_INTERVAL_MS);
    expect(wait.events().messages).toEqual([
      { error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" } },
    ]);
    // The event names no route, credential, or secret.
    expect(wait.state.text).not.toContain("decisions/watch");
    expect(wait.state.text).not.toContain(env.SERVICE_SECRET);
    expect(vi.getTimerCount()).toBe(0);
    expectNoAgentCalls(convex);
  });

  it("sends unavailable, without detail, for an unexpected failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const convex = fakeConvex({
      "decisions/watch": () => {
        throw new Error("secret detail");
      },
    });

    const wait = await start(convex.svc, { decision_id: "decision_1" });

    expect(wait.events().messages).toEqual([
      { error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" } },
    ]);
    expect(wait.state.text).not.toContain("secret detail");
  });

  it.each([
    ["the request aborts", "request"],
    ["the client cancels the stream", "cancel"],
  ])("stops watching and writes nothing more when %s", async (_, how) => {
    const signals: AbortSignal[] = [];
    let settle: (() => void) | undefined;
    const convex = fakeConvex({
      "decisions/watch": (_body, signal) => {
        if (signal !== undefined) {
          signals.push(signal);
        }
        if (signals.length === 1) {
          return decision();
        }
        // The second watch ignores its signal and answers only when told.
        return new Promise((resolve) => {
          settle = () => resolve(ANSWERED);
        });
      },
    });
    const client = new AbortController();
    const wait = await start(convex.svc, { decision_id: "decision_1" }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1_000);
    expect(signals).toHaveLength(2);
    const text = wait.state.text;

    if (how === "request") {
      client.abort();
    } else {
      await wait.reader.cancel();
    }
    await vi.advanceTimersByTimeAsync(0);
    settle?.();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(signals[1]?.aborted).toBe(true);
    expect(wait.state.text).toBe(text);
    expect(wait.events().messages).toEqual([]);
    expect(watches(convex)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expectNoAgentCalls(convex);
  });
});
