import type { Decision } from "@agentdesk/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../packages/installer/src/context.js";
import type { Harness } from "../../../packages/installer/src/harnesses.js";
import { runWait, WAIT_TIMEOUT_SECONDS } from "../../../packages/installer/src/resume/waiter.js";
import { POLL_INTERVAL_MS } from "../src/await.js";
import { ServiceError } from "../src/convex.js";
import { handle } from "../src/index.js";
import { decision, env, fakeConvex, TOKEN, USER } from "./fake.js";

// The installer's own waiter (component-resume §Waiter) against this
// gateway's `POST /device/wait` (component-gateway §Waiter endpoint), with
// Convex faked. Each package's tests fake the other side, so only this test
// catches a wire format one side changes alone.
//
// `runWait`, its request, the SSE parser, the settlement rule, and the resume
// message all run as the installer ships them. Only the machine reads are
// replaced: the MCP entry that holds the token, the installer state that names
// the server, the harness table, and the claim files. Those modules reach
// `node:fs`, which the Worker's runtime does not provide. The mocked state
// names SERVER; `vi.mock` factories are hoisted, so they repeat its value.

const SERVER = "https://agentdesk.example";
const ID = "decision_1";
const MESSAGE = `AgentDesk decision ${ID} settled. Read it with check, tell the user the answer and where it was given, then act on it.`;

const machine = vi.hoisted(() => ({
  claims: new Set<string>(),
  claimAttempts: [] as string[],
}));

vi.mock("../../../packages/installer/src/config.js", () => ({
  readMcpEntry: () => ({ present: true, url: "https://agentdesk.example/mcp", token: TOKEN }),
}));

vi.mock("../../../packages/installer/src/state.js", () => ({
  readState: () => ({}),
  recordedServer: () => "https://agentdesk.example",
}));

vi.mock("../../../packages/installer/src/harnesses.js", () => ({
  harnessById: (ctx: { harnesses: readonly { id: string }[] }, id: string) => {
    const harness = ctx.harnesses.find((h) => h.id === id);
    if (!harness) throw new Error(`unknown harness ${id}`);
    return harness;
  },
}));

// An in-memory claim store with the real one's exclusive-create rule.
vi.mock("../../../packages/installer/src/resume/storage.js", () => ({
  ResumeStore: class {
    cleanupClaims() {}
    claim(decisionId: string) {
      machine.claimAttempts.push(decisionId);
      if (machine.claims.has(decisionId)) return false;
      machine.claims.add(decisionId);
      return true;
    }
  },
}));

const ANSWERED_IN_APP = decision({
  state: "answered",
  answer: { kind: "approve" },
  note: "Go ahead",
  answered_at: "2026-10-11T00:01:00.000Z",
  answered_via: "app",
});

const RELAYED_FROM_CHAT = decision({
  state: "answered",
  answer: { kind: "approve" },
  answered_at: "2026-10-11T00:01:00.000Z",
  answered_via: "chat",
  interactive: true,
  chat_message: "Approve it",
  relayed_by_agent_session_id: "agent_session_a",
});

interface SentRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

// One waiter on the installer's side: a Context whose fetch hands each
// request to the gateway's `handle` and returns the Worker's response as it
// is, and recorded output. `watch` answers the nth `/svc/decisions/watch`.
function waiterAgainstGateway(watch: (count: number) => Decision) {
  let watches = 0;
  const convex = fakeConvex({ "decisions/watch": () => watch(++watches) });
  const sent: SentRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    env: {},
    home: "/home/test",
    hostname: "devbox",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.clone().text();
      sent.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("Authorization"),
        body: JSON.parse(text),
      });
      return await handle(request, env, convex.svc);
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    run: async () => {
      throw new Error("the waiter without a Codex thread runs no command");
    },
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    skill: { content: "", version: "0.0.0" },
    defaultServer: undefined,
    harnesses: [{ id: "claude-code", displayName: "Claude Code" } as Harness],
    secrets: new Set<string>(),
  } satisfies Context;
  return { ctx, convex, sent, out, err };
}

