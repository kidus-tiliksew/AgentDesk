import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  type AgentSession,
  agentSessionSchema,
  type Decision,
  decisionInputFieldsSchema,
  decisionSchema,
  webhookEventSchema,
} from "../src/index.js";

// component-contract §Read shapes and webhook events.
const PENDING: Decision = {
  id: "d1",
  topic: "repo/feature",
  title: "Ship it?",
  body: null,
  input_type: "approve_reject",
  options: null,
  recommendation: null,
  priority: "normal",
  deadline: null,
  default: null,
  state: "pending",
  answer: null,
  note: null,
  answered_at: null,
  answered_via: null,
  applied_by_default: false,
  parent_id: null,
  follow_up_ids: [],
  agent_session_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const ANSWERED: Decision = {
  ...PENDING,
  body: "Two approaches.",
  input_type: "single_choice",
  options: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ],
  recommendation: { kind: "option", option_id: "a" },
  priority: "urgent",
  deadline: "2026-01-02T00:00:00.000Z",
  default: { kind: "option", option_id: "b" },
  state: "answered",
  answer: { kind: "option", option_id: "a" },
  note: "Go with alpha.",
  answered_at: "2026-01-01T00:05:00.000Z",
  answered_via: "app",
  parent_id: "d0",
  follow_up_ids: ["d2", "d3"],
  agent_session_id: "s1",
};

const SESSION: AgentSession = {
  id: "s1",
  display_name: "claude-code · repo/feature",
  topic: "repo/feature",
  state: "working",
  line: "Running the test suite",
  link: "https://github.com/acme/repo/pull/7",
  status_at: "2026-01-01T00:00:00.000Z",
  last_activity_at: "2026-01-01T00:01:00.000Z",
  stale: false,
  ended_at: null,
  pending_decision_count: 2,
};

const NEW_SESSION: AgentSession = {
  ...SESSION,
  state: null,
  line: null,
  link: null,
  status_at: null,
  pending_decision_count: 0,
};

describe("Decision", () => {
  test("has the snake_case fields the design lists", () => {
    expect(Object.keys(decisionSchema.shape)).toEqual([
      "id",
      "topic",
      "title",
      "body",
      "input_type",
      "options",
      "recommendation",
      "priority",
      "deadline",
      "default",
      "state",
      "answer",
      "note",
      "answered_at",
      "answered_via",
      "applied_by_default",
      "parent_id",
      "follow_up_ids",
      "agent_session_id",
      "created_at",
    ]);
  });

  test.each([PENDING, ANSWERED])("round-trips %#", (decision) => {
    expect(decisionSchema.parse(decision)).toEqual(decision);
  });

  test.each(["pending", "answered", "expired", "cancelled"])("accepts state %s", (state) => {
    expect(decisionSchema.safeParse({ ...PENDING, state }).success).toBe(true);
  });

  test.each(["app", "notification", "api", "default"])("accepts answered_via %s", (via) => {
    expect(decisionSchema.safeParse({ ...ANSWERED, answered_via: via }).success).toBe(true);
  });

  test("records a default applied at expiry", () => {
    const expired = {
      ...ANSWERED,
      state: "expired",
      answer: ANSWERED.default,
      note: null,
      answered_via: "default",
      applied_by_default: true,
    };
    expect(decisionSchema.parse(expired)).toEqual(expired);
  });

  test("keeps a past deadline and does not lowercase or default", () => {
    const old = { ...PENDING, deadline: "2000-01-01T00:00:00Z" };
    expect(decisionSchema.parse(old)).toEqual(old);
    expect(decisionSchema.safeParse({ ...PENDING, topic: "Repo" }).success).toBe(false);
    const { priority: _priority, ...withoutPriority } = PENDING;
    expect(decisionSchema.safeParse(withoutPriority).success).toBe(false);
  });

  test.each([
    ["state", "open"],
    ["answered_via", "email"],
    ["follow_up_ids", null],
    ["created_at", null],
  ])("rejects %s %j", (field, value) => {
    expect(decisionSchema.safeParse({ ...PENDING, [field]: value }).success).toBe(false);
  });
});

