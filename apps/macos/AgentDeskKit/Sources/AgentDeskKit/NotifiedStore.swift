import Foundation

/// The ids of decisions this Mac has posted a notification for, or listed in
/// an open popover, so each pending decision is posted at most once
/// (component-mac-app §Notifications; req-mac-app AC-6.1; req-notification-rules
/// REQ-7).
@MainActor
public final class NotifiedStore {
  public static let key = "NotifiedDecisionIDs"

  private let defaults: UserDefaults
  public private(set) var ids: Set<String>

  public init(defaults: UserDefaults) {
    self.defaults = defaults
    ids = Set(defaults.stringArray(forKey: Self.key) ?? [])
  }

  public func contains(_ id: String) -> Bool {
    ids.contains(id)
  }

  /// Adds posted ids, or ids the open popover listed.
  public func mark(_ added: some Sequence<String>) {
    let next = ids.union(added)
    guard next != ids else { return }
    ids = next
    save()
  }

  /// Keeps only ids still pending, after a complete successful decisions read.
  public func prune(toPending pending: some Sequence<String>) {
    let next = ids.intersection(pending)
    guard next != ids else { return }
    ids = next
    save()
  }

  public func clear() {
    ids = []
    defaults.removeObject(forKey: Self.key)
  }

  private func save() {
    defaults.set(ids.sorted(), forKey: Self.key)
  }
}
