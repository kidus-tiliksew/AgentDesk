import Foundation

/// The order of pending decisions in the popover, the same as the mobile
/// inbox's (component-mac-app §Ordering and attention; req-mac-app AC-4.1):
/// urgent before normal, then the earliest deadline with deadline-less
/// decisions last, then the oldest `created_at`, then the id.
public enum DecisionOrder {
  public static func sorted(_ decisions: [Decision]) -> [Decision] {
    decisions.sorted(by: precedes)
  }

  public static func precedes(_ a: Decision, _ b: Decision) -> Bool {
    let aUrgent = a.priority == .urgent
    let bUrgent = b.priority == .urgent
    if aUrgent != bUrgent { return aUrgent }
    switch (a.deadline, b.deadline) {
    case (let x?, let y?) where x != y: return x < y
    case (.some, nil): return true
    case (nil, .some): return false
    default: break
    }
    if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
    return a.id < b.id
  }
}
