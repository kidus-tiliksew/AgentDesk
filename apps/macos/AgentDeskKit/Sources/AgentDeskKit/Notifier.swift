import Foundation
import OSLog

/// Whether the user lets the app post notifications.
public enum NotificationAuthorization: Equatable, Sendable {
  case notDetermined
  case denied
  case authorized
}

/// The part of `UNUserNotificationCenter` the app uses. The app target
/// adapts the system center to it, so `AgentDeskKit` imports no
/// UserNotifications and tests run against a fake.
@MainActor
public protocol NotificationCenterAdapter: AnyObject {
  func authorization() async -> NotificationAuthorization
  /// Asks the user once; later calls answer without asking.
  func requestAuthorization() async -> Bool
  func add(_ request: NotificationRequest) async throws
  func deliveredIdentifiers() async -> [String]
  func removeDelivered(_ identifiers: [String])
  func removeAllDelivered()
}

/// Performs `NotificationPlanner`'s plan for each complete successful
/// decisions read (component-mac-app §Notifications; req-mac-app REQ-6).
///
/// Reads are handled one at a time in arrival order. A decision whose post
/// is in flight is not planned again, a post that fails is retried on a
/// later read, and only a post the center accepted enters `NotifiedStore`.
/// Each account has a generation: `reset()` clears the store and every
/// delivered notification, and a post that completes for an older
/// generation is removed again, so no notification outlives its account.
@MainActor
public final class Notifier {
  public typealias AgentRead = @Sendable () async throws(APIError) -> [AgentSession]

  public let settings: NotificationSettings
  public let store: NotifiedStore
  /// Set by the app when the popover opens and closes.
  public var isPopoverOpen = false
  /// Ids whose post is in flight.
  public private(set) var posting: Set<String> = []

