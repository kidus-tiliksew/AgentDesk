import Foundation

/// A rectangle in screen points with a bottom-left origin, as AppKit reports
/// window and screen frames, in plain numbers so the panel's placement is
/// testable without AppKit (component-mac-app §Detail panel).
public struct PanelRect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public var minX: Double { x }
  public var maxX: Double { x + width }
  public var minY: Double { y }
  public var maxY: Double { y + height }
}

/// Where the detail panel goes beside the popover (req-mac-app AC-11.1;
/// DEC-23(2)). The panel is 400 pt wide, on the right when the screen's
/// visible frame has room and otherwise on the left. Its top meets the top of
/// the popover's content, and its height follows its content up to the space
/// left on the screen and at most the popover's own 560 pt limit.
public enum DetailPanelPlacement {
  public enum Side: Equatable, Sendable {
    case left
    case right
  }

  public static let width: Double = 400
  public static let gap: Double = 8
  public static let maxHeight = PopoverLayout.maxHeight

  public static func side(popover: PanelRect, screen: PanelRect) -> Side {
    popover.maxX + gap + width <= screen.maxX ? .right : .left
  }

  /// The tallest the panel may be below the top of the popover's content.
  public static func availableHeight(popover: PanelRect, screen: PanelRect) -> Double {
    max(0, min(maxHeight, min(popover.maxY, screen.maxY) - screen.minY))
  }

  /// The panel's frame. A screen too narrow for either side keeps the panel
  /// on the left and inside the visible frame, over the popover if it must.
  public static func frame(popover: PanelRect, screen: PanelRect, contentHeight: Double) -> PanelRect {
    let wanted =
      side(popover: popover, screen: screen) == .right ? popover.maxX + gap : popover.minX - gap - width
    let x = max(screen.minX, min(wanted, screen.maxX - width))
    let height = min(max(contentHeight, 1), availableHeight(popover: popover, screen: screen))
    return PanelRect(x: x, y: min(popover.maxY, screen.maxY) - height, width: width, height: height)
  }
}

/// Which decision the panel shows, kept apart from the list's selection, so
/// a parent or follow-up link and a decision settled while shown survive
/// leaving the pending list (req-mac-app AC-4.6, AC-11.5, AC-11.7). The
/// generation moves whenever the target changes, so a read that started for
/// an earlier target changes nothing.
public struct DetailPanelState: Equatable, Sendable {
  public private(set) var shownID: String?
  public private(set) var generation = 0
  /// The decision an answer closed the panel on; Undo reopens it (AC-4.8).
  public private(set) var reopenOnUndo: String?

  public init() {}

  /// Opens the target, or closes the panel when it already shows that target
  /// (AC-11.7). Another target replaces the shown one in the same panel.
  public mutating func toggle(_ id: String) {
    if shownID == id {
      close()
    } else {
      show(id)
    }
  }

  /// Shows the target. Showing the shown target changes nothing.
  public mutating func show(_ id: String) {
    guard shownID != id else { return }
    shownID = id
    generation += 1
  }

  /// Closes the panel. A held answer's reopening stays, so Undo still restores
  /// the panel after Escape closed a later target.
  public mutating func close() {
    guard shownID != nil else { return }
    shownID = nil
    generation += 1
  }

  /// An answer is held: a panel showing that decision closes and Undo will
  /// reopen it, and any other shown decision stays (AC-4.8).
  public mutating func answerHeld(_ id: String) {
    if shownID == id {
      reopenOnUndo = id
      close()
    } else {
      reopenOnUndo = nil
    }
  }

  /// The held answer was undone. Reopens the panel only when that answer
  /// closed it, and reports whether it did.
  @discardableResult
  public mutating func answerUndone(_ id: String) -> Bool {
    defer { reopenOnUndo = nil }
    guard reopenOnUndo == id else { return false }
    show(id)
    return true
  }

  /// Sign-out: nothing of the old account stays.
  public mutating func reset() {
    close()
    reopenOnUndo = nil
    generation += 1
  }
}

/// What a click does to the popover and the panel, whose lifetime the app
/// controls because a transient popover closes on a click in another window
/// (req-mac-app AC-11.8).
public enum PopoverDismissal {
  public enum Click: Equatable, Sendable {
    /// In the popover or the panel: both stay.
    case ownedWindow
    /// On the menu bar item, whose own action closes the popover. Closing
    /// here as well would make that action open it again.
    case statusItem
    /// Anywhere else, in this app or another.
    case elsewhere
  }

  public static func closes(_ click: Click, menuIsTracking: Bool) -> Bool {
    click == .elsewhere && !menuIsTracking
  }
}
