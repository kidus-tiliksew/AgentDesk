import {
  decisionInputFieldsSchema,
  resolveInputSchema,
  statusInputSchema,
  topicInputSchema,
} from "@agentdesk/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ServiceError, type ServiceRoute, UpstreamError } from "../src/convex.js";
import { handle } from "../src/index.js";
import {
  AGENT_SESSION,
  type Call,
  decision,
  env,
  fakeConvex,
  mcpRequest,
  readEvents,
  rpc,
  TRANSPORT_ROUTES,
  USER,
} from "./fake.js";

interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

async function call(
  name: string,
  args: unknown,
  convex = fakeConvex(),
): Promise<{ result: ToolResult; payload: unknown; calls: Call[] }> {
  const response = await handle(
    mcpRequest(rpc("tools/call", { name, arguments: args })),
    env,
    convex.svc,
  );
  expect(response.status).toBe(200);
  // `await` answers with one `message` event; every other tool with JSON.
  let body: unknown;
  if (name === "await") {
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const { messages } = await readEvents(response);
    expect(messages).toHaveLength(1);
    body = messages[0];
  } else {
    expect(response.headers.get("Content-Type")).toBe("application/json");
    body = await response.json();
  }
  const { result } = body as { result: ToolResult };
  const text = result.content[0]?.text ?? "";
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { result, payload, calls: convex.calls };
}

function input(schema: z.ZodType) {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest;
}

describe("tools/list", () => {
  it("lists exactly ask, await, check, cancel, resolve, and status", async () => {
    const response = await handle(mcpRequest(rpc("tools/list")), env, fakeConvex().svc);
    const { result } = (await response.json()) as {
      result: { tools: { name: string; description: string; inputSchema: unknown }[] };
    };

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "ask",
      "await",
      "check",
      "cancel",
      "resolve",
      "status",
    ]);
    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("publishes input schemas built from the contract", async () => {
    const response = await handle(mcpRequest(rpc("tools/list")), env, fakeConvex().svc);
    const { result } = (await response.json()) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    };
    const schemas = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.inputSchema]));

    expect(schemas.ask).toEqual(input(decisionInputFieldsSchema));
    expect(schemas.ask?.properties).toHaveProperty("interactive", {
      type: "boolean",
      default: false,
      description: "True when the user may be watching this session and can answer in its chat",
    });
    expect(schemas.resolve).toEqual(input(resolveInputSchema));
    expect(schemas.resolve?.required).toEqual(["decision_id", "answer", "chat_message"]);
    expect(schemas.status).toEqual(input(statusInputSchema.extend({ topic: topicInputSchema })));
    expect(schemas.status?.required).toEqual(["state", "line", "topic"]);
    expect(schemas.await).toEqual({
      type: "object",
      properties: {
        decision_id: { type: "string", minLength: 1 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600, default: 300 },
      },
      required: ["decision_id"],
    });
    expect(schemas.check).toEqual({
      type: "object",
      properties: {
        decision_ids: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ["decision_ids"],
    });
    expect(schemas.cancel).toEqual({
      type: "object",
      properties: { decision_id: { type: "string", minLength: 1 } },
      required: ["decision_id"],
    });
  });

  it("tells the agent to relay the user's own words with resolve", async () => {
    const response = await handle(mcpRequest(rpc("tools/list")), env, fakeConvex().svc);
    const { result } = (await response.json()) as {
      result: { tools: { name: string; description: string }[] };
    };

    expect(result.tools.find((tool) => tool.name === "resolve")?.description).toBe(
      "Record an answer the user gave in this chat to a pending decision. Pass the user's message word for word as chat_message. Never record an answer the user did not write.",
    );
  });
});