  private let center: any NotificationCenterAdapter
  private let readAgents: AgentRead
  private let now: @MainActor () -> Date
  private var generation = 0
  /// The ids the latest read listed as pending.
  private var latestPending: Set<String> = []
  /// Display names by session id for this account, "Ended agent" for a
  /// session the live read did not list.
  private var names: [String: String] = [:]
  private var queued: (decisions: [Decision], agents: [AgentSession])?
  private var task: Task<Void, Never>?

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "notifications")

  public init(
    center: any NotificationCenterAdapter, settings: NotificationSettings, store: NotifiedStore,
    readAgents: @escaping AgentRead, now: @escaping @MainActor () -> Date = { Date() }
  ) {
    self.center = center
    self.settings = settings
    self.store = store
    self.readAgents = readAgents
    self.now = now
  }

  /// Asks for permission after sign-in and when the app starts signed in.
  /// Denial leaves sync, the menu bar item, and the list unaffected.
  public func requestAuthorization() {
    let generation = self.generation
    Task {
      let granted = await center.requestAuthorization()
      guard generation == self.generation else { return }
      Self.log.notice("Notification authorization granted: \(granted, privacy: .public)")
    }
  }

  /// A complete successful decisions read listed `decisions` as pending.
  /// `agents` are the snapshot's live sessions, read while the popover was
  /// last open.
  public func didRead(pending decisions: [Decision], agents: [AgentSession]) {
    latestPending = Set(decisions.map(\.id))
    store.prune(toPending: latestPending)
    queued = (decisions, agents)
    guard task == nil else { return }
    task = Task { await drain() }
  }

  /// Adds the decisions an open popover listed, so closing it posts nothing
  /// for a row the user saw.
  public func markListed(_ ids: some Sequence<String>) {
    store.mark(ids)
  }

  /// Clears the store, every delivered notification, and work in flight.
  /// Sign-out and a 401 call it.
  public func reset() {
    generation += 1
    posting = []
    queued = nil
    latestPending = []
    names = [:]
    store.clear()
    center.removeAllDelivered()
  }

  /// Clears this Mac's notifications on every sign-out (component-mac-app
  /// §Sign-in).
  public func resetOnSignOut(of account: Account) {
    account.addCleanup { [weak self] in self?.reset() }
  }

  /// Waits until every queued read is handled. Tests use it.
  public func settle() async {
    while let task {
      await task.value
    }
  }

  // MARK: Reads

  private func drain() async {
    while let next = queued {
      queued = nil
      await handle(next.decisions, agents: next.agents, generation: generation)
    }
    task = nil
  }

  private func handle(_ decisions: [Decision], agents: [AgentSession], generation: Int) async {
    let delivered = Set(await center.deliveredIdentifiers())
    guard generation == self.generation else { return }
    let time = now()
    let plan = NotificationPlanner.plan(
      pending: decisions,
      context: NotificationPlanner.Context(
        now: time, isPopoverOpen: isPopoverOpen, allowsPosting: settings.allowsPosting(now: time),
        notified: store.ids, posting: posting, delivered: delivered))
    // Removal follows the read alone, so it runs while paused, off, or open
    // (AC-6.5).
    if !plan.remove.isEmpty { center.removeDelivered(plan.remove) }
    store.mark(plan.markNotified)
    guard !plan.post.isEmpty else { return }

    posting.formUnion(plan.post.map(\.id))
    defer {
      if generation == self.generation { posting.subtract(plan.post.map(\.id)) }
    }
    guard await center.authorization() == .authorized, generation == self.generation else { return }
    for session in agents { names[session.id] = session.displayName }
    let lookupFailed = await lookUpNames(for: plan.post, generation: generation)
    guard generation == self.generation else { return }

    for decision in plan.post {
      guard let name = agentName(for: decision, lookupFailed: lookupFailed) else { continue }
      guard mayPost(decision.id, generation: generation) else { continue }
      let request = NotificationRequest(decision: decision, agentName: name, now: now())
      do {
        try await center.add(request)
      } catch {
        // Not marked notified, so a later read tries again.
        Self.log.error("Couldn't post a notification: \(String(describing: error), privacy: .public)")
        continue
      }
      guard generation == self.generation else {
        // The account changed while the post was in flight.
        center.removeDelivered([decision.id])
        return
      }
      store.mark([decision.id])
      if !latestPending.contains(decision.id) {
        // Settled while the post was in flight.
        center.removeDelivered([decision.id])
      }
    }
  }

  /// Reads the live sessions once when a decision to post names a session
  /// the app has no name for. Closed-popover sync reads no agents, so this
  /// is the only agent read while the popover is closed. Returns true when
  /// the read failed.
  private func lookUpNames(for decisions: [Decision], generation: Int) async -> Bool {
    let missing = Set(decisions.compactMap(\.agentSessionID).filter { names[$0] == nil })
    guard !missing.isEmpty else { return false }
    do throws(APIError) {
      let live = try await readAgents()
      guard generation == self.generation else { return false }
      for session in live { names[session.id] = session.displayName }
      for id in missing where names[id] == nil { names[id] = DecisionPresentation.endedAgent }
      return false
    } catch {
      Self.log.error("Couldn't read agent names: \(String(describing: error), privacy: .public)")
      return true
    }
  }

  /// The agent's display name, "Ended agent" for a session that is not
  /// live, or nil when a failed read leaves it unknown, so a live agent is
  /// never shown as ended.
  private func agentName(for decision: Decision, lookupFailed: Bool) -> String? {
    guard let id = decision.agentSessionID else { return DecisionPresentation.endedAgent }
    if let name = names[id] { return name }
    return lookupFailed ? nil : DecisionPresentation.endedAgent
  }

  /// Rechecks what may have changed while the app waited: the account, the
  /// popover, the settings, and whether the decision is still pending.
  private func mayPost(_ id: String, generation: Int) -> Bool {
    generation == self.generation && !isPopoverOpen && settings.allowsPosting(now: now())
      && latestPending.contains(id) && !store.contains(id)
  }
}
