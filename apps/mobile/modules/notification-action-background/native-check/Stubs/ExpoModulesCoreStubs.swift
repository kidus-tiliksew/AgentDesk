import Foundation
@_exported import UserNotifications

// Stand-ins for the UIKit and UserNotifications calls that the pinned
// NotificationCenterManager.swift makes and a macOS test process cannot.

/// UIKit's background fetch result, which macOS lacks. The manager only
/// passes it to completion handlers.
public enum UIBackgroundFetchResult {
  case newData
  case noData
  case failed
}

/// `UNUserNotificationCenter.current()` stops a process that has no app
/// bundle. `run.sh` points the manager's delegate check at this value
/// instead.
public enum TestUserNotificationCenter {
  nonisolated(unsafe) public static var delegate: AnyObject?
}