// Runs the waiter on the fake clock for at most `limitMs`. A protocol
// mismatch that makes the waiter retry forever fails here instead of hanging.
async function runBounded(ctx: Context, limitMs: number) {
  const result: { code?: number; error?: unknown } = {};
  const done = runWait(ctx, { harness: "claude-code", decisionId: ID }).then(
    (code) => {
      result.code = code;
    },
    (error: unknown) => {
      result.error = error;
    },
  );
  for (let elapsed = 0; elapsed < limitMs && !("code" in result || "error" in result); ) {
    await vi.advanceTimersByTimeAsync(1_000);
    elapsed += 1_000;
  }
  expect(result.error).toBeUndefined();
  expect(result.code).toBeDefined();
  await done;
  return result.code as number;
}

function expectWaiterRoutes(gateway: ReturnType<typeof waiterAgainstGateway>, watches: number) {
  // No MCP session and no agent session: only the credential and the watch.
  for (const request of gateway.sent) {
    expect(request).toEqual({
      method: "POST",
      url: `${SERVER}/device/wait`,
      authorization: `Bearer ${TOKEN}`,
      body: { decision_id: ID, timeout_seconds: WAIT_TIMEOUT_SECONDS },
    });
  }
  expect(gateway.convex.routes().filter((route) => route.startsWith("agents/"))).toEqual([]);
  const watchCalls = gateway.convex.calls.filter((call) => call.route === "decisions/watch");
  expect(watchCalls).toHaveLength(watches);
  for (const call of watchCalls) {
    expect(call.body).toEqual({ userId: USER, decisionId: ID });
  }
}

describe("the installer's waiter against the gateway", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    machine.claims.clear();
    machine.claimAttempts.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints the resume message once for a decision answered in the app mid-wait", async () => {
    // The first watch reads pending; the answer arrives before the next.
    const gateway = waiterAgainstGateway((count) => (count === 1 ? decision() : ANSWERED_IN_APP));

    const code = await runBounded(gateway.ctx, 60_000);

    expect(code).toBe(0);
    expect(gateway.out).toEqual([MESSAGE]);
    expect(gateway.err).toEqual([]);
    expect(machine.claimAttempts).toEqual([ID]);
    // One request, held open across the pending watch and the settled one.
    expect(gateway.sent).toHaveLength(1);
    expectWaiterRoutes(gateway, 2);
  });

  it("asks again after the gateway's limit and resumes on the later settlement", async () => {
    const limitWatches = (WAIT_TIMEOUT_SECONDS * 1000) / POLL_INTERVAL_MS;
    const gateway = waiterAgainstGateway((count) =>
      count <= limitWatches ? decision() : ANSWERED_IN_APP,
    );

    const code = await runBounded(gateway.ctx, WAIT_TIMEOUT_SECONDS * 1000 + 60_000);

    expect(code).toBe(0);
    expect(gateway.out).toEqual([MESSAGE]);
    // The first request ended with `{"state": "pending"}`; the second settled.
    expect(gateway.sent).toHaveLength(2);
    expectWaiterRoutes(gateway, limitWatches + 1);
  });

  it("exits 0 with no output and no claim for an answer relayed from chat", async () => {
    const gateway = waiterAgainstGateway((count) => (count === 1 ? decision() : RELAYED_FROM_CHAT));

    const code = await runBounded(gateway.ctx, 60_000);

    expect(code).toBe(0);
    expect(gateway.out).toEqual([]);
    expect(gateway.err).toEqual([]);
    expect(machine.claimAttempts).toEqual([]);
    expectWaiterRoutes(gateway, 2);
  });

  it("exits 0 with no output for a decision the gateway reports not_found", async () => {
    const gateway = waiterAgainstGateway(() => {
      throw new ServiceError("not_found", "Decision not found");
    });

    const code = await runBounded(gateway.ctx, 60_000);

    expect(code).toBe(0);
    expect(gateway.out).toEqual([]);
    expect(gateway.err).toEqual([]);
    expectWaiterRoutes(gateway, 1);
  });

  it("exits 1 as revoked when the gateway refuses the connection token", async () => {
    const gateway = waiterAgainstGateway(() => ANSWERED_IN_APP);
    const refused = fakeConvex({
      "identity/resolve-token": () => {
        throw new ServiceError("unauthenticated", "Credential revoked");
      },
    });
    gateway.ctx.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      await handle(new Request(input, init), env, refused.svc);

    const code = await runBounded(gateway.ctx, 60_000);

    expect(code).toBe(1);
    expect(gateway.out).toEqual([]);
    expect(gateway.err).toEqual([
      "The AgentDesk connection for Claude Code was revoked. Run agentdesk install to sign in again.",
    ]);
    expect(refused.routes()).toEqual(["identity/resolve-token"]);
  });
});
