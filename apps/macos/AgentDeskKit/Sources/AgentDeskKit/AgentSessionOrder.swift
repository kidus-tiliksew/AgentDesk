import Foundation

/// The agents line and its list of live sessions (component-mac-app §Agents
/// line; req-mac-app REQ-5).
public struct AgentsSummary: Equatable, Sendable {
  public var active: Int
  public var quiet: Int
  public var blocked: Int

  /// Counts each session in its one group.
  public init(agents: [AgentSession]) {
    let groups = agents.map(AgentSessionOrder.group)
    active = groups.filter { $0 == .active }.count
    quiet = groups.filter { $0 == .quiet }.count
    blocked = groups.filter { $0 == .blocked }.count
  }

  /// Every live session, whichever group holds it.
  public var total: Int { active + quiet + blocked }

  /// "N active", shown at zero too (AC-5.1).
  public var activeText: String { "\(active) active" }

  /// " · M quiet", when M is above zero.
  public var quietText: String? {
    quiet > 0 ? " · \(quiet) quiet" : nil
  }

  /// " · K blocked", drawn in red, when K is above zero (AC-5.1).
  public var blockedText: String? {
    blocked > 0 ? " · \(blocked) blocked" : nil
  }

  /// The whole line, as the view draws its segments.
  public var text: String {
    activeText + (quietText ?? "") + (blockedText ?? "")
  }

  /// The line as VoiceOver reads it, without the separators.
  public var accessibilityLabel: String {
    [
      activeText,
      quiet > 0 ? "\(quiet) quiet" : nil,
      blocked > 0 ? "\(blocked) blocked" : nil,
    ].compactMap { $0 }.joined(separator: ", ")
  }

  /// "Show N quiet", the control that reveals the quiet sessions (AC-5.2).
  public var showQuietText: String { "Show \(quiet) quiet" }
  public static let hideQuietText = "Hide quiet"
}

/// The one group a live session counts in (req-mac-app AC-5.1).
public enum AgentGroup: Equatable, Sendable {
  case blocked
  case quiet
  case active
}

/// The color of an agents list entry's dot (req-mac-app AC-5.5). The app maps
/// each case to an `Ink` color.
public enum AgentDot: Equatable, Sendable {
  case green
  case amber
  case red
  case neutral
}

public enum AgentSessionOrder {
  /// Blocked when its state is blocked, even when stale; otherwise quiet
  /// when the server marks it stale; otherwise active.
  public static func group(_ agent: AgentSession) -> AgentGroup {
    if agent.state == .blocked { return .blocked }
    return agent.stale ? .quiet : .active
  }

  /// The name a decision row and the agents list draw (req-mac-app AC-5.4):
  /// when the display name ends with " · <topic>" for the session's non-empty
  /// topic, which is the form the backend gives a session with no name of its
  /// own, the text after the topic's last "/"; otherwise, or when that text is
  /// empty, the full display name.
  public static func shortName(_ agent: AgentSession) -> String {
    guard !agent.topic.isEmpty, agent.displayName.hasSuffix(" · \(agent.topic)") else {
      return agent.displayName
    }
    let lastSegment = agent.topic.split(separator: "/", omittingEmptySubsequences: false).last ?? ""
    return lastSegment.isEmpty ? agent.displayName : String(lastSegment)
  }

  /// Red when blocked, even when stale; otherwise green when working and
  /// amber when waiting, each only while not stale; otherwise neutral
  /// (req-mac-app AC-5.5).
  public static func dot(_ agent: AgentSession) -> AgentDot {
    if agent.state == .blocked { return .red }
    if agent.stale { return .neutral }
    switch agent.state {
    case .working: return .green
    case .waiting: return .amber
    default: return .neutral
    }
  }

  /// What the expanded list shows before any reveal: blocked, then active,
  /// each group in the order the API returned it (AC-5.2).
  public static func listed(_ agents: [AgentSession]) -> [AgentSession] {
    agents.filter { group($0) == .blocked } + agents.filter { group($0) == .active }
  }

  /// The quiet sessions, most recent activity first, with the API's order
  /// breaking a tie (AC-5.2).
  public static func quiet(_ agents: [AgentSession]) -> [AgentSession] {
    agents.filter { group($0) == .quiet }.enumerated()
      .sorted { a, b in
        let (x, y) = (a.element.lastActivityAt, b.element.lastActivityAt)
        return x != y ? x > y : a.offset < b.offset
      }
      .map(\.element)
  }

  /// The time since a quiet session's last activity, floored and never
  /// negative: "quiet 44m", "quiet 3h", or "quiet 2d".
  public static func quietText(since lastActivity: Date, now: Date) -> String {
    let minutes = max(0, Int((now.timeIntervalSince(lastActivity) / 60).rounded(.down)))
    if minutes < 60 { return "quiet \(minutes)m" }
    let hours = minutes / 60
    return hours < 24 ? "quiet \(hours)h" : "quiet \(hours / 24)d"
  }
}

/// One entry of the expanded agents list (AC-5.2, AC-5.3). An entry opens the
/// detail panel and holds no link, so it can open no browser. The entry draws
/// `shortName`, `dot`, and `stateText`; VoiceOver reads `accessibilityLabel`,
/// with the full display name and the status line the entry does not draw
/// (AC-5.4; component-mac-app §Keyboard and accessibility).
public struct AgentEntryModel: Equatable, Sendable, Identifiable {
  public var id: String
  public var displayName: String
  public var shortName: String
  public var dot: AgentDot
  /// The state, or the time since its last activity for a quiet session. A
  /// stale blocked session reads "blocked".
  public var stateText: String
  public var line: String?

  public init(session: AgentSession, now: Date) {
    id = session.id
    displayName = session.displayName
    shortName = AgentSessionOrder.shortName(session)
    dot = AgentSessionOrder.dot(session)
    if AgentSessionOrder.group(session) == .quiet {
      stateText = AgentSessionOrder.quietText(since: session.lastActivityAt, now: now)
    } else {
      stateText = session.state?.rawValue ?? "no status"
    }
    line = session.line
  }

  public var accessibilityLabel: String {
    [displayName, stateText, line].compactMap { $0 }.joined(separator: ", ")
  }

  /// The link when it is an absolute http or https URL. The panel's Open link
  /// control is the only thing that reads it (req-mac-app AC-11.4).
  static func webURL(_ text: String) -> URL? {
    guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https", url.host?.isEmpty == false
    else { return nil }
    return url
  }
}
