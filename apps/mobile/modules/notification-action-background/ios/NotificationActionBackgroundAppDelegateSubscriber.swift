import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

/// Begins the background task for an AgentDesk action response while the
/// response is still being delivered, before expo-notifications calls the
/// system completion handler. It returns false, so expo-notifications still
/// hands the response to its emitter, the JavaScript response listener, and
/// the launch response, and default taps are untouched.
final class ActionResponseDelegate: NotificationDelegate, Sendable {
  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let request = response.notification.request
    let actionId = response.actionIdentifier
    if isAnswerAction(categoryId: request.content.categoryIdentifier, actionId: actionId) {
      let requestId = request.identifier
      _ = onMain {
        ActionWindows.shared.begin(requestId: requestId, actionId: actionId)
      }
    }
    return false
  }
}

/// Registers the delegate through expo-notifications' public
/// `NotificationCenterManager.shared.addDelegate` while the app launches, so
/// a response that launches the app in the background reaches it. It does
/// not replace the UNUserNotificationCenter delegate.
public final class NotificationActionBackgroundAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private static let delegate = ActionResponseDelegate()

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(Self.delegate)
    return false
  }
}
