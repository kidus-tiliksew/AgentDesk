import Foundation

@testable import AgentDeskKit

/// JSON fixtures shaped as the gateway answers. They hold no credential.
enum Fixtures {
  /// A decision with every field set, so re-encoding names every coding key.
  static func decision(_ overrides: [String: Any] = [:]) -> [String: Any] {
    var fields: [String: Any] = [
      "id": "dec_1",
      "topic": "deploy/web",
      "title": "Ship the release?",
      "body": "The **build** is green.",
      "input_type": "single_choice",
      "options": [["id": "a", "label": "Ship"], ["id": "b", "label": "Wait"]],
      "recommendation": ["kind": "option", "option_id": "a"],
      "priority": "urgent",
      "interactive": true,
      "notification_action": "push",
      "deadline": "2026-10-27T12:30:00.250Z",
      "default": ["kind": "option", "option_id": "b"],
      "state": "answered",
      "answer": ["kind": "option", "option_id": "a"],
      "note": "Go ahead",
      "answered_at": "2026-10-27T12:10:00+02:00",
      "answered_via": "chat",
      "chat_message": "ship it",
      "relayed_by_agent_session_id": "ags_2",
      "applied_by_default": false,
      "parent_id": "dec_0",
      "follow_up_ids": ["dec_2"],
      "agent_session_id": "ags_1",
      "created_at": "2026-10-27T12:00:00.123456Z",
    ]
    fields.merge(overrides) { $1 }
    return fields
  }

  /// A pending decision with every nullable field null.
  static func pendingDecision(id: String = "dec_1", _ overrides: [String: Any] = [:]) -> [String: Any] {
    var fields: [String: Any] = [
      "id": id,
      "topic": "deploy",
      "title": "Approve?",
      "body": NSNull(),
      "input_type": "approve_reject",
      "options": NSNull(),
      "recommendation": NSNull(),
      "priority": "normal",
      "interactive": false,
      "notification_action": NSNull(),
      "deadline": NSNull(),
      "default": NSNull(),
      "state": "pending",
      "answer": NSNull(),
      "note": NSNull(),
      "answered_at": NSNull(),
      "answered_via": NSNull(),
      "chat_message": NSNull(),
      "relayed_by_agent_session_id": NSNull(),
      "applied_by_default": false,
      "parent_id": NSNull(),
      "follow_up_ids": [String](),
      "agent_session_id": NSNull(),
      "created_at": "2026-10-27T12:00:00Z",
    ]
    fields.merge(overrides) { $1 }
    return fields
  }

  static func agentSession(id: String = "ags_1", ended: Bool = false, _ overrides: [String: Any] = [:])
    -> [String: Any]
  {
    var fields: [String: Any] = [
      "id": id,
      "display_name": "Claude Code · web",
      "topic": "web",
      "state": "working",
      "line": "Running tests",
      "link": "https://example.com/session",
      "status_at": "2026-10-27T12:00:00Z",
      "last_activity_at": "2026-10-27T12:01:00.5Z",
      "stale": false,
      "ended_at": ended ? "2026-10-27T12:05:00Z" : NSNull(),
      "pending_decision_count": 1,
    ]
    fields.merge(overrides) { $1 }
    return fields
  }

  static func page(_ items: [[String: Any]], next: String?) -> String {
    json(["items": items, "next_cursor": next.map { $0 as Any } ?? NSNull()])
  }

  static func json(_ object: Any) -> String {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(data: data, encoding: .utf8)!
  }

  static func data(_ object: Any) -> Data {
    Data(json(object).utf8)
  }
}

extension Fixtures {
  /// A decoded pending decision.
  static func pending(
    _ id: String, priority: String = "normal", deadline: String? = nil,
    created: String = "2026-10-27T12:00:00Z", _ overrides: [String: Any] = [:]
  ) -> Decision {
    var fields: [String: Any] = [
      "priority": priority, "deadline": deadline.map { $0 as Any } ?? NSNull(), "created_at": created,
    ]
    fields.merge(overrides) { $1 }
    return try! JSONDecoder.agentDesk().decode(
      Decision.self, from: data(pendingDecision(id: id, fields)))
  }

  /// A decoded live agent session.
  static func session(_ id: String, _ overrides: [String: Any] = [:]) -> AgentSession {
    try! JSONDecoder.agentDesk().decode(AgentSession.self, from: data(agentSession(id: id, overrides)))
  }

  static func instant(_ text: String) -> Date {
    Instant.parse(text)!
  }
}
