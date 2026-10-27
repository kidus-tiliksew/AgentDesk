import SwiftUI

/// A menu bar app with one item and its popover. `LSUIElement` keeps it out
/// of the Dock, and it opens no other window (req-mac-app AC-1.1; DEC-19(1)).
@main
struct AgentDeskApp: App {
  @State private var state = AppState()

  var body: some Scene {
    MenuBarExtra {
      PopoverView(state: state)
    } label: {
      MenuBarLabel(state: state)
    }
    .menuBarExtraStyle(.window)
  }
}
