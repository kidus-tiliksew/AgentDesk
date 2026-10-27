import Foundation

/// An agent session as `spec/schemas/agent-session.schema.json` defines it
/// (DEC-19(2); component-mac-app §Models).
public struct AgentSession: Codable, Equatable, Hashable, Sendable, Identifiable {
  public enum State: String, Codable, CaseIterable, Sendable {
    case working, waiting, blocked, done
  }

  public var id: String
  public var displayName: String
  public var topic: String
  public var state: State?
  public var line: String?
  /// An absolute http or https URL, kept as the server sent it.
  public var link: String?
  public var statusAt: Date?
  public var lastActivityAt: Date
  public var stale: Bool
  public var endedAt: Date?
  public var pendingDecisionCount: Int

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case id
    case displayName = "display_name"
    case topic
    case state
    case line
    case link
    case statusAt = "status_at"
    case lastActivityAt = "last_activity_at"
    case stale
    case endedAt = "ended_at"
    case pendingDecisionCount = "pending_decision_count"
  }
}
