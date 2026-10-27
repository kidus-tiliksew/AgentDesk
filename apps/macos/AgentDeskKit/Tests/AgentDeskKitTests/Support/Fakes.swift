import Foundation

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
