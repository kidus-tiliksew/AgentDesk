import Foundation
import OSLog

/// The reads `Sync` makes. `APIClient` provides them.
public protocol SyncReader: Sendable {
  func pendingDecisions() async throws(APIError) -> [Decision]
  func liveAgentSessions() async throws(APIError) -> [AgentSession]
  func agentSession(id: String) async throws(APIError) -> AgentSession
  func agentSessionHistory(id: String) async throws(APIError) -> [StatusHistoryEntry]
}

extension APIClient: SyncReader {}

/// The wait between reads, injected so tests run on virtual time.
public protocol SyncClock: Sendable {
  func sleep(seconds: TimeInterval) async throws
}

extension SystemSignInClock: SyncClock {}

/// Polls the pending decisions and live agents and publishes the last good
/// snapshot to the main actor (component-mac-app §Sync; DEC-19(4);
/// req-mac-app AC-3.6, AC-4.10).
///
/// | Condition | Decisions | Agents |
/// | --- | --- | --- |
/// | popover open | every 5 s | every 5 s |
/// | popover closed | every 15 s | not read |
/// | popover opens, Mac wakes, network returns | at once | at once when open |
/// | after a failed read | 30, 60, 120, then 300 s | same |
/// | 401 | stops | stops |
///
/// Each run has a generation. `stop()` ends it synchronously, so a read
/// still in flight when the account signs out publishes nothing, and a later
/// sign-in starts from an empty snapshot.
///
/// While the detail panel shows an agent session and the popover is open, each
/// read also fetches that session and its history, on the same timer and under
/// the same backoff, and no history is read otherwise (req-mac-app AC-11.3,
/// AC-11.10; DEC-23(4)). The target has its own generation, so a result for a
/// closed, replaced, or reopened target changes nothing. Panel data never moves
/// `fetchedAt`.
public actor Sync {
  public static let openInterval: TimeInterval = 5
  public static let closedInterval: TimeInterval = 15
  public static let backoff: [TimeInterval] = [30, 60, 120, 300]

  public struct Snapshot: Equatable, Sendable {
    public var decisions: [Decision]
    public var agents: [AgentSession]
    /// When the decisions were last read successfully; nil before the first
    /// success of a run.
    public var fetchedAt: Date?

    public static let empty = Snapshot(decisions: [], agents: [], fetchedAt: nil)

    public init(decisions: [Decision], agents: [AgentSession], fetchedAt: Date?) {
      self.decisions = decisions
      self.agents = agents
      self.fetchedAt = fetchedAt
    }
  }

  public typealias Publish = @MainActor @Sendable (Snapshot) -> Void
  public typealias AgentDetailPublish = @MainActor @Sendable (AgentDetailUpdate) -> Void

  /// How much one read fetches. A retry reads only the panel's target.
  private enum ReadScope {
    case target
    case full
  }

  private let reader: any SyncReader
  private let clock: any SyncClock
  private let now: @Sendable () -> Date
  private let publish: Publish
  private let publishAgentDetail: AgentDetailPublish
  private let run = RunState()
  private let targets = AgentTargetState()

  private var snapshot = Snapshot.empty
  private var isOpen = false
  private var failures = 0
  /// The running backoff comes only from the panel's target, with the lists
  /// answering, so it ends when the target does.
  private var backoffIsTargets = false
  private var timer: Task<Void, Never>?
  private var read: (id: Int, task: Task<Void, Never>)?
  private var nextReadID = 0
  /// The immediate read a trigger asked for, until it starts. A later trigger
  /// widens it and never narrows it, so a retry cannot drop an opening's read.
  private var queued: ReadScope?
  /// The generation the timer and read belong to.
  private var tasksGeneration = 0

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "sync")

  public init(
    reader: any SyncReader,
    clock: any SyncClock = SystemSignInClock(),
    now: @escaping @Sendable () -> Date = { Date() },
    publish: @escaping Publish,
    publishAgentDetail: @escaping AgentDetailPublish = { _ in }
  ) {
    self.reader = reader
    self.clock = clock
    self.now = now
    self.publish = publish
    self.publishAgentDetail = publishAgentDetail
  }

  // MARK: Lifecycle

  /// Starts a run with an immediate read. A running run is replaced.
  public nonisolated func start() {
    let generation = run.begin()
    Task { await self.launch(generation) }
  }

  /// Ends the run at once: no read starts and no result publishes after this
  /// returns. Sign-out and a 401 call it (req-mac-app AC-2.6).
  public nonisolated func stop() {
    run.end()
    targets.clear()
    Task { await self.cancelStaleTasks() }
  }

  /// The popover opened or closed. Opening reads at once and switches to the
  /// 5-second cadence; closing switches to 15 seconds.
  public func setOpen(_ open: Bool) {
    guard open != isOpen else { return }
    isOpen = open
    guard let generation = run.current else { return }
    schedule(generation, open ? .full : nil)
  }

  /// The Mac woke or the network path became satisfied: read at once.
  public func readNow() {
    guard let generation = run.current else { return }
    schedule(generation, .full)
  }

  /// The wait before the next timer tick.
  public var nextDelay: TimeInterval {
    if failures > 0 { return Self.backoff[min(failures, Self.backoff.count) - 1] }
    return isOpen ? Self.openInterval : Self.closedInterval
  }

  public var isRunning: Bool { run.current != nil }

  // MARK: The panel's agent session

  /// The panel shows this session: from now on results for any earlier target
  /// change nothing, and a read of the lists, the session, and its history
  /// starts at once.
  public nonisolated func showAgent(id: String) -> AgentDetailTarget {
    let target = targets.show(id: id)
    Task { await self.trigger(.full) }
    return target
  }

  /// The panel no longer shows a session: its history is not read again, and a
  /// read in flight changes nothing.
  public nonisolated func hideAgent() {
    targets.clear()
    Task { await self.targetEnded() }
  }

  /// Try Again: reads only the shown session and its history.
  public nonisolated func retryAgent() {
    Task { await self.trigger(.target) }
  }

  /// A backoff that only the panel's target caused ends with it, so a failing
  /// history read does not hold the lists back after the panel closes. A
  /// backoff the lists caused stays.
  private func targetEnded() {
    guard failures > 0, backoffIsTargets, targets.readable == nil else { return }
    failures = 0
    backoffIsTargets = false
    guard let generation = run.current else { return }
    schedule(generation, queued)
  }

  private func trigger(_ scope: ReadScope) {
    guard let generation = run.current else { return }
    schedule(generation, scope)
  }

  // MARK: Scheduling

  private func launch(_ generation: Int) {
    guard run.isCurrent(generation) else { return }
    cancelTasks()
    snapshot = .empty
    failures = 0
    schedule(generation, .full)
  }

  private func cancelStaleTasks() {
    guard !run.isCurrent(tasksGeneration) else { return }
    cancelTasks()
  }

  private func cancelTasks() {
    timer?.cancel()
    timer = nil
    read?.task.cancel()
    read = nil
    queued = nil
  }

  /// Replaces the timer, so a trigger never leaves two timers running. `nil`
  /// asks for no immediate read and drops one that has not started.
  private func schedule(_ generation: Int, _ trigger: ReadScope?) {
    timer?.cancel()
    tasksGeneration = generation
    switch trigger {
    case nil: queued = nil
    case .full: queued = .full
    case .target: queued = queued ?? .target
    }
    timer = Task { await self.loop(generation) }
  }

  private func loop(_ generation: Int) async {
    if queued != nil {
      // A trigger that finds a read in flight waits for it and reads again,
      // so opening the popover always reads the agents.
      while let current = read {
        await current.task.value
        finish(current.id)
      }
      guard !Task.isCancelled, run.isCurrent(generation), let scope = queued else { return }
      queued = nil
      await tick(generation, scope)
    }
    while !Task.isCancelled, run.isCurrent(generation) {
      do {
        try await clock.sleep(seconds: nextDelay)
      } catch {
        return
      }
      guard !Task.isCancelled, run.isCurrent(generation) else { return }
      // Reads never overlap: a tick that finds a read in flight is skipped.
      guard read == nil else { continue }
      await tick(generation, .full)
    }
  }

  /// Runs one read in its own task, so replacing the timer never cancels a
  /// request in flight.
  private func tick(_ generation: Int, _ scope: ReadScope) async {
    nextReadID += 1
    let id = nextReadID
    let task = Task { await self.performRead(generation, scope) }
    read = (id, task)
    await task.value
    finish(id)
  }

  private func finish(_ id: Int) {
    if read?.id == id { read = nil }
  }

  // MARK: Reads

  private func performRead(_ generation: Int, _ scope: ReadScope) async {
    let readsLists = scope == .full
    let includeAgents = readsLists && isOpen
    let target = isOpen ? targets.readable : nil
    guard readsLists || target != nil else { return }
    let reader = self.reader
    let targetID = target?.id ?? ""
    let readsTarget = target != nil
    async let decisions: Result<[Decision], APIError>? =
      readsLists
      ? Self.capture { () async throws(APIError) in try await reader.pendingDecisions() } : nil
    async let agents: Result<[AgentSession], APIError>? =
      includeAgents
      ? Self.capture { () async throws(APIError) in try await reader.liveAgentSessions() } : nil
    async let session: Result<AgentSession, APIError>? =
      readsTarget
      ? Self.capture { () async throws(APIError) in try await reader.agentSession(id: targetID) } : nil
    async let history: Result<[StatusHistoryEntry], APIError>? =
      readsTarget
      ? Self.capture { () async throws(APIError) in try await reader.agentSessionHistory(id: targetID) }
      : nil
    let (decisionsResult, agentsResult, sessionResult, historyResult) = await (
      decisions, agents, session, history
    )

    guard run.isCurrent(generation), !Task.isCancelled else { return }

    var failure: APIError?
    var changed = false
    switch decisionsResult {
    case .success(let items)?:
      // Only a complete read of every page replaces the list.
      snapshot.decisions = items
      snapshot.fetchedAt = now()
      changed = true
    case .failure(let error)?:
      failure = error
    case nil:
      break
    }
    switch agentsResult {
    case .success(let items)?:
      snapshot.agents = items
      changed = true
    case .failure(let error)?:
      failure = failure ?? error
    case nil:
      break
    }

    let listsFailed = failure != nil
    var detail: AgentDetailOutcome?
    if let target, let sessionResult, let historyResult, targets.isCurrent(target) {
      switch Self.outcome(session: sessionResult, history: historyResult) {
      case .detail(let outcome):
        detail = outcome
        if outcome == .gone { targets.stopReading(target) }
      case .transient(let error):
        detail = .failed
        failure = failure ?? error
      case .signedOut(let error):
        failure = error
      }
    }

    if let failure {
      if failure.isUnauthenticated || failure == .signedOut {
        // The API client has signed the account out (AC-2.6).
        Self.log.notice("Sync stopped: the account is signed out")
        run.end(ifCurrent: generation)
        cancelTimer()
        return
      }
      backoffIsTargets = readsLists ? !listsFailed : (backoffIsTargets || failures == 0)
      failures += 1
      Self.log.error("A sync read failed; next in \(self.nextDelay, privacy: .public) s")
    } else {
      failures = 0
    }

    guard changed || detail != nil else { return }
    let published = snapshot
    let run = self.run
    let targets = self.targets
    let publish = self.publish
    let publishAgentDetail = self.publishAgentDetail
    await MainActor.run {
      // Checked on the main actor, where sign-out and the panel's target
      // changes run, so a result that lands after either is dropped.
      guard run.isCurrent(generation) else { return }
      if changed { publish(published) }
      if let detail, let target, targets.isCurrent(target) {
        publishAgentDetail(AgentDetailUpdate(target: target, outcome: detail))
      }
    }
  }

  private enum TargetRead {
    case detail(AgentDetailOutcome)
    case transient(APIError)
    case signedOut(APIError)
  }

  /// Classifies the pair by endpoint (component-mac-app §Detail panel;
  /// req-mac-app AC-11.12). A sign-out from either request comes first. Only a
  /// contract `not_found` from the session request says the session is gone.
  /// With the session found, the same answer from the history request says this
  /// server has no history, which is no failed read. Every other failure of
  /// either request is transient (component-mac-app §API client).
  private static func outcome(
    session: Result<AgentSession, APIError>, history: Result<[StatusHistoryEntry], APIError>
  ) -> TargetRead {
    for case .failure(let error) in [session.map { _ in () }, history.map { _ in () }]
    where error.isUnauthenticated || error == .signedOut {
      return .signedOut(error)
    }
    switch (session, history) {
    case (.failure(let error), _):
      return isNotFound(error) ? .detail(.gone) : .transient(error)
    case (.success(let session), .success(let history)):
      return .detail(.loaded(session, .available(history)))
    case (.success(let session), .failure(let error)):
      return isNotFound(error) ? .detail(.loaded(session, .unavailable)) : .transient(error)
    }
  }

  private static func isNotFound(_ error: APIError) -> Bool {
    error.status == 404 && error.code == "not_found"
  }

  private func cancelTimer() {
    timer?.cancel()
    timer = nil
  }

  private static func capture<T: Sendable>(
    _ body: @Sendable () async throws(APIError) -> T
  ) async -> Result<T, APIError> {
    do throws(APIError) {
      return .success(try await body())
    } catch {
      return .failure(error)
    }
  }
}