describe("argument validation", () => {
  const ask = { title: "Ship it?", input_type: "approve_reject", topic: "repo/main" };
  const status = { topic: "repo/main", state: "working", line: "Running tests" };
  const resolve = { decision_id: "d", answer: { kind: "approve" }, chat_message: "yes" };

  it.each([
    ["ask without a title", "ask", { input_type: "approve_reject", topic: "repo/main" }, "title"],
    ["ask with an invalid topic", "ask", { ...ask, topic: "repo main!" }, "topic"],
    ["ask without a topic", "ask", { title: "t", input_type: "free_text" }, "topic"],
    [
      "ask with a choice type and no options",
      "ask",
      { ...ask, input_type: "single_choice" },
      "options",
    ],
    [
      "ask with a deadline in the past",
      "ask",
      { ...ask, deadline: "2020-01-01T00:00:00Z" },
      "deadline",
    ],
    [
      "ask with a default and no deadline",
      "ask",
      { ...ask, default: { kind: "approve" } },
      "default",
    ],
    [
      "ask with a recommendation invalid for its type",
      "ask",
      { ...ask, recommendation: { kind: "text", text: "yes" } },
      "recommendation.kind",
    ],
    ["status with an unknown state", "status", { ...status, state: "sleeping" }, "state"],
    ["status with an invalid topic", "status", { ...status, topic: "a b" }, "topic"],
    ["status without a topic", "status", { state: "working", line: "x" }, "topic"],
    ["status with a relative link", "status", { ...status, link: "/runs/1" }, "link"],
    ["check with no ids", "check", { decision_ids: [] }, "decision_ids"],
    [
      "check with 51 ids",
      "check",
      { decision_ids: Array.from({ length: 51 }, (_, i) => `d${i}`) },
      "decision_ids",
    ],
    ["cancel without a decision_id", "cancel", {}, "decision_id"],
    ["ask with a string interactive", "ask", { ...ask, interactive: "true" }, "interactive"],
    [
      "resolve without a decision_id",
      "resolve",
      { answer: resolve.answer, chat_message: "yes" },
      "decision_id",
    ],
    [
      "resolve with an empty decision_id",
      "resolve",
      { ...resolve, decision_id: "" },
      "decision_id",
    ],
    ["resolve without an answer", "resolve", { decision_id: "d", chat_message: "yes" }, "answer"],
    [
      "resolve with an answer of unknown kind",
      "resolve",
      { ...resolve, answer: { kind: "maybe" } },
      "answer.kind",
    ],
    [
      "resolve with an option answer without option_id",
      "resolve",
      { ...resolve, answer: { kind: "option" } },
      "answer.option_id",
    ],
    [
      "resolve without a chat_message",
      "resolve",
      { decision_id: "d", answer: resolve.answer },
      "chat_message",
    ],
    [
      "resolve with an empty chat_message",
      "resolve",
      { ...resolve, chat_message: "" },
      "chat_message",
    ],
    [
      "resolve with a whitespace-only chat_message",
      "resolve",
      { ...resolve, chat_message: " \n\t " },
      "chat_message",
    ],
    [
      "resolve with a 4,001-character chat_message",
      "resolve",
      { ...resolve, chat_message: "a".repeat(4001) },
      "chat_message",
    ],
    [
      "resolve with a numeric chat_message",
      "resolve",
      { ...resolve, chat_message: 7 },
      "chat_message",
    ],
    [
      "await with timeout_seconds 0",
      "await",
      { decision_id: "d", timeout_seconds: 0 },
      "timeout_seconds",
    ],
    [
      "await with timeout_seconds 601",
      "await",
      { decision_id: "d", timeout_seconds: 601 },
      "timeout_seconds",
    ],
    [
      "await with a fractional timeout_seconds",
      "await",
      { decision_id: "d", timeout_seconds: 1.5 },
      "timeout_seconds",
    ],
  ])("rejects %s naming the field and calls no tool route", async (_name, tool, args, field) => {
    const { result, payload, calls } = await call(tool, args);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ error: { code: "invalid", field } });
    expect(calls.map((c) => c.route)).toEqual(TRANSPORT_ROUTES);
  });

  it("accepts the await limits 1 and 600 and defaults to 300", async () => {
    const answered = decision({ id: "d", state: "answered", answer: { kind: "approve" } });
    for (const args of [
      { decision_id: "d", timeout_seconds: 1 },
      { decision_id: "d", timeout_seconds: 600 },
      { decision_id: "d" },
    ]) {
      const convex = fakeConvex({ "decisions/poll": () => answered });
      const { result, payload } = await call("await", args, convex);
      expect(result.isError).toBe(false);
      expect(payload).toEqual(answered);
    }
  });
});

