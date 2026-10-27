import Foundation

/// The part of the app's `AppState` that `MenuBarLabel` reads, so the
/// harness can compile the shipped label without the account, Keychain, or
/// network.
@MainActor
final class AppState {
  var isSignedIn = true
  var menuBarStyle = MenuBarStyle.dot
  var summary: MenuBarSummary
  var dotOpacity: Double = 0
  var labelDescription: String { summary.accessibilityDescription }

  init(summary: MenuBarSummary) {
    self.summary = summary
  }
}
