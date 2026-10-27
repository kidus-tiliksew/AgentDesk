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

/// Virtual time: `sleep` advances the clock at once and records its length.
final class VirtualClock: SignInClock, @unchecked Sendable {
  private let lock = NSLock()
  private var time: TimeInterval = 0
  private var slept: [TimeInterval] = []

  func now() -> TimeInterval { lock.withLock { time } }

  var sleeps: [TimeInterval] { lock.withLock { slept } }

  func sleep(seconds: TimeInterval) async throws {
    try Task.checkCancellation()
    lock.withLock {
      time += seconds
      slept.append(seconds)
    }
    await Task.yield()
    try Task.checkCancellation()
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
