import AgentDeskKit
import SwiftUI

/// The secondary line under the popover's header while notifications are
/// paused, naming when the pause ends (component-mac-app §Popover;
/// req-mac-app AC-6.6). It uses the contrast-checked secondary ink.
struct NotificationPauseLine: View {
  let end: Date
  var now = Date()

  var body: some View {
    Text(Self.text(end: end, now: now))
      .font(.callout)
      .foregroundStyle(Ink.secondary)
      .fixedSize(horizontal: false, vertical: true)
  }

  /// "Notifications paused until 3:45 PM", with the date when the pause
  /// ends on another day.
  static func text(end: Date, now: Date) -> String {
    let sameDay = Calendar.current.isDate(end, inSameDayAs: now)
    let time = end.formatted(
      sameDay ? .dateTime.hour().minute() : .dateTime.weekday(.abbreviated).hour().minute())
    return "Notifications paused until \(time)"
  }
}
