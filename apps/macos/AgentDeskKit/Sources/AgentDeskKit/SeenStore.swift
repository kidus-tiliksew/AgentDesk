import Foundation

/// The ids of decisions this Mac has listed in a popover that then closed.
/// A pending decision is new while its id is absent (component-mac-app
/// §Ordering and attention; req-mac-app AC-3.3).
@MainActor
public final class SeenStore {
  public static let key = "SeenDecisionIDs"

  private let defaults: UserDefaults
  public private(set) var ids: Set<String>

  public init(defaults: UserDefaults) {
    self.defaults = defaults
    ids = Set(defaults.stringArray(forKey: Self.key) ?? [])
  }

  public func isNew(_ decision: Decision) -> Bool {
    !ids.contains(decision.id)
  }

  /// Adds every decision the closing popover listed.
  public func markSeen(_ listed: some Sequence<String>) {
    let next = ids.union(listed)
    guard next != ids else { return }
    ids = next
    save()
  }

  /// Keeps only ids still pending, after a successful decisions read.
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

  /// Clears the set on every sign-out (component-mac-app §Sign-in).
  public func clearOnSignOut(of account: Account) {
    account.addCleanup { [weak self] in self?.clear() }
  }

  private func save() {
    defaults.set(ids.sorted(), forKey: Self.key)
  }
}
