import Foundation

/// Whether the menu bar item shows its dot (component-mac-app §Ordering and
/// attention; req-mac-app AC-3.1).
public enum Attention {
  /// A deadline closer than this counts as needing attention.
  public static let deadlineWindow: TimeInterval = 300
  /// The app recomputes the dot this often without a read, so a deadline
  /// crossing the 5-minute mark shows the dot.
  public static let recomputeInterval: TimeInterval = 30

  /// True when some pending decision is new, urgent, or due in less than
  /// 300 seconds.
  public static func dot(_ decisions: [Decision], seen: Set<String>, now: Date) -> Bool {
    decisions.contains { isNew($0, seen: seen) || isUrgent($0) || isDueSoon($0, now: now) }
  }

  public static func isNew(_ decision: Decision, seen: Set<String>) -> Bool {
    !seen.contains(decision.id)
  }

  public static func isUrgent(_ decision: Decision) -> Bool {
    decision.priority == .urgent
  }

  /// A deadline strictly less than 300 seconds after `now`, including one
  /// already passed that the server has not yet expired.
  public static func isDueSoon(_ decision: Decision, now: Date) -> Bool {
    guard let deadline = decision.deadline else { return false }
    return deadline.timeIntervalSince(now) < deadlineWindow
  }
}

/// What the menu bar item shows (component-mac-app §Menu bar item).
public struct MenuBarSummary: Equatable, Sendable {
  public var count: Int
  public var dot: Bool
  public var hasNew: Bool
  public var hasUrgent: Bool

  public init(decisions: [Decision], seen: Set<String>, now: Date) {
    count = decisions.count
    dot = Attention.dot(decisions, seen: seen, now: now)
    hasNew = decisions.contains { Attention.isNew($0, seen: seen) }
    hasUrgent = decisions.contains(where: Attention.isUrgent)
  }

  /// "AgentDesk, N waiting", with ", new" and ", urgent" appended when they
  /// hold.
  public var accessibilityDescription: String {
    var text = "AgentDesk, \(count) waiting"
    if hasNew { text += ", new" }
    if hasUrgent { text += ", urgent" }
    return text
  }
}

/// The menu bar item's two styles (req-mac-app AC-3.4), kept in user
/// defaults.
public enum MenuBarStyle: String, CaseIterable, Sendable {
  case dot
  case count

  public static let key = "MenuBarStyle"

  public init(defaults: UserDefaults) {
    self = defaults.string(forKey: Self.key).flatMap(MenuBarStyle.init(rawValue:)) ?? .dot
  }

  public func save(to defaults: UserDefaults) {
    defaults.set(rawValue, forKey: Self.key)
  }
}

/// Whether the label draws its dot, and how a change shows: the dot fades in
/// once when it appears, appears at once with Reduce Motion, and a refresh
/// that keeps it changes nothing (req-mac-app AC-3.5).
public struct DotPresence: Equatable, Sendable {
  public enum Change: Equatable, Sendable {
    case none
    case hide
    case appear
    case fadeIn
  }

  public private(set) var shown = false

  public init() {}

  public mutating func update(show: Bool, reduceMotion: Bool) -> Change {
    guard show != shown else { return .none }
    shown = show
    guard show else { return .hide }
    return reduceMotion ? .appear : .fadeIn
  }
}
