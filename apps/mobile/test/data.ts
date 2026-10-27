import type { AgentSession, Decision } from "@agentdesk/contract";

// Read shapes as the app queries return them, with fields a test overrides.

export function decision(overrides: Partial<Decision> & Pick<Decision, "id">): Decision {
  return {
    topic: "acme",
    title: `Decision ${overrides.id}`,
    body: null,
    input_type: "approve_reject",
    options: null,
    recommendation: null,
    priority: "normal",
    interactive: false,
    notification_action: null,
    deadline: null,
    default: null,
    state: "pending",
    answer: null,
    note: null,
    answered_at: null,
    answered_via: null,
    chat_message: null,
    relayed_by_agent_session_id: null,
    applied_by_default: false,
    parent_id: null,
    follow_up_ids: [],
    agent_session_id: null,
    created_at: "2026-10-11T09:00:00.000Z",
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentSession> & Pick<AgentSession, "id">): AgentSession {
  return {
    display_name: `Agent ${overrides.id}`,
    topic: "acme",
    state: "working",
    line: "Running the test suite",
    link: null,
    status_at: new Date(Date.now() - 5_000).toISOString(),
    last_activity_at: new Date(Date.now() - 5_000).toISOString(),
    stale: false,
    ended_at: null,
    pending_decision_count: 0,
    ...overrides,
  };
}