describe("ask", () => {
  it("creates the decision for the caller and returns its id and pending state", async () => {
    const convex = fakeConvex({ "decisions/create": () => decision({ id: "decision_9" }) });

    const { result, payload, calls } = await call(
      "ask",
      {
        title: "Ship it?",
        input_type: "approve_reject",
        topic: "Repo/Main",
        idempotency_key: "ship-1",
        // Identity and unknown arguments are dropped (req-agent-tools AC-7.2).
        userId: "user_b",
        agentSessionId: "agent_session_b",
        user_id: "user_b",
        extra: true,
      },
      convex,
    );

    expect(result.isError).toBe(false);
    expect(payload).toEqual({ decision_id: "decision_9", state: "pending" });
    expect(calls[2]).toEqual({
      route: "decisions/create",
      body: {
        title: "Ship it?",
        input_type: "approve_reject",
        topic: "repo/main",
        priority: "normal",
        interactive: false,
        idempotency_key: "ship-1",
        userId: USER,
        agentSessionId: AGENT_SESSION,
      },
    });
  });

  it("forwards choice options, recommendation, deadline, and default", async () => {
    const convex = fakeConvex({ "decisions/create": () => decision() });
    const args = {
      title: "Which region?",
      body: "Pick one.",
      input_type: "single_choice",
      options: [
        { id: "eu", label: "Europe" },
        { id: "us", label: "United States" },
      ],
      topic: "infra",
      priority: "urgent",
      recommendation: { kind: "option", option_id: "eu" },
      deadline: "2099-01-01T00:00:00Z",
      default: { kind: "option", option_id: "us" },
      parent_id: "decision_0",
    };

    const { calls } = await call("ask", args, convex);

    expect(calls[2]?.body).toEqual({
      ...args,
      interactive: false,
      userId: USER,
      agentSessionId: AGENT_SESSION,
    });
  });
});

describe("ask interactive", () => {
  const ask = { title: "Ship it?", input_type: "approve_reject", topic: "repo/main" };

  it.each([
    ["true", { interactive: true }, true],
    ["false", { interactive: false }, false],
    ["omitted, defaulting to false", {}, false],
  ])("forwards interactive %s", async (_name, extra, interactive) => {
    const convex = fakeConvex({ "decisions/create": () => decision({ interactive }) });

    const { result, calls } = await call("ask", { ...ask, ...extra }, convex);

    expect(result.isError).toBe(false);
    expect(calls[2]?.route).toBe("decisions/create");
    expect(calls[2]?.body).toHaveProperty("interactive", interactive);
  });
});

