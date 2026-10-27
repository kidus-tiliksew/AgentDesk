import Foundation

/// What one read-only decision row shows and VoiceOver reads
/// (component-mac-app §Rows; req-mac-app AC-4.2 to AC-4.4, AC-7.2).
public struct DecisionRowModel: Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  /// Drawn semibold while new, medium once seen (AC-4.4).
  public var isNew: Bool
  public var isUrgent: Bool
  public var agentName: String
  public var age: String
  public var timeLeft: String?
  /// The time left is the only red element of a row (AC-4.3).
  public var timeLeftIsRed: Bool
  /// "Suggests <answer>", for every input type except approve-or-reject.
  public var suggestion: String?

  public init(decision: Decision, agents: [AgentSession], seen: Set<String>, now: Date) {
    id = decision.id
    title = decision.title
    isNew = Attention.isNew(decision, seen: seen)
    isUrgent = Attention.isUrgent(decision)
    agentName = DecisionPresentation.agentName(for: decision, agents: agents)
    age = DecisionPresentation.age(since: decision.createdAt, now: now)
    timeLeft = decision.deadline.map { DecisionPresentation.timeLeft(until: $0, now: now) }
    timeLeftIsRed = Attention.isDueSoon(decision, now: now)
    suggestion = DecisionPresentation.suggestion(for: decision).map { "Suggests \($0)" }
  }

  /// The row's one accessibility element is labelled with the title.
  public var accessibilityLabel: String { title }

  /// The agent, the time left, "new" and "urgent", and the suggestion, so no
  /// state is carried by color or weight alone (AC-7.2).
  public var accessibilityValue: String {
    var parts = [agentName]
    if let timeLeft { parts.append(timeLeft) }
    if isNew { parts.append("new") }
    if isUrgent { parts.append("urgent") }
    if let suggestion { parts.append(suggestion.lowercasedFirst) }
    return parts.joined(separator: ", ")
  }
}

/// Row text, in the mobile app's formats (apps/mobile/src/decision-row.tsx,
/// decision-detail.tsx).
public enum DecisionPresentation {
  public static let endedAgent = "Ended agent"

  /// The asking session's display name from the snapshot's live sessions,
  /// or "Ended agent" when that session is not live.
  public static func agentName(for decision: Decision, agents: [AgentSession]) -> String {
    guard let id = decision.agentSessionID, let session = agents.first(where: { $0.id == id })
    else { return endedAgent }
    return session.displayName
  }

  /// The time since creation: "just now", "12m ago", "3h ago", "2d ago".
  public static func age(since created: Date, now: Date) -> String {
    let minutes = Int((now.timeIntervalSince(created) / 60).rounded(.down))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = minutes / 60
    return hours < 24 ? "\(hours)h ago" : "\(hours / 24)d ago"
  }

  /// The time left in minutes or coarser: "Under 1m left", "4m left",
  /// "2h left", "2h 5m left", "3d left", or "Deadline passed". The label
  /// only presents the Mac's clock; the server alone expires a decision.
  public static func timeLeft(until deadline: Date, now: Date) -> String {
    let left = deadline.timeIntervalSince(now)
    if left <= 0 { return "Deadline passed" }
    let minutes = Int((left / 60).rounded(.down))
    if minutes < 1 { return "Under 1m left" }
    if minutes < 60 { return "\(minutes)m left" }
    let hours = minutes / 60
    if hours < 24 { return minutes % 60 == 0 ? "\(hours)h left" : "\(hours)h \(minutes % 60)m left" }
    return "\(hours / 24)d left"
  }

  /// The recommendation as the user reads it, with option ids resolved to
  /// their labels, or nil for approve-or-reject and for no recommendation.
  public static func suggestion(for decision: Decision) -> String? {
    guard decision.inputType != .approveReject, let recommendation = decision.recommendation
    else { return nil }
    return answerText(recommendation, options: decision.options)
  }

  public static func answerText(_ answer: Answer, options: [Option]?) -> String {
    switch answer {
    case .approve: "Approve"
    case .reject: "Reject"
    case .option(let id): label(id, options)
    case .options(let ids): ids.map { label($0, options) }.joined(separator: ", ")
    case .text(let text): text
    }
  }

  private static func label(_ id: String, _ options: [Option]?) -> String {
    options?.first(where: { $0.id == id })?.label ?? id
  }
}

extension String {
  fileprivate var lowercasedFirst: String {
    guard let first else { return self }
    return first.lowercased() + dropFirst()
  }
}