/// The run's generation, readable from any thread so `stop()` takes effect
/// before it returns.
private final class RunState: @unchecked Sendable {
  private let lock = NSLock()
  private var generation = 0
  private var running = false

  func begin() -> Int {
    lock.withLock {
      generation += 1
      running = true
      return generation
    }
  }

  func end() {
    lock.withLock {
      generation += 1
      running = false
    }
  }

  func end(ifCurrent expected: Int) {
    lock.withLock {
      guard running, generation == expected else { return }
      generation += 1
      running = false
    }
  }

  func isCurrent(_ expected: Int) -> Bool {
    lock.withLock { running && generation == expected }
  }

  var current: Int? {
    lock.withLock { running ? generation : nil }
  }
}

/// The panel's agent session, readable from any thread so a change takes effect
/// before the main actor moves on. A session found gone stays the target, so
/// its result still lands, and is no longer read.
private final class AgentTargetState: @unchecked Sendable {
  private let lock = NSLock()
  private var generation = 0
  private var target: AgentDetailTarget?
  private var isStopped = false

  func show(id: String) -> AgentDetailTarget {
    lock.withLock {
      generation += 1
      let shown = AgentDetailTarget(id: id, generation: generation)
      target = shown
      isStopped = false
      return shown
    }
  }

  func clear() {
    lock.withLock {
      generation += 1
      target = nil
      isStopped = false
    }
  }

  func stopReading(_ expected: AgentDetailTarget) {
    lock.withLock {
      if target == expected { isStopped = true }
    }
  }

  func isCurrent(_ expected: AgentDetailTarget) -> Bool {
    lock.withLock { target == expected }
  }

  /// The target while its reads continue.
  var readable: AgentDetailTarget? {
    lock.withLock { isStopped ? nil : target }
  }
}