describe("resolve", () => {
  const answered = decision({
    state: "answered",
    interactive: true,
    answer: { kind: "approve" },
    answered_at: "2026-10-13T00:01:00.000Z",
    answered_via: "chat",
    chat_message: "  Yes, ship it.\r\n  Then tag the release 🚀 ",
    relayed_by_agent_session_id: AGENT_SESSION,
  });

  it("relays the answer and the message byte for byte with the caller's session", async () => {
    const convex = fakeConvex({ "decisions/resolve": () => answered });
    const message = "  Yes, ship it.\r\n  Then tag the release 🚀 ";

    const { result, payload, calls } = await call(
      "resolve",
      {
        decision_id: "decision_1",
        answer: { kind: "approve" },
        chat_message: message,
        // Identity, aliased, and unknown arguments are dropped
        // (req-agent-tools AC-7.2).
        userId: "user_b",
        agentSessionId: "agent_session_b",
        decisionId: "decision_other",
        chatMessage: "something the user never wrote",
        note: "a note",
      },
      convex,
    );

    expect(result.isError).toBe(false);
    expect(payload).toEqual(answered);
    expect(calls.map((c) => c.route)).toEqual([...TRANSPORT_ROUTES, "decisions/resolve"]);
    expect(calls[2]?.body).toEqual({
      userId: USER,
      agentSessionId: AGENT_SESSION,
      decisionId: "decision_1",
      answer: { kind: "approve" },
      chatMessage: message,
    });
  });

  it("accepts a 4,000-character message", async () => {
    const convex = fakeConvex({ "decisions/resolve": () => answered });
    const message = "a".repeat(4000);

    const { result, calls } = await call(
      "resolve",
      { decision_id: "decision_1", answer: { kind: "approve" }, chat_message: message },
      convex,
    );

    expect(result.isError).toBe(false);
    expect(calls[2]?.body.chatMessage).toBe(message);
  });

  it.each([
    ["invalid", new ServiceError("invalid", "Answer kind does not match approve_reject", "answer")],
    ["not_found", new ServiceError("not_found", "Not found")],
  ])("passes %s through without reading the decision", async (_name, failure) => {
    const convex = fakeConvex({
      "decisions/resolve": () => {
        throw failure;
      },
    });

    const { result, payload, calls } = await call(
      "resolve",
      { decision_id: "decision_1", answer: { kind: "text", text: "yes" }, chat_message: "yes" },
      convex,
    );

    expect(result.isError).toBe(true);
    expect(payload).toEqual({
      error:
        failure.field === undefined
          ? { code: failure.code, message: failure.message }
          : { code: failure.code, message: failure.message, field: failure.field },
    });
    expect(calls.map((c) => c.route)).toEqual([...TRANSPORT_ROUTES, "decisions/resolve"]);
  });

  it.each([
    [
      "answered",
      decision({
        state: "answered",
        answer: { kind: "approve" },
        answered_via: "app",
        answered_at: "2026-10-13T00:01:00.000Z",
      }),
    ],
    [
      "expired",
      decision({
        state: "expired",
        answer: { kind: "reject" },
        answered_via: "default",
        applied_by_default: true,
      }),
    ],
    ["cancelled", decision({ state: "cancelled" })],
  ])("reads a %s decision once on conflict and returns it", async (state, stored) => {
    const convex = fakeConvex({
      "decisions/resolve": () => {
        throw new ServiceError("conflict", "Decision is not pending");
      },
      "decisions/poll": () => stored,
    });

    const { result, payload, calls } = await call(
      "resolve",
      { decision_id: "decision_1", answer: { kind: "reject" }, chat_message: "no", userId: "x" },
      convex,
    );

    expect(result.isError).toBe(true);
    expect(payload).toEqual({
      error: { code: "conflict", message: `Decision is already ${state}` },
      decision: stored,
    });
    expect(calls.slice(2).map(({ route, body }) => ({ route, body }))).toEqual([
      {
        route: "decisions/resolve",
        body: {
          userId: USER,
          agentSessionId: AGENT_SESSION,
          decisionId: "decision_1",
          answer: { kind: "reject" },
          chatMessage: "no",
        },
      },
      {
        route: "decisions/poll",
        body: { userId: USER, agentSessionId: AGENT_SESSION, decisionId: "decision_1" },
      },
    ]);
  });

  it("passes not_found from the conflict read through instead", async () => {
    const convex = fakeConvex({
      "decisions/resolve": () => {
        throw new ServiceError("conflict", "Decision is not pending");
      },
      "decisions/poll": () => {
        throw new ServiceError("not_found", "Not found");
      },
    });

    const { result, payload, calls } = await call(
      "resolve",
      { decision_id: "decision_1", answer: { kind: "approve" }, chat_message: "yes" },
      convex,
    );

    expect(result.isError).toBe(true);
    expect(payload).toEqual({ error: { code: "not_found", message: "Not found" } });
    expect(calls.map((c) => c.route)).toEqual([
      ...TRANSPORT_ROUTES,
      "decisions/resolve",
      "decisions/poll",
    ]);
  });

  it("answers a Convex outage during the conflict read with a JSON-RPC error", async () => {
    const convex = fakeConvex({
      "decisions/resolve": () => {
        throw new ServiceError("conflict", "Decision is not pending");
      },
      "decisions/poll": () => {
        throw new UpstreamError("Service call decisions/poll failed");
      },
    });

    const response = await handle(
      mcpRequest(
        rpc("tools/call", {
          name: "resolve",
          arguments: {
            decision_id: "decision_1",
            answer: { kind: "approve" },
            chat_message: "yes",
          },
        }),
      ),
      env,
      convex.svc,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message: "AgentDesk is temporarily unavailable",
        data: { code: "unavailable" },
      },
    });
  });

  it("names decision_id when the conflict read refuses the id", async () => {
    const convex = fakeConvex({
      "decisions/resolve": () => {
        throw new ServiceError("conflict", "Decision is not pending");
      },
      "decisions/poll": () => {
        throw new ServiceError("invalid", "Invalid decisionId", "decisionId");
      },
    });

    const { result, payload, calls } = await call(
      "resolve",
      { decision_id: "abc", answer: { kind: "approve" }, chat_message: "yes" },
      convex,
    );

    expect(result.isError).toBe(true);
    expect(payload).toEqual({
      error: {
        code: "invalid",
        message: "decision_id is not a valid decision id",
        field: "decision_id",
      },
    });
    expect(calls.map((c) => c.route)).toEqual([
      ...TRANSPORT_ROUTES,
      "decisions/resolve",
      "decisions/poll",
    ]);
  });
});

