import UIKit

// component-mobile-app §Notifications: background time for a notification
// action button on iOS.
//
// expo-notifications calls the system completion handler for a notification
// response before JavaScript runs, so iOS may suspend the app while the answer
// is still being sent. This registry holds a UIApplication background task for
// each AgentDesk action response from the moment the response arrives until
// JavaScript finishes it or iOS expires it. iOS grants about 30 seconds; it
// does not guarantee any duration.

/// The AgentDesk category and action pairs whose button answers a decision.
/// Default taps, other actions, and other categories get no background task.
let answerActions: [String: Set<String>] = [
  "decision-approve-reject": ["approve", "reject"],
  "decision-choice-2": ["option-1", "option-2"],
  "decision-choice-3": ["option-1", "option-2", "option-3"],
]

func isAnswerAction(categoryId: String, actionId: String) -> Bool {
  return answerActions[categoryId]?.contains(actionId) == true
}

/// A window's state as JavaScript reads it. `unavailable` means iOS granted no
/// background task, so the window protects nothing.
enum ActionWindowState: String {
  case running
  case finished
  case expired
  case unavailable
}

struct ActionWindow {
  let id: String
  var task: UIBackgroundTaskIdentifier
  var state: ActionWindowState
  let order: Int

  var asRecord: [String: Any] {
    return ["id": id, "state": state.rawValue]
  }
}

/// One background task per response, keyed by the notification request id
/// and the action id. A repeated delivery of the same response, such as the
/// live listener and the launch response, shares the existing window instead
/// of taking more background time. Each task ends once, when JavaScript
/// finishes it or when iOS expires it. Ended windows stay readable, so a late
/// begin cannot revive a window that already ended, until the registry drops
/// the oldest ended entries past its bound.
@MainActor
final class ActionWindows {
  static let shared = ActionWindows()

  private static let limit = 32

  private var windows: [String: ActionWindow] = [:]
  private var keysById: [String: String] = [:]
  private var counter = 0

  /// Called with a window id when iOS expires it, so the module can tell
  /// JavaScript.
  var onExpire: ((String) -> Void)?

  private static func key(requestId: String, actionId: String) -> String {
    return "\(requestId)\u{0}\(actionId)"
  }

  /// Returns the window for this response, beginning a background task when
  /// there is none yet.
  func begin(requestId: String, actionId: String) -> ActionWindow {
    let key = Self.key(requestId: requestId, actionId: actionId)
    if let existing = windows[key] {
      return existing
    }
    counter += 1
    let id = "action-window-\(counter)"
    windows[key] = ActionWindow(id: id, task: .invalid, state: .running, order: counter)
    keysById[id] = key
    let task = UIApplication.shared.beginBackgroundTask(withName: "AgentDesk notification action") {
      MainActor.assumeIsolated {
        ActionWindows.shared.expire(id: id)
      }
    }
    if task == .invalid {
      windows[key]?.state = .unavailable
    } else if windows[key]?.state == .running {
      windows[key]?.task = task
    } else {
      // The window ended while the task was being granted.
      UIApplication.shared.endBackgroundTask(task)
    }
    prune()
    return windows[key] ?? ActionWindow(id: id, task: .invalid, state: .unavailable, order: counter)
  }

  /// Ends the window's task after JavaScript has finished with the response.
  /// A window that already ended is left as it is.
  func finish(id: String) {
    guard let key = keysById[id], var window = windows[key], window.state == .running else {
      return
    }
    end(&window)
    window.state = .finished
    windows[key] = window
  }

  private func expire(id: String) {
    guard let key = keysById[id], var window = windows[key], window.state == .running else {
      return
    }
    end(&window)
    window.state = .expired
    windows[key] = window
    onExpire?(id)
  }

  private func end(_ window: inout ActionWindow) {
    if window.task != .invalid {
      UIApplication.shared.endBackgroundTask(window.task)
      window.task = .invalid
    }
  }

  /// Drops the oldest ended windows past the bound. Running windows stay.
  private func prune() {
    guard windows.count > Self.limit else {
      return
    }
    let ended = windows
      .filter { $0.value.state != .running }
      .sorted { $0.value.order < $1.value.order }
    for (key, window) in ended.prefix(windows.count - Self.limit) {
      windows.removeValue(forKey: key)
      keysById.removeValue(forKey: window.id)
    }
  }
}

/// Runs `body` on the main actor, synchronously, from any thread.
func onMain<T: Sendable>(_ body: @MainActor () -> T) -> T {
  if Thread.isMainThread {
    return MainActor.assumeIsolated(body)
  }
  return DispatchQueue.main.sync {
    MainActor.assumeIsolated(body)
  }
}
