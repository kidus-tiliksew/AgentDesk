import Foundation

/// A decision as `spec/schemas/decision.schema.json` defines it. The coding
/// keys are the schema's property names, and `SchemaConformanceTests` holds
/// the two sets equal (DEC-19(2); component-mac-app §Models).
public struct Decision: Codable, Equatable, Hashable, Sendable, Identifiable {
  public enum InputType: String, Codable, CaseIterable, Sendable {
    case approveReject = "approve_reject"
    case singleChoice = "single_choice"
    case multipleChoice = "multiple_choice"
    case freeText = "free_text"
    case singleChoiceOrText = "single_choice_or_text"
  }

  public enum Priority: String, Codable, CaseIterable, Sendable {
    case normal, urgent
  }

  public enum State: String, Codable, CaseIterable, Sendable {
    case pending, answered, expired, cancelled
  }

  public enum AnsweredVia: String, Codable, CaseIterable, Sendable {
    case app, notification, api, chat
    case appliedDefault = "default"
  }

  /// The action routing chose for the decision's creation; nil until routing
  /// has run (req-public-api-and-webhooks AC-2.3).
  public enum NotificationAction: String, Codable, CaseIterable, Sendable {
    case push, digest, mute
  }

  public var id: String
  public var topic: String
  public var title: String
  public var body: String?
  public var inputType: InputType
  public var options: [Option]?
  public var recommendation: Answer?
  public var priority: Priority
  public var interactive: Bool
  public var notificationAction: NotificationAction?
  public var deadline: Date?
  public var defaultAnswer: Answer?
  public var state: State
  public var answer: Answer?
  public var note: String?
  public var answeredAt: Date?
  public var answeredVia: AnsweredVia?
  public var chatMessage: String?
  public var relayedByAgentSessionID: String?
  public var appliedByDefault: Bool
  public var parentID: String?
  public var followUpIDs: [String]
  public var agentSessionID: String?
  public var createdAt: Date

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case id
    case topic
    case title
    case body
    case inputType = "input_type"
    case options
    case recommendation
    case priority
    case interactive
    case notificationAction = "notification_action"
    case deadline
    case defaultAnswer = "default"
    case state
    case answer
    case note
    case answeredAt = "answered_at"
    case answeredVia = "answered_via"
    case chatMessage = "chat_message"
    case relayedByAgentSessionID = "relayed_by_agent_session_id"
    case appliedByDefault = "applied_by_default"
    case parentID = "parent_id"
    case followUpIDs = "follow_up_ids"
    case agentSessionID = "agent_session_id"
    case createdAt = "created_at"
  }
}