describe("check", () => {
  it("reads the caller's decisions with their answers and notes", async () => {
    const answered = decision({
      id: "decision_2",
      state: "answered",
      answer: { kind: "approve" },
      note: "Go ahead",
      answered_at: "2026-10-11T00:01:00.000Z",
      answered_via: "app",
    });
    const convex = fakeConvex({ "decisions/check": () => [decision(), answered] });

    const { result, payload, calls } = await call(
      "check",
      { decision_ids: ["decision_1", "decision_2"], userId: "user_b" },
      convex,
    );

    expect(result.isError).toBe(false);
    expect(payload).toEqual({ decisions: [decision(), answered] });
    expect(calls[2]).toEqual({
      route: "decisions/check",
      body: {
        userId: USER,
        agentSessionId: AGENT_SESSION,
        decisionIds: ["decision_1", "decision_2"],
      },
    });
  });

  it("accepts 50 ids", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `d${i}`);
    const convex = fakeConvex({ "decisions/check": () => [] });

    const { result } = await call("check", { decision_ids: ids }, convex);

    expect(result.isError).toBe(false);
  });
});

describe("cancel", () => {
  it("cancels with the caller's session and returns the decision", async () => {
    const cancelled = decision({ state: "cancelled" });
    const convex = fakeConvex({ "decisions/cancel": () => cancelled });

    const { result, payload, calls } = await call("cancel", { decision_id: "decision_1" }, convex);

    expect(result.isError).toBe(false);
    expect(payload).toEqual(cancelled);
    expect(calls[2]).toEqual({
      route: "decisions/cancel",
      body: { userId: USER, agentSessionId: AGENT_SESSION, decisionId: "decision_1" },
    });
  });

  it("passes not_found for another user's decision through unchanged", async () => {
    const convex = fakeConvex({
      "decisions/cancel": () => {
        throw new ServiceError("not_found", "Not found");
      },
    });

    const { result, payload } = await call("cancel", { decision_id: "decision_other" }, convex);

    expect(result.isError).toBe(true);
    expect(payload).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("passes a conflict on a settled decision through", async () => {
    const convex = fakeConvex({
      "decisions/cancel": () => {
        throw new ServiceError("conflict", "Decision is already answered");
      },
    });

    const { payload } = await call("cancel", { decision_id: "decision_1" }, convex);

    expect(payload).toEqual({
      error: { code: "conflict", message: "Decision is already answered" },
    });
  });
});

describe("status", () => {
  it("sets the caller's status with a normalized topic", async () => {
    const session = {
      id: AGENT_SESSION,
      display_name: "Release bot",
      topic: "repo/main",
      state: "working",
      line: "Running tests",
      link: "https://ci.example/runs/1",
      status_at: "2026-10-11T00:00:00.000Z",
      last_activity_at: "2026-10-11T00:00:00.000Z",
      stale: false,
      ended_at: null,
      pending_decision_count: 0,
    };
    const convex = fakeConvex({ "agents/status": () => session });

    const { result, payload, calls } = await call(
      "status",
      {
        topic: "Repo/Main",
        state: "working",
        line: "Running tests",
        link: "https://ci.example/runs/1",
        display_name: "Release bot",
        agentSessionId: "agent_session_b",
      },
      convex,
    );

    expect(result.isError).toBe(false);
    expect(payload).toEqual(session);
    expect(calls[2]).toEqual({
      route: "agents/status",
      body: {
        topic: "repo/main",
        state: "working",
        line: "Running tests",
        link: "https://ci.example/runs/1",
        display_name: "Release bot",
        userId: USER,
        agentSessionId: AGENT_SESSION,
      },
    });
  });

  it("passes a service validation error through with its field", async () => {
    const convex = fakeConvex({
      "agents/status": () => {
        throw new ServiceError("invalid", "Invalid topic", "topic");
      },
    });

    const { result, payload } = await call(
      "status",
      { topic: "repo", state: "done", line: "Finished" },
      convex,
    );

    expect(result.isError).toBe(true);
    expect(payload).toEqual({
      error: { code: "invalid", message: "Invalid topic", field: "topic" },
    });
  });
});

describe("await", () => {
  it("polls for the caller's session and drops identity arguments", async () => {
    const answered = decision({ state: "answered", answer: { kind: "approve" }, note: "Go" });
    const convex = fakeConvex({ "decisions/poll": () => answered });

    const { result, payload, calls } = await call(
      "await",
      { decision_id: "decision_1", userId: "user_b", agentSessionId: "agent_session_b" },
      convex,
    );

    expect(result.isError).toBe(false);
    expect(payload).toEqual(answered);
    expect(calls.slice(2).map(({ route, body }) => ({ route, body }))).toEqual([
      {
        route: "decisions/poll",
        body: { userId: USER, agentSessionId: AGENT_SESSION, decisionId: "decision_1" },
      },
    ]);
  });

  it("passes not_found for another user's decision through unchanged", async () => {
    const convex = fakeConvex({
      "decisions/poll": () => {
        throw new ServiceError("not_found", "Not found");
      },
    });

    const { result, payload } = await call("await", { decision_id: "decision_other" }, convex);

    expect(result.isError).toBe(true);
    expect(payload).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});

// Convex names its own arguments, such as `decisionId`; each tool's error names
// the argument the agent sent instead (req-agent-tools AC-1.3).
describe("service error fields", () => {
  const RESOLVE_ARGS = { decision_id: "abc", answer: { kind: "approve" }, chat_message: "yes" };
  const STATUS_ARGS = { topic: "repo/main", state: "working", line: "Running tests" };
  const ASK_ARGS = { title: "Ship it?", input_type: "approve_reject", topic: "repo/main" };

  const DECISION_TOOLS = [
    ["await", "decisions/poll", { decision_id: "abc" }, "decision_id"],
    ["cancel", "decisions/cancel", { decision_id: "abc" }, "decision_id"],
    ["resolve", "decisions/resolve", RESOLVE_ARGS, "decision_id"],
  ] as const;

  const ALL_TOOLS = [
    ...DECISION_TOOLS,
    ["check", "decisions/check", { decision_ids: ["abc"] }, "decision_ids"],
    ["status", "agents/status", STATUS_ARGS, undefined],
    ["ask", "decisions/create", ASK_ARGS, undefined],
  ] as const;

  function refusing(route: ServiceRoute, failure: ServiceError) {
    return fakeConvex({
      [route]: () => {
        throw failure;
      },
    });
  }

  it.each(DECISION_TOOLS)("%s names decision_id for a malformed id", async (name, route, args) => {
    const convex = refusing(route, new ServiceError("invalid", "Invalid decisionId", "decisionId"));

    const { result, payload } = await call(name, args, convex);

    expect(result.isError).toBe(true);
    expect(payload).toEqual({
      error: {
        code: "invalid",
        message: "decision_id is not a valid decision id",
        field: "decision_id",
      },
    });
  });

  it.each(ALL_TOOLS.filter(([, , , argument]) => argument !== undefined))(
    "%s names %s for an unknown or foreign decision",
    async (name, route, args, argument) => {
      const convex = refusing(route, new ServiceError("not_found", "Decision not found"));

      const { result, payload } = await call(name, args, convex);

      expect(result.isError).toBe(true);
      expect(payload).toEqual({
        error: { code: "not_found", message: "Decision not found", field: argument },
      });
    },
  );

  it.each([0, 1, 7])("check names decision_ids for a malformed member %i", async (index) => {
    const ids = Array.from({ length: 8 }, (_, i) => `d${i}`);
    const convex = refusing(
      "decisions/check",
      new ServiceError("invalid", `Invalid decisionIds.${index}`, `decisionIds.${index}`),
    );

    const { payload } = await call("check", { decision_ids: ids }, convex);

    expect(payload).toEqual({
      error: {
        code: "invalid",
        message: `decision_ids[${index}] is not a valid decision id`,
        field: "decision_ids",
      },
    });
  });

  it("check names decision_ids for a refusal of the whole list", async () => {
    const convex = refusing(
      "decisions/check",
      new ServiceError("invalid", "At most 50 decision ids per call", "decisionIds"),
    );

    const { payload } = await call("check", { decision_ids: ["d0"] }, convex);

    expect(payload).toEqual({
      error: {
        code: "invalid",
        message: "At most 50 decision ids per call",
        field: "decision_ids",
      },
    });
  });

  it.each(ALL_TOOLS)("%s names no field for a refusal of the caller", async (name, route, args) => {
    for (const [failure, message] of [
      [
        new ServiceError("invalid", "Invalid userId", "userId"),
        "The connection's user could not be resolved",
      ],
      [
        new ServiceError("invalid", "Invalid agentSessionId", "agentSessionId"),
        "This MCP session could not be resolved; initialize a new session",
      ],
      [
        new ServiceError("invalid", "Too small: expected string to have >=1 characters", "userId"),
        "The connection's user could not be resolved",
      ],
    ] as const) {
      const { result, payload } = await call(name, args, refusing(route, failure));

      expect(result.isError).toBe(true);
      expect(payload).toEqual({ error: { code: "invalid", message } });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain("userId");
      expect(text).not.toContain("agentSessionId");
      expect(text).not.toContain(USER);
      expect(text).not.toContain(AGENT_SESSION);
    }
  });

  it.each(ALL_TOOLS)(
    "%s never names a decision for a missing agent session",
    async (name, route, args) => {
      const convex = refusing(route, new ServiceError("not_found", "Agent session not found"));

      const { payload } = await call(name, args, convex);

      expect(payload).toEqual({ error: { code: "not_found", message: "Agent session not found" } });
    },
  );

  it.each([
    ["topic", "Invalid topic"],
    ["state", "Invalid option"],
    ["line", "Too big: expected string to have <=200 characters"],
    ["link", "Invalid URL"],
    ["display_name", "Too big: expected string to have <=60 characters"],
  ])("status keeps its own %s field", async (field, message) => {
    const convex = refusing("agents/status", new ServiceError("invalid", message, field));

    const { payload } = await call("status", STATUS_ARGS, convex);

    expect(payload).toEqual({ error: { code: "invalid", message, field } });
  });

  it("ask keeps parent_id for an unknown parent", async () => {
    const convex = refusing(
      "decisions/create",
      new ServiceError("invalid", "parent_id names no decision", "parent_id"),
    );

    const { payload } = await call("ask", { ...ASK_ARGS, parent_id: "decision_x" }, convex);

    expect(payload).toEqual({
      error: { code: "invalid", message: "parent_id names no decision", field: "parent_id" },
    });
  });

  it("resolve keeps the answer path and renames chatMessage", async () => {
    const answer = refusing(
      "decisions/resolve",
      new ServiceError("invalid", "Unknown option", "answer.option_id"),
    );
    const message = refusing(
      "decisions/resolve",
      new ServiceError("invalid", "chatMessage must not be blank", "chatMessage"),
    );

    expect((await call("resolve", RESOLVE_ARGS, answer)).payload).toEqual({
      error: { code: "invalid", message: "Unknown option", field: "answer.option_id" },
    });
    expect((await call("resolve", RESOLVE_ARGS, message)).payload).toEqual({
      error: { code: "invalid", message: "chat_message must not be blank", field: "chat_message" },
    });
  });

  it.each(ALL_TOOLS)("%s hides a field the caller never sent", async (name, route, args) => {
    const convex = refusing(
      route,
      new ServiceError("invalid", "answeredVia failed at /svc/decisions/resolve", "answeredVia"),
    );

    const { result, payload } = await call(name, args, convex);

    expect(payload).toEqual({
      error: { code: "invalid", message: "AgentDesk refused the request" },
    });
    expect(result.content[0]?.text).not.toContain("answeredVia");
    expect(result.content[0]?.text).not.toContain("/svc/");
  });
});
