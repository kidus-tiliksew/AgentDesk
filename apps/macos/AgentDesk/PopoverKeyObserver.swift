import AgentDeskKit
import AppKit
import SwiftUI

/// Passes one window's keys to `key`, which returns false to leave a key to
/// the focused control (component-mac-app §Keyboard and accessibility). The
/// popover and the detail panel each place one, so the keys work from either
/// window. Tab and Shift-Tab are never read, so the focus chain stays AppKit's.
struct PopoverKeyObserver: NSViewRepresentable {
  /// The panel's radio buttons and checkboxes keep the arrows when focused.
  var controlsKeepArrows = false
  let key: @MainActor (PopoverKey, _ editingText: Bool) -> Bool

  func makeNSView(context: Context) -> WindowView {
    let view = WindowView()
    view.key = key
    view.controlsKeepArrows = controlsKeepArrows
    return view
  }

  func updateNSView(_ view: WindowView, context: Context) {
    view.key = key
    view.controlsKeepArrows = controlsKeepArrows
  }

  final class WindowView: NSView {
    var key: (@MainActor (PopoverKey, Bool) -> Bool)?
    var controlsKeepArrows = false
    private var keyMonitor: Any?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let keyMonitor {
        NSEvent.removeMonitor(keyMonitor)
        self.keyMonitor = nil
      }
      guard window != nil else { return }
      // A local monitor sees each key before the focused control, so the
      // list's keys work whichever control has focus; text fields keep their
      // arrows and Return.
      keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
        guard let key = Self.popoverKey(event) else { return event }
        let windowNumber = event.windowNumber
        let consumed = MainActor.assumeIsolated {
          guard let self, let window = self.window, window.windowNumber == windowNumber else {
            return false
          }
          return self.key?(key, self.keepsKey(key, in: window)) == true
        }
        return consumed ? nil : event
      }
    }

    private func keepsKey(_ key: PopoverKey, in window: NSWindow) -> Bool {
      let responder = window.firstResponder
      if responder is NSText { return true }
      return controlsKeepArrows && (key == .up || key == .down) && responder is NSControl
    }

    /// ↑, ↓, ↩ and Enter, ⌘↩, and Escape. Any other modifier leaves the key
    /// alone.
    static func popoverKey(_ event: NSEvent) -> PopoverKey? {
      let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
      switch (event.keyCode, modifiers) {
      case (126, []): return .up
      case (125, []): return .down
      case (36, []), (76, []): return .returnKey
      case (36, .command), (76, .command): return .commandReturn
      case (53, []): return .escape
      default: return nil
      }
    }
  }
}
