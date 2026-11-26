import ExpoNotifications
import Foundation
import UserNotifications

// component-mobile-app §Notifications: the order in which a notification
// button press that launches the app reaches JavaScript (REQ-4, AC-4.1).
//
// expo-notifications 57.0.22 delivers a response in
// `NotificationCenterManager.userNotificationCenter(_:didReceive:withCompletionHandler:)`.
// That method copies its delegate list, offers the response to each delegate
// in the copy, and then queues the response when no delegate handled it. The
// emitter module feeds the JavaScript response listener and the launch
// response. React Native creates it when the host starts, and it registers
// through `addDelegate`, which hands it the queued responses. A host started
// inside the delegate loop lets the emitter register after the copy and
// before the queue append. The emitter then misses the press on both paths.
//
// So a press only requests a host start. The start runs on the main queue
// after the delegate loop returns, and only once the press is in the queue.
// Whichever order the emitter registers in, it then receives the press once:
// from the delegate loop when it is in the copy, or from `addDelegate`
// otherwise.

/// Starts the React host for an AgentDesk button press after expo-notifications
/// has queued the press.
final class ColdPressHostStart: Sendable {
  struct Hooks: Sendable {
    /// Whether a React host already runs, so its emitter takes the press.
    var hostRunning: @MainActor @Sendable () -> Bool
    /// Whether expo-notifications holds this press in its response queue.
    var isQueued: @MainActor @Sendable (_ requestId: String, _ actionId: String) -> Bool
    /// Starts the React host.
    var startHost: @MainActor @Sendable () -> Void
  }

  /// The wait between checks of the queue.
  static let retryDelay: TimeInterval = 0.02
  /// The checks before the host starts without the press in the queue, about
  /// one second in all. When no delegate handled the press, the queue holds
  /// it as soon as the delegate loop returns, so the limit only bounds a
  /// press that a delegate handled.
  static let attempts = 50

  private let hooks: Hooks

  init(hooks: Hooks) {
    self.hooks = hooks
  }

  /// Requests a host start for a press. Callable from any thread. The first
  /// check runs on a later main queue turn, never inside the caller.
  func request(requestId: String, actionId: String) {
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        self.attempt(requestId: requestId, actionId: actionId, remaining: Self.attempts)
      }
    }
  }

  @MainActor
  private func attempt(requestId: String, actionId: String, remaining: Int) {
    if hooks.hostRunning() {
      return
    }
    if remaining <= 1 || hooks.isQueued(requestId, actionId) {
      hooks.startHost()
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelay) {
      MainActor.assumeIsolated {
        self.attempt(requestId: requestId, actionId: actionId, remaining: remaining - 1)
      }
    }
  }
}

/// Reports whether expo-notifications holds the press in its queue of
/// responses that no delegate handled. `addDelegate` offers every queued
/// response to the delegate it adds. The probe handles none, so the queue
/// stays as it is, and the probe leaves the delegate list at once.
@MainActor
func isQueuedInNotificationCenter(requestId: String, actionId: String) -> Bool {
  let probe = QueuedResponseProbe(requestId: requestId, actionId: actionId)
  NotificationCenterManager.shared.addDelegate(probe)
  NotificationCenterManager.shared.removeDelegate(probe)
  return probe.found
}

private final class QueuedResponseProbe: NotificationDelegate, @unchecked Sendable {
  private let requestId: String
  private let actionId: String
  private let lock = NSLock()
  private var matched = false

  init(requestId: String, actionId: String) {
    self.requestId = requestId
    self.actionId = actionId
  }

  var found: Bool {
    lock.lock()
    defer { lock.unlock() }
    return matched
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    if response.notification.request.identifier == requestId && response.actionIdentifier == actionId {
      lock.lock()
      matched = true
      lock.unlock()
    }
    return false
  }
}
