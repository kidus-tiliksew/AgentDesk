import Foundation
import OSLog

/// Monotonic time and sleep for sign-in polling, injected so tests run on
/// virtual time.
public protocol SignInClock: Sendable {
  /// Seconds on a clock that never jumps.
  func now() -> TimeInterval
  func sleep(seconds: TimeInterval) async throws
}

public struct SystemSignInClock: SignInClock {
  public init() {}

  public func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  public func sleep(seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }
}

public enum SignInPhase: Equatable, Sendable {
  case idle
  case starting
  /// The code as `XXXX-XXXX` and this Mac's name (req-mac-app AC-2.1).
  case waiting(code: String, machineName: String)
  case failed(SignInFailure)
  case complete
}

public enum SignInFailure: Equatable, Sendable {
  case declined
  case expired
  case rateLimited
  case unreachable
  case keychain

  /// The sign-in view's text (component-mac-app §Sign-in).
  public var message: String {
    switch self {
    case .declined: "Sign-in was declined on your phone"
    case .expired: "This code expired"
    case .rateLimited: "Too many sign-in attempts. Try again in a minute."
    case .unreachable: "Couldn't reach AgentDesk. Check your connection and try again."
    case .keychain: "Couldn't save the sign-in to the Keychain."
    }
  }

  /// Declined and expired codes offer a New code button (req-mac-app AC-2.4).
  public var offersNewCode: Bool { self == .declined || self == .expired }
}

/// Short-code sign-in: start, show the code, and poll until an outcome
/// (component-mac-app §Sign-in; req-mac-app REQ-2).
///
/// Each attempt has an id. Starting again, cancelling, or signing out ends
/// the attempt, and an answer that arrives for an ended attempt changes
/// nothing, so a late approval never restores a credential.
@MainActor
public final class SignInController {
  public private(set) var phase: SignInPhase = .idle {
    didSet { onChange?() }
  }
  /// Runs on the main actor after every change of `phase`.
  public var onChange: (@MainActor () -> Void)?

  private let api: APIClient
  private let clock: SignInClock
  private let machineName: String
  private let onApproved: @MainActor (String) throws -> Void
  private var attempt = 0
  private var task: Task<Void, Never>?

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "sign-in")

  /// `onApproved` persists the token; it runs before `phase` becomes
  /// `.complete`, and a throw fails the attempt.
  public init(
    api: APIClient,
    clock: SignInClock = SystemSignInClock(),
    machineName: String,
    onApproved: @escaping @MainActor (String) throws -> Void
  ) {
    self.api = api
    self.clock = clock
    self.machineName = machineName
    self.onApproved = onApproved
  }

  /// Starts a new attempt, ending any running one.
  public func start() {
    end()
    let id = attempt
    phase = .starting
    task = Task { [weak self] in await self?.run(id) }
  }

  /// Ends the running attempt and returns to `.idle`.
  public func cancel() {
    end()
    phase = .idle
  }

  /// The running attempt; for tests.
  var runningTask: Task<Void, Never>? { task }

  /// Waits for the running attempt; for tests.
  func settle() async {
    await task?.value
  }

  private func end() {
    attempt += 1
    task?.cancel()
    task = nil
  }

  private func isCurrent(_ id: Int) -> Bool {
    id == attempt && !Task.isCancelled
  }

  private func run(_ id: Int) async {
    let started: DeviceStart
    do {
      started = try await api.startSignIn(machineName: machineName)
    } catch {
      guard isCurrent(id) else { return }
      phase = .failed(error.isRateLimited ? .rateLimited : .unreachable)
      return
    }
    guard isCurrent(id) else { return }

    // Polling stops `expires_in` seconds after the start.
    let deadline = clock.now() + TimeInterval(started.expiresIn)
    let interval = TimeInterval(max(1, started.interval))
    phase = .waiting(code: started.displayCode, machineName: machineName)

    while true {
      do {
        try await clock.sleep(seconds: interval)
      } catch {
        return
      }
      guard isCurrent(id) else { return }
      guard clock.now() < deadline else {
        phase = .failed(.expired)
        return
      }

      let result: DevicePoll
      do {
        result = try await api.pollSignIn(deviceSecret: started.deviceSecret)
      } catch {
        guard isCurrent(id) else { return }
        if error.isRateLimited {
          phase = .failed(.rateLimited)
          return
        }
        // A failed poll leaves the code valid, so polling continues until
        // the code expires.
        Self.log.error("A sign-in poll failed")
        continue
      }
      guard isCurrent(id) else { return }

      switch result {
      case .pending:
        continue
      case .approved(let token):
        do {
          try onApproved(token)
        } catch {
          phase = .failed(.keychain)
          return
        }
        phase = .complete
        return
      case .declined:
        phase = .failed(.declined)
        return
      case .expired, .notFound:
        phase = .failed(.expired)
        return
      }
    }
  }
}
