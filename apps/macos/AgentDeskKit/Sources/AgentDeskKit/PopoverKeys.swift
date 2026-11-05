import Foundation

/// The popover's keys (component-mac-app §Keyboard and accessibility;
/// req-mac-app AC-7.1).
public enum PopoverKey: Equatable, Sendable {
  case up
  case down
  case returnKey
  case commandReturn
  case escape
}

/// What a key does to the list.
public enum PopoverKeyAction: Equatable, Sendable {
  /// Select this row.
  case select(String)
  /// Expand the row, or collapse it when it is expanded.
  case toggle(String)
  /// Send the row's chosen answer, or its recommendation.
  case send(String)
  /// Collapse the expanded row.
  case collapse
  /// Leave the key to the focused control or the popover window: a text
  /// field keeps its arrows and Return, and Escape with nothing expanded
  /// closes the popover.
  case passThrough
}

public enum PopoverKeys {
  /// Maps a key to its action. Selection and expansion are decision ids;
  /// an id no longer in `rows` counts as none. While a text field is being
  /// edited, ↑, ↓, and ↩ stay with the field, and ⌘↩ and Escape still act.
  public static func action(
    for key: PopoverKey, rows: [String], selected: String?, expanded: String?, editingText: Bool
  ) -> PopoverKeyAction {
    let selected = selected.flatMap { rows.contains($0) ? $0 : nil }
    let expanded = expanded.flatMap { rows.contains($0) ? $0 : nil }
    switch key {
    case .up, .down:
      guard !editingText, !rows.isEmpty else { return .passThrough }
      guard let current = selected ?? expanded, let index = rows.firstIndex(of: current) else {
        return .select(key == .down ? rows[0] : rows[rows.count - 1])
      }
      let next = key == .down ? min(index + 1, rows.count - 1) : max(index - 1, 0)
      return .select(rows[next])
    case .returnKey:
      guard !editingText, let target = selected ?? expanded else { return .passThrough }
      return .toggle(target)
    case .commandReturn:
      guard let target = selected ?? expanded else { return .passThrough }
      return .send(target)
    case .escape:
      return expanded == nil ? .passThrough : .collapse
    }
  }

  /// The selection after the list changed: kept when its row remains,
  /// otherwise moved to the row that took its place, or none when the list
  /// is empty.
  public static func reselect(_ selected: String?, previous: [String], rows: [String]) -> String? {
    guard let selected else { return nil }
    if rows.contains(selected) { return selected }
    guard !rows.isEmpty else { return nil }
    guard let index = previous.firstIndex(of: selected) else { return nil }
    // The first row after the old one that is still listed, else the last
    // one before it.
    if let after = previous[(index + 1)...].first(where: rows.contains) { return after }
    return previous[..<index].last(where: rows.contains)
  }
}

/// Where the decision list should scroll (component-mac-app §List scrolling;
/// req-mac-app AC-4.12). The generation moves on every request, so the latest
/// one wins and a repeated target still scrolls.
public struct ListScrollRequest: Equatable, Sendable {
  public enum Target: Equatable, Sendable {
    case top
    case row(String)
  }

  public private(set) var target: Target = .top
  public private(set) var generation = 0

  public init() {}

  /// An ordinary opening: the first row.
  public mutating func toTop() {
    target = .top
    generation += 1
  }

  /// A row the keys or a notification asked for.
  public mutating func toRow(_ id: String) {
    target = .row(id)
    generation += 1
  }

  /// Applies the current target again, once the content view is back in the
  /// popover window. A row target stays a row target.
  public mutating func repeatLast() {
    generation += 1
  }
}

/// The popover's height budget (component-mac-app §Popover).
public enum PopoverLayout {
  public static let maxHeight: Double = 560
  /// The list keeps this much whatever else the popover shows.
  public static let minListHeight: Double = 120

  /// What remains of the popover for the list beside everything else it
  /// shows: the header, strips, dividers, and agents line with its list.
  public static func listMaxHeight(chromeHeight: Double) -> Double {
    max(minListHeight, maxHeight - chromeHeight)
  }
}
