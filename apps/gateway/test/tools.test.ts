import {
  decisionInputFieldsSchema,
  statusInputSchema,
  topicInputSchema,
} from "@agentdesk/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ServiceError } from "../src/convex.js";
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
  it("lists exactly ask, await, check, cancel, and status", async () => {
    const response = await handle(mcpRequest(rpc("tools/list")), env, fakeConvex().svc);
    const { result } = (await response.json()) as {
      result: { tools: { name: string; description: string; inputSchema: unknown }[] };
    };

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "ask",
      "await",
      "check",
      "cancel",
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
});

describe("argument validation", () => {
  const ask = { title: "Ship it?", input_type: "approve_reject", topic: "repo/main" };
  const status = { topic: "repo/main", state: "working", line: "Running tests" };

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