describe("AgentSession", () => {
  test("has the snake_case fields the design lists", () => {
    expect(Object.keys(agentSessionSchema.shape)).toEqual([
      "id",
      "display_name",
      "topic",
      "state",
      "line",
      "link",
      "status_at",
      "last_activity_at",
      "stale",
      "ended_at",
      "pending_decision_count",
    ]);
  });

  test.each([SESSION, NEW_SESSION, { ...SESSION, state: "done", ended_at: SESSION.status_at }])(
    "round-trips %#",
    (session) => {
      expect(agentSessionSchema.parse(session)).toEqual(session);
    },
  );

  test.each([
    ["pending_decision_count", -1],
    ["pending_decision_count", 1.5],
    ["state", "idle"],
    ["link", "/relative"],
    ["stale", null],
  ])("rejects %s %j", (field, value) => {
    expect(agentSessionSchema.safeParse({ ...SESSION, [field]: value }).success).toBe(false);
  });
});

describe("WebhookEvent", () => {
  const event = { id: "e1", occurred_at: "2026-01-01T00:00:00.000Z", action: "push" };

  test.each(["decision.created", "decision.expired", "decision.answered", "decision.cancelled"])(
    "%s carries a Decision",
    (kind) => {
      expect(webhookEventSchema.safeParse({ ...event, kind, data: ANSWERED }).success).toBe(true);
      expect(webhookEventSchema.safeParse({ ...event, kind, data: SESSION }).success).toBe(false);
    },
  );

  test.each(["agent.stale", "agent.status_changed", "agent.done"])(
    "%s carries an AgentSession",
    (kind) => {
      expect(webhookEventSchema.safeParse({ ...event, kind, data: SESSION }).success).toBe(true);
      expect(webhookEventSchema.safeParse({ ...event, kind, data: PENDING }).success).toBe(false);
    },
  );

  test.each(["push", "digest", "mute", null])("accepts action %j", (action) => {
    const parsed = { ...event, action, kind: "decision.created", data: PENDING };
    expect(webhookEventSchema.parse(parsed)).toEqual(parsed);
  });

  test.each([
    ["kind", "decision.updated"],
    ["action", "email"],
    ["action", undefined],
  ])("rejects %s %j", (field, value) => {
    const input = { ...event, kind: "decision.created", data: PENDING, [field]: value };
    expect(webhookEventSchema.safeParse(input).success).toBe(false);
  });
});

// Collects JSON Schema keywords, skipping the property names under
// `properties`.
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywords(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      if (key === "properties") {
        for (const property of Object.values(value as object)) keywords(property, found);
      } else {
        keywords(value, found);
      }
    }
  }
  return found;
}

// Task C publishes these shapes with z.toJSONSchema. The default
// `unrepresentable: "throw"` fails on any construct JSON Schema cannot hold.
describe("JSON Schema conversion", () => {
  test.each([
    ["Decision", decisionSchema],
    ["AgentSession", agentSessionSchema],
    ["WebhookEvent", webhookEventSchema],
  ])("%s converts without unrepresentable types", (_name, schema) => {
    const json = z.toJSONSchema(schema, { unrepresentable: "throw" });
    expect(json.type ?? json.anyOf).toBeDefined();
    expect(keywords(json).has("default")).toBe(false);
  });

  test("the keyword walk finds the default that decision input carries", () => {
    const json = z.toJSONSchema(decisionInputFieldsSchema, { io: "input" });
    expect(keywords(json).has("default")).toBe(true);
  });

  test("Decision lists every field as required", () => {
    const json = z.toJSONSchema(decisionSchema);
    expect(json.required).toEqual(Object.keys(decisionSchema.shape));
  });
});
