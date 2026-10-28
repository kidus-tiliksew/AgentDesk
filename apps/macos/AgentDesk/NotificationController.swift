import AgentDeskKit
import UserNotifications

/// Adapts `UNUserNotificationCenter` to `NotificationCenterAdapter` and
/// receives clicks and actions as its delegate (component-mac-app
/// §Notifications; req-mac-app AC-6.3, AC-6.4). It posts only what
/// `Notifier` hands it; a request names the decision by id and carries no
/// credential or user info (DEC-19(3)).
@MainActor
final class NotificationController: NSObject, NotificationCenterAdapter {
  /// A click on a notification, by decision id.
  var onOpen: (@MainActor (String) -> Void)?
  /// A notification action, by decision id and action identifier.
  var onAction: (@MainActor (String, String) -> Void)?

  private let center: UNUserNotificationCenter

  /// Becomes the center's delegate at once, so a click or action that
  /// launched the app reaches it.
  init(center: UNUserNotificationCenter = .current()) {
    self.center = center
    super.init()
    center.delegate = self
    center.setNotificationCategories(Self.categories)
  }

  /// `decision.approve_reject` with Reject and Approve. Neither action
  /// opens the app (AC-6.3).
  static var categories: Set<UNNotificationCategory> {
    let reject = UNNotificationAction(
      identifier: NotificationRequest.rejectAction, title: "Reject", options: [])
    let approve = UNNotificationAction(
      identifier: NotificationRequest.approveAction, title: "Approve", options: [])
    return [
      UNNotificationCategory(
        identifier: NotificationRequest.approveRejectCategory, actions: [reject, approve],
        intentIdentifiers: [], options: [])
    ]
  }

  /// The system content for a planned request: title, body, the default
  /// sound, and the category for approve-or-reject. User info stays empty.
  static func content(for request: NotificationRequest) -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = request.title
    content.body = request.body
    if request.playsDefaultSound { content.sound = .default }
    if let category = request.categoryIdentifier { content.categoryIdentifier = category }
    return content
  }

  // MARK: NotificationCenterAdapter

  func authorization() async -> NotificationAuthorization {
    await withCheckedContinuation { continuation in
      center.getNotificationSettings { settings in
        let status: NotificationAuthorization
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: status = .authorized
        case .denied: status = .denied
        case .notDetermined: status = .notDetermined
        @unknown default: status = .denied
        }
        continuation.resume(returning: status)
      }
    }
  }

  // The completion-handler forms keep the center on the main actor; the
  // async forms send it across isolation, which SDKs that do not mark it
  // Sendable reject in the Swift 6 language mode.
  func requestAuthorization() async -> Bool {
    await withCheckedContinuation { continuation in
      center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        continuation.resume(returning: granted)
      }
    }
  }

  func add(_ request: NotificationRequest) async throws {
    let system = UNNotificationRequest(
      identifier: request.identifier, content: Self.content(for: request), trigger: nil)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      center.add(system) { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      }
    }
  }

  func deliveredIdentifiers() async -> [String] {
    await withCheckedContinuation { continuation in
      center.getDeliveredNotifications { notifications in
        continuation.resume(returning: notifications.map(\.request.identifier))
      }
    }
  }

  func removeDelivered(_ identifiers: [String]) {
    center.removeDeliveredNotifications(withIdentifiers: identifiers)
  }

  func removeAllDelivered() {
    center.removeAllDeliveredNotifications()
  }
}

extension NotificationController: UNUserNotificationCenterDelegate {
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let id = response.notification.request.identifier
    let action = response.actionIdentifier
    await MainActor.run {
      switch action {
      case UNNotificationDefaultActionIdentifier: self.onOpen?(id)
      case UNNotificationDismissActionIdentifier: break
      default: self.onAction?(id, action)
      }
    }
  }

  /// The planner posts nothing while the popover is open, so a notification
  /// that arrives while the app is active still shows.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }
}
