import Foundation
import XCTest

@testable import AgentDeskKit

/// A `CredentialStore` in memory, so tests never touch the login Keychain.
final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: String] = [:]
  private var saveFailure: CredentialStoreError?
  private var deleteFailure: CredentialStoreError?

  init(_ items: [String: String] = [:]) {
    self.items = items
  }

  var stored: [String: String] { lock.withLock { items } }

  func failSaves(_ status: OSStatus) { lock.withLock { saveFailure = CredentialStoreError(status: status) } }
  func failDeletes(_ status: OSStatus) {
    lock.withLock { deleteFailure = CredentialStoreError(status: status) }
  }

  func token(account: String) throws(CredentialStoreError) -> String? {
    lock.withLock { items[account] }
  }

  func save(_ token: String, account: String) throws(CredentialStoreError) {
    let failure: CredentialStoreError? = lock.withLock {
      if let saveFailure { return saveFailure }
      items[account] = token
      return nil
    }
    if let failure { throw failure }
  }

  func delete(account: String) throws(CredentialStoreError) {
    let failure: CredentialStoreError? = lock.withLock {
      if let deleteFailure { return deleteFailure }
      items[account] = nil
      return nil
    }
    if let failure { throw failure }
  }
}

/// Virtual time. A wait between polls advances the clock at once and records
/// its length. A wait for a deadline never advances the clock: it resumes
/// when a poll wait or `advance(to:)` reaches the deadline, so time stands
/// still while a request is in flight unless the test moves it.
final class VirtualClock: SignInClock, @unchecked Sendable {
  private struct Watcher {
    let id: Int
    let deadline: TimeInterval
    let continuation: CheckedContinuation<Void, Error>
  }

  private let lock = NSLock()
  private var time: TimeInterval = 0
  private var slept: [TimeInterval] = []
  private var watchers: [Watcher] = []
  private var cancelled: Set<Int> = []
  private var nextID = 0

  func now() -> TimeInterval { lock.withLock { time } }

  var sleeps: [TimeInterval] { lock.withLock { slept } }

  /// The number of deadline waits now suspended.
  var pendingDeadlines: Int { lock.withLock { watchers.count } }

  func sleep(seconds: TimeInterval) async throws {
    try Task.checkCancellation()
    lock.withLock { slept.append(seconds) }
    advance(to: now() + seconds)
    await Task.yield()
    try Task.checkCancellation()
  }

  func sleep(until deadline: TimeInterval) async throws {
    let id = lock.withLock {
      nextID += 1
      return nextID
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let outcome: Result<Void, Error>? = lock.withLock {
          if cancelled.remove(id) != nil { return .failure(CancellationError()) }
          if time >= deadline { return .success(()) }
          watchers.append(Watcher(id: id, deadline: deadline, continuation: continuation))
          return nil
        }
        if let outcome { continuation.resume(with: outcome) }
      }
    } onCancel: {
      let watcher: Watcher? = lock.withLock {
        guard let index = watchers.firstIndex(where: { $0.id == id }) else {
          cancelled.insert(id)
          return nil
        }
        return watchers.remove(at: index)
      }
      watcher?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Moves the clock forward and resumes every deadline it reaches.
  func advance(to target: TimeInterval) {
    let due: [Watcher] = lock.withLock {
      time = max(time, target)
      let due = watchers.filter { $0.deadline <= time }
      watchers.removeAll { $0.deadline <= time }
      return due
    }
    for watcher in due { watcher.continuation.resume() }
  }
}

/// A one-shot signal an async handler can wait on.
actor Gate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}

@MainActor
final class FakeLoginService: LoginItemService {
  var status: LoginItemStatus = .notRegistered
  var failure: Error?
  var registerCalls = 0
  var unregisterCalls = 0

  func register() throws {
    registerCalls += 1
    if let failure { throw failure }
    status = .enabled
  }

  func unregister() throws {
    unregisterCalls += 1
    if let failure { throw failure }
    status = .notRegistered
  }
}

/// A user defaults suite that each test owns and removes.
func makeDefaults() -> UserDefaults {
  let name = "agentdesk-tests-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: name)!
  defaults.removePersistentDomain(forName: name)
  return defaults
}

/// Virtual time for `Sync`. A sleep suspends until `advance(by:)` reaches
/// its end, so a test controls every timer tick.
final class ManualClock: SyncClock, @unchecked Sendable {
  private struct Sleeper {
    let id: Int
    let wakeAt: TimeInterval
    let continuation: CheckedContinuation<Void, Error>
  }

