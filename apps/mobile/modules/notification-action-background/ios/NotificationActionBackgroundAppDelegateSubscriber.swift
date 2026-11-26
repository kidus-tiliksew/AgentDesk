internal import Expo
import ExpoModulesCore
import ExpoNotifications
import React
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
      onMain {
        ActionWindows.shared.begin(requestId: requestId, actionId: actionId)
        startReactHostIfNeeded()
      }
    }
    return false
  }
}

/// component-mobile-app §Notifications: a button pressed while the app is not
/// running launches it in the background. Under the UIScene life cycle that
/// `expo-build-properties` `ios.enableSceneSupport` adopts, the generated
/// AppDelegate only creates the React Native factory, and Expo's scene
/// delegate starts React Native when UIKit connects a scene. Apple documents a
/// background notification action as a background launch that calls the
/// notification center delegate, with no scene connection promised. When no
/// scene connects, no JavaScript runs without this call, the response
/// listener in `src/notification-action-task.ts` never loads, and the answer
/// is lost (REQ-4, AC-4.1).
///
/// The call starts the React host of the app delegate's existing factory with
/// no window, root view, or scene. React Native evaluates the bundle, so the
/// module-scope response listener and the launch response read carry the
/// press. expo-notifications holds the response until its emitter module
/// registers. A scene that connects later reuses the same host, because
/// `RCTRootViewFactory` creates a host only when it has none.
///
/// It does nothing when the host already runs, when the app delegate provides
/// no factory, or in a Debug build with the Expo dev launcher. The dev
/// launcher chooses the bundle and starts React Native only when a scene
/// connects, and this call must not bypass that choice. So a Debug
/// development build sends no answer for a press while the app is not
/// running when no scene connects. A Release build starts the host, so
/// JavaScript can answer within the background time iOS grants.
@MainActor
func startReactHostIfNeeded() {
  if EXAppDefines.APP_DEBUG && NSClassFromString("EXDevLauncherController") != nil {
    return
  }
  guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
    let factory = provider.reactNativeFactory else {
    return
  }
  let rootViewFactory = factory.rootViewFactory
  if rootViewFactory.value(forKey: "reactHost") != nil {
    return
  }
  rootViewFactory.initializeReactHost(
    launchOptions: nil,
    bundleConfiguration: factory.bundleConfiguration,
    devMenuConfiguration: factory.devMenuConfiguration ?? RCTDevMenuConfiguration.default()
  )
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
