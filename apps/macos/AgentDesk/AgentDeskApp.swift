import SwiftUI

/// A menu bar app with one item and its popover. `LSUIElement` keeps it out
/// of the Dock, and it opens no other window (req-mac-app AC-1.1; DEC-19(1)).
/// `PopoverController` owns the item and the popover, so the only scene is
/// an empty Settings scene with its menu item removed; it keeps SwiftUI's
/// standard Quit and Edit key equivalents for the popover's text fields.
@main
struct AgentDeskApp: App {
  /// The delegate owns the state so quitting can wait for unsent answers.
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    Settings {
      EmptyView()
    }
    .commands {
      CommandGroup(replacing: .appSettings) {}
    }
  }
}
