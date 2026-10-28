import Foundation

/// The two notification settings of this Mac: Notifications On and Off, and
/// a pause of 1 hour (req-mac-app AC-6.6, AC-8.1). They change notifications
/// alone; the menu bar item and the list never read them.
@MainActor
public final class NotificationSettings {
  public static let onKey = "NotificationsOn"
  public static let pausedUntilKey = "NotificationsPausedUntil"
  public static let pauseDuration: TimeInterval = 3600

  private let defaults: UserDefaults
  /// Notifications On, true when unset.
  public private(set) var isOn: Bool
  /// When a pause ends. A passed time is no pause.
  public private(set) var pausedUntil: Date?

  public init(defaults: UserDefaults) {
    self.defaults = defaults
    isOn = defaults.object(forKey: Self.onKey) as? Bool ?? true
    pausedUntil = defaults.object(forKey: Self.pausedUntilKey) as? Date
  }

  /// The end of a pause still running at `now`, or nil.
  public func pauseEnd(now: Date) -> Date? {
    guard let pausedUntil, pausedUntil > now else { return nil }
    return pausedUntil
  }

  /// Whether a notification may be posted at `now`: notifications are on
  /// and no pause is running.
  public func allowsPosting(now: Date) -> Bool {
    isOn && pauseEnd(now: now) == nil
  }

  /// Pauses notifications for 1 hour from `now`.
  public func pause(now: Date) {
    let end = now.addingTimeInterval(Self.pauseDuration)
    pausedUntil = end
    defaults.set(end, forKey: Self.pausedUntilKey)
  }

  /// Ends a running pause.
  public func resume() {
    pausedUntil = nil
    defaults.removeObject(forKey: Self.pausedUntilKey)
  }

  /// Turns notifications on or off. A pause's end is kept, so a pause still
  /// running when notifications come back on holds until it ends.
  public func setOn(_ on: Bool) {
    isOn = on
    defaults.set(on, forKey: Self.onKey)
  }
}