  private let lock = NSLock()
  private var time: TimeInterval = 0
  private var sleepers: [Sleeper] = []
  private var cancelled: Set<Int> = []
  private var requested: [TimeInterval] = []
  private var nextID = 0

  var now: TimeInterval { lock.withLock { time } }

  /// Every sleep length asked for, in order.
  var requests: [TimeInterval] { lock.withLock { requested } }

  var sleeping: Int { lock.withLock { sleepers.count } }

  func sleep(seconds: TimeInterval) async throws {
    let id = lock.withLock {
      nextID += 1
      requested.append(seconds)
      return nextID
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let cancelledEarly = lock.withLock {
          if cancelled.remove(id) != nil { return true }
          sleepers.append(Sleeper(id: id, wakeAt: time + seconds, continuation: continuation))
          return false
        }
        if cancelledEarly { continuation.resume(throwing: CancellationError()) }
      }
    } onCancel: {
      let sleeper: Sleeper? = lock.withLock {
        guard let index = sleepers.firstIndex(where: { $0.id == id }) else {
          cancelled.insert(id)
          return nil
        }
        return sleepers.remove(at: index)
      }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  func advance(by seconds: TimeInterval) {
    let due: [Sleeper] = lock.withLock {
      time += seconds
      let due = sleepers.filter { $0.wakeAt <= time }
      sleepers.removeAll { $0.wakeAt <= time }
      return due
    }
    for sleeper in due { sleeper.continuation.resume() }
  }
}

/// A `SyncReader` that answers from scripts and can hold a read in flight.
final class FakeReader: SyncReader, @unchecked Sendable {
  private let lock = NSLock()
  private var decisionScript: [Result<[Decision], APIError>] = []
  private var agentScript: [Result<[AgentSession], APIError>] = []
  private var defaultDecisions: Result<[Decision], APIError> = .success([])
  private var defaultAgents: Result<[AgentSession], APIError> = .success([])
  private var holds: [Gate] = []
  private var decisionReads = 0
  private var agentReads = 0
  private var inFlight = 0
  private var peak = 0

  var decisionCalls: Int { lock.withLock { decisionReads } }
  var agentCalls: Int { lock.withLock { agentReads } }
  /// The most decision reads ever in flight at once.
  var peakConcurrency: Int { lock.withLock { peak } }

  /// Answers the next decision reads in order, then `always`.
  func answerDecisions(_ results: Result<[Decision], APIError>...) {
    lock.withLock { decisionScript += results }
  }

  func answerAgents(_ results: Result<[AgentSession], APIError>...) {
    lock.withLock { agentScript += results }
  }

  func alwaysAnswerDecisions(_ result: Result<[Decision], APIError>) {
    lock.withLock { defaultDecisions = result }
  }

  func alwaysAnswerAgents(_ result: Result<[AgentSession], APIError>) {
    lock.withLock { defaultAgents = result }
  }

  /// Holds the next decision read until the returned gate opens.
  func holdNextRead() -> Gate {
    let gate = Gate()
    lock.withLock { holds.append(gate) }
    return gate
  }

  func pendingDecisions() async throws(APIError) -> [Decision] {
    let (result, hold): (Result<[Decision], APIError>, Gate?) = lock.withLock {
      decisionReads += 1
      inFlight += 1
      peak = max(peak, inFlight)
      let result = decisionScript.isEmpty ? defaultDecisions : decisionScript.removeFirst()
      return (result, holds.isEmpty ? nil : holds.removeFirst())
    }
    if let hold { await hold.wait() }
    lock.withLock { inFlight -= 1 }
    return try result.get()
  }

  func liveAgentSessions() async throws(APIError) -> [AgentSession] {
    let result = lock.withLock {
      agentReads += 1
      return agentScript.isEmpty ? defaultAgents : agentScript.removeFirst()
    }
    return try result.get()
  }
}

/// Waits up to two seconds of real time for `condition`, polling every
/// millisecond.
@MainActor
func eventually(
  _ message: @autoclosure () -> String = "condition", file: StaticString = #filePath,
  line: UInt = #line, _ condition: () async -> Bool
) async {
  for _ in 0..<2000 {
    if await condition() { return }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  XCTFail("Timed out waiting for \(message())", file: file, line: line)
}
