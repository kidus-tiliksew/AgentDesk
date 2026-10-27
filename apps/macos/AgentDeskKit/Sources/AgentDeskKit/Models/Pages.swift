import Foundation

/// One page of `GET /v1/decisions`. A null `next_cursor` ends the list.
public struct DecisionPage: Codable, Equatable, Sendable {
  public var items: [Decision]
  public var nextCursor: String?

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case items
    case nextCursor = "next_cursor"
  }
}

/// One page of `GET /v1/agent-sessions`. A null `next_cursor` ends the list.
public struct AgentSessionPage: Codable, Equatable, Sendable {
  public var items: [AgentSession]
  public var nextCursor: String?

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case items
    case nextCursor = "next_cursor"
  }
}

/// The body of `POST /v1/decisions/{id}/answer`.
public struct AnswerSubmission: Codable, Equatable, Sendable {
  public var answer: Answer
  public var note: String?

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case answer
    case note
  }

  public init(answer: Answer, note: String? = nil) {
    self.answer = answer
    self.note = note
  }
}
