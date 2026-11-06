import Foundation

/// A previous status of an agent session, as `agentSessionHistorySchema` in
/// `spec/openapi.json` defines it (DEC-23(4); req-public-api-and-webhooks
/// AC-2.4). The current status is on the `AgentSession`, not here.
public struct StatusHistoryEntry: Codable, Equatable, Hashable, Sendable {
  public var state: AgentSession.State
  public var line: String
  /// An absolute http or https URL, kept as the server sent it. Nothing opens
  /// it (req-mac-app AC-11.4).
  public var link: String?
  public var at: Date

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case state
    case line
    case link
    case at
  }

  public init(state: AgentSession.State, line: String, link: String? = nil, at: Date) {
    self.state = state
    self.line = line
    self.link = link
    self.at = at
  }
}

/// The body of `GET /v1/agent-sessions/{id}/history`: at most 20 previous
/// statuses, newest first, with no cursor.
public struct AgentSessionHistory: Codable, Equatable, Sendable {
  public var items: [StatusHistoryEntry]

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case items
  }
}
