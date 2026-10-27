import Foundation
import OSLog

/// The two reads `Sync` makes. `APIClient` provides them.
public protocol SyncReader: Sendable {
  func pendingDecisions() async throws(APIError) -> [Decision]
  func liveAgentSessions() async throws(APIError) -> [AgentSession]
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

  private let reader: any SyncReader
  private let clock: any SyncClock
  private let now: @Sendable () -> Date
  private let publish: Publish
  private let run = RunState()

  private var snapshot = Snapshot.empty
  private var isOpen = false
  private var failures = 0
  private var timer: Task<Void, Never>?
  private var read: (id: Int, task: Task<Void, Never>)?
  private var nextReadID = 0
  /// The generation the timer and read belong to.
  private var tasksGeneration = 0

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "sync")

  public init(
    reader: any SyncReader,
    clock: any SyncClock = SystemSignInClock(),
    now: @escaping @Sendable () -> Date = { Date() },
    publish: @escaping Publish
  ) {
    self.reader = reader
    self.clock = clock
    self.now = now
    self.publish = publish
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
    Task { await self.cancelStaleTasks() }
  }

  /// The popover opened or closed. Opening reads at once and switches to the
  /// 5-second cadence; closing switches to 15 seconds.
  public func setOpen(_ open: Bool) {
    guard open != isOpen else { return }
    isOpen = open
    guard let generation = run.current else { return }
    schedule(generation, immediate: open)
  }

  /// The Mac woke or the network path became satisfied: read at once.
  public func readNow() {
    guard let generation = run.current else { return }
    schedule(generation, immediate: true)
  }

  /// The wait before the next timer tick.
  public var nextDelay: TimeInterval {
    if failures > 0 { return Self.backoff[min(failures, Self.backoff.count) - 1] }
    return isOpen ? Self.openInterval : Self.closedInterval
  }

  public var isRunning: Bool { run.current != nil }

  // MARK: Scheduling

  private func launch(_ generation: Int) {
    guard run.isCurrent(generation) else { return }
    cancelTasks()
    snapshot = .empty
    failures = 0
    schedule(generation, immediate: true)
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
  }

  /// Replaces the timer, so a trigger never leaves two timers running.
  private func schedule(_ generation: Int, immediate: Bool) {
    timer?.cancel()
    tasksGeneration = generation
    timer = Task { await self.loop(generation, immediate: immediate) }
  }

  private func loop(_ generation: Int, immediate: Bool) async {
    if immediate {
      // A trigger that finds a read in flight waits for it and reads again,
      // so opening the popover always reads the agents.
      while let current = read {
        await current.task.value
        finish(current.id)
      }
      guard !Task.isCancelled, run.isCurrent(generation) else { return }
      await tick(generation)
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
      await tick(generation)
    }
  }

  /// Runs one read in its own task, so replacing the timer never cancels a
  /// request in flight.
  private func tick(_ generation: Int) async {
    nextReadID += 1
    let id = nextReadID
    let task = Task { await self.performRead(generation) }
    read = (id, task)
    await task.value
    finish(id)
  }

  private func finish(_ id: Int) {
    if read?.id == id { read = nil }
  }

  // MARK: Reads

  private func performRead(_ generation: Int) async {
    let includeAgents = isOpen
    let reader = self.reader
    async let decisions = Self.capture { () async throws(APIError) in try await reader.pendingDecisions() }
    async let agents: Result<[AgentSession], APIError>? =
      includeAgents
      ? Self.capture { () async throws(APIError) in try await reader.liveAgentSessions() } : nil
    let (decisionsResult, agentsResult) = await (decisions, agents)

    guard run.isCurrent(generation), !Task.isCancelled else { return }

    var failure: APIError?
    var changed = false
    switch decisionsResult {
    case .success(let items):
      // Only a complete read of every page replaces the list.
      snapshot.decisions = items
      snapshot.fetchedAt = now()
      changed = true
    case .failure(let error):
      failure = error
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

    if let failure {
      if failure.isUnauthenticated || failure == .signedOut {
        // The API client has signed the account out (AC-2.6).
        Self.log.notice("Sync stopped: the account is signed out")
        run.end(ifCurrent: generation)
        cancelTimer()
        return
      }
      failures += 1
      Self.log.error("A sync read failed; next in \(self.nextDelay, privacy: .public) s")
    } else {
      failures = 0
    }

    guard changed else { return }
    let published = snapshot
    let run = self.run
    let publish = self.publish
    await MainActor.run {
      // Checked on the main actor, where sign-out runs, so a result that
      // lands after sign-out is dropped.
      guard run.isCurrent(generation) else { return }
      publish(published)
    }
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
