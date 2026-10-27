import SwiftUI

/// A menu bar app with one item and its popover. `LSUIElement` keeps it out
/// of the Dock, and it opens no other window (req-mac-app AC-1.1; DEC-19(1)).
@main
struct AgentDeskApp: App {
  /// The delegate owns the state so quitting can wait for unsent answers.
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra {
      PopoverView(state: delegate.state)
    } label: {
      MenuBarLabel(state: delegate.state)
    }
    .menuBarExtraStyle(.window)
  }
}
