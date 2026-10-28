import AppKit

/// Owns the app's state and the menu bar item, and defers quitting until
/// held and sending answers have reached the server (component-mac-app
/// §Pending answers).
///
/// `NSApplication.willTerminateNotification` arrives too late to wait for a
/// request, so termination waits here instead. Each request is bounded by
/// the API client's 15-second timeout. A send that fails returns its row and
/// cancels the quit, so the answer stays on screen to retry; a sent, refused
/// as already settled, or missing decision lets the app quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let state = AppState()
  private var isSending = false
  private var popover: PopoverController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    popover = PopoverController(state: state)
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard state.hasUnsentAnswers else { return .terminateNow }
    // A second Quit while the first waits keeps waiting for the same answer.
    guard !isSending else { return .terminateLater }
    isSending = true
    Task {
      let delivered = await state.sendAnswersBeforeQuit()
      isSending = false
      sender.reply(toApplicationShouldTerminate: delivered)
    }
    return .terminateLater
  }
}
