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
