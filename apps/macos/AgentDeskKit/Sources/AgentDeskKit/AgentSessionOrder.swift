import Foundation

/// The agents line and its list of live sessions (component-mac-app §Agents
/// line; req-mac-app REQ-5).
public struct AgentsSummary: Equatable, Sendable {
  public var running: Int
  public var blocked: Int

  public init(agents: [AgentSession]) {
    running = agents.count
    blocked = agents.filter { $0.state == .blocked }.count
  }

  /// "N agents running".
  public var runningText: String {
    running == 1 ? "1 agent running" : "\(running) agents running"
  }

  /// " · M blocked", drawn in red, when M is above zero (AC-5.1).
  public var blockedText: String? {
    blocked > 0 ? " · \(blocked) blocked" : nil
  }
}

public enum AgentSessionOrder {
  /// Blocked, then stale, then waiting, then working, each group in the
  /// order the API returned it.
  public static func sorted(_ agents: [AgentSession]) -> [AgentSession] {
    agents.enumerated()
      .sorted { a, b in
        let (x, y) = (rank(a.element), rank(b.element))
        return x != y ? x < y : a.offset < b.offset
      }
      .map(\.element)
  }

  static func rank(_ agent: AgentSession) -> Int {
    if agent.state == .blocked { return 0 }
    if agent.stale { return 1 }
    switch agent.state {
    case .waiting: return 2
    case .working: return 3
    case .blocked, .done, nil: return 4
    }
  }
}

/// One entry of the expanded agents list (AC-5.2, AC-5.3).
public struct AgentEntryModel: Equatable, Sendable, Identifiable {
  public var id: String
  public var displayName: String
  public var isBlocked: Bool
  /// The state, or "quiet <minutes>m" for a stale session.
  public var stateText: String
  public var line: String?
  /// The session's link when it is an absolute http or https URL.
  public var link: URL?

  public init(session: AgentSession, now: Date) {
    id = session.id
    displayName = session.displayName
    isBlocked = session.state == .blocked
    if session.stale {
      let minutes = max(0, Int((now.timeIntervalSince(session.lastActivityAt) / 60).rounded(.down)))
      stateText = "quiet \(minutes)m"
    } else {
      stateText = session.state?.rawValue ?? "no status"
    }
    line = session.line
    link = session.link.flatMap(Self.webURL)
  }

  public var accessibilityLabel: String {
    [displayName, stateText, line].compactMap { $0 }.joined(separator: ", ")
  }

  static func webURL(_ text: String) -> URL? {
    guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https", url.host?.isEmpty == false
    else { return nil }
    return url
  }
}
