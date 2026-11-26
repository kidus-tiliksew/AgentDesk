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
// So a press only requests a host start, and the start runs on the main
// queue after the delegate loop returns. Two presses can overlap: press A can
// be queued while press B is inside its own delegate loop, after B's copy and
// before B's queue append. A host started then misses B on both paths. So
// `request` records each press at once, inside the delegate loop, and the host
// starts only when every press recorded in this process is in the queue.
// Whichever order the emitter registers in, it then receives each recorded
// press once: from the delegate loop when it is in the copy, or from
// `addDelegate` otherwise. When iOS delivers responses on the main thread,
// a delegate loop and a check cannot interleave at all.
//
// The rule covers a press only from its `request` call. A press whose
// delegate loop copied the list but has not yet called this module's delegate
// is not recorded, and a host that starts in that gap misses it. When a
// recorded press has waited `maxWait`, about one second, without reaching
// the queue, the host starts anyway. A press still in its delegate loop then
// is queued after the emitter registered and stays queued until a later
// `addDelegate`. This bounded wait gives no unconditional queue guarantee and
// no exactly-once guarantee.

/// Starts the React host for AgentDesk button presses after expo-notifications
/// has queued every press seen in this process.
final class ColdPressHostStart: @unchecked Sendable {
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
  /// The checks that one press waits for before the host starts without it
  /// in the queue. When no delegate handled the press, the queue holds it as
  /// soon as its delegate loop returns, so the limit only bounds a press that
  /// a delegate handled or a delegate loop that stalls.
  static let attempts = 50
  /// The longest wait of one recorded press, about one second.
  static var maxWait: TimeInterval { Double(attempts) * retryDelay }

  private struct Press: Hashable {
    let requestId: String
    let actionId: String
  }

  private let hooks: Hooks
  private let lock = NSLock()
  /// Presses recorded and not yet seen in the queue, with the time of each
  /// record. Guarded by `lock`.
  private var waiting: [Press: DispatchTime] = [:]
  /// Whether a check is scheduled on the main queue. Guarded by `lock`.
  private var checkScheduled = false

  init(hooks: Hooks) {
    self.hooks = hooks
  }

  /// Records a press and requests a host start. Callable from any thread.
  /// The record is made before the call returns, so a check that runs while
  /// this press is still in its delegate loop waits for it. The first check
  /// runs on a later main queue turn, never inside the caller.
  func request(requestId: String, actionId: String) {
    let press = Press(requestId: requestId, actionId: actionId)
    lock.lock()
    if waiting[press] == nil {
      waiting[press] = .now()
    }
    let schedule = !checkScheduled
    checkScheduled = true
    lock.unlock()
    if schedule {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.check()
        }
      }
    }
  }

  @MainActor
  private func check() {
    if hooks.hostRunning() {
      finish()
      return
    }

    lock.lock()
    let recorded = waiting
    lock.unlock()

    // Probe outside the lock: the probe calls `addDelegate`, and a delivery on
    // another thread can call `request` meanwhile.
    var queued: [Press] = []
    var overdue = false
    let now = DispatchTime.now()
    for (press, recordedAt) in recorded {
      if hooks.isQueued(press.requestId, press.actionId) {
        queued.append(press)
      } else if now >= recordedAt + Self.maxWait {
        overdue = true
      }
    }

    // A press in the queue stays there until a delegate handles it, so it
    // needs no second probe. A press recorded after the copy above is still
    // waiting, so the host does not start before it is probed.
    lock.lock()
    for press in queued {
      waiting.removeValue(forKey: press)
    }
    let ready = waiting.isEmpty || overdue
    lock.unlock()

    if ready {
      hooks.startHost()
      finish()
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelay) {
      MainActor.assumeIsolated {
        self.check()
      }
    }
  }

  /// Ends the checks once a host runs. A later press finds the host running.
  @MainActor
  private func finish() {
    lock.lock()
    waiting.removeAll()
    checkScheduled = false
    lock.unlock()
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
