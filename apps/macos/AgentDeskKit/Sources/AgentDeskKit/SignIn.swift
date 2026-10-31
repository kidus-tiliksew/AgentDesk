import Foundation
import OSLog

/// Monotonic time and sleep for sign-in polling, injected so tests run on
/// virtual time.
public protocol SignInClock: Sendable {
  /// Seconds on a clock that never jumps.
  func now() -> TimeInterval
  /// Waits between polls.
  func sleep(seconds: TimeInterval) async throws
  /// Waits until `now()` reaches `deadline`; bounds a poll in flight.
  func sleep(until deadline: TimeInterval) async throws
}

public struct SystemSignInClock: SignInClock {
  public init() {}

  public func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  public func sleep(seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }

  public func sleep(until deadline: TimeInterval) async throws {
    try await sleep(seconds: deadline - now())
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
  /// No HTTP answer arrived for the start.
  case unreachable
  /// The server answered the start with a 4xx other than 429.
  case serverRefused(status: Int)
  /// The server answered the start with a 5xx, a 2xx the app cannot read,
  /// or another answer that is not a refusal.
  case serverProblem
  case keychain

  /// The sign-in view's text (component-mac-app §Sign-in).
  public var message: String {
    switch self {
    case .declined: "Sign-in was declined on your phone"
    case .expired: "This code expired"
    case .rateLimited: "Too many sign-in attempts. Try again in a minute."
    case .unreachable: "Couldn't reach AgentDesk. Check your connection and try again."
    case .serverRefused(let status):
      "The server refused sign-in (HTTP \(status)). Update AgentDesk or check the server setting."
    case .serverProblem: "The server had a problem starting sign-in. Try again later."
    case .keychain: "Couldn't save the sign-in to the Keychain."
    }
  }

  /// Declined and expired codes offer a New code button (req-mac-app AC-2.4).
  public var offersNewCode: Bool { self == .declined || self == .expired }

  /// What a failed `POST /device/start` shows (component-mac-app §Sign-in).
  /// Only a start with no HTTP answer is unreachable, so a server that
  /// answered never sends the user to check their connection.
  public static func start(_ error: APIError) -> SignInFailure {
    if case .transport = error { return .unreachable }
    switch error.httpStatus {
    case 429?: return .rateLimited
    case let status? where (400..<500).contains(status): return .serverRefused(status: status)
    default: return .serverProblem
    }
  }
}

/// The text of the error-level log line for a failed sign-in start
/// (component-mac-app §Sign-in). It names the HTTP status with the contract
/// error's code and field, or the cause when no answer arrived. It never
/// holds a body, the contract message, a URL, the device secret, or a token.
enum SignInStartDiagnostic {
  static func describe(_ error: APIError) -> String {
    switch error {
    case .response(let status, let code, _, let field):
      var text = "HTTP \(status), code \(identifier(code))"
      if let field { text += ", field \(identifier(field))" }
      return text
    case .http(let status):
      return "HTTP \(status), no contract error body"
    case .unreadable(let status):
      return "HTTP \(status), the answer could not be decoded"
    case .transport(let cause):
      return "no HTTP answer: \(sentence(cause))"
    case .request(let cause):
      return "request not sent: \(sentence(cause))"
    case .signedOut:
      return "request not sent: no credential"
    }
  }

  private static let identifierCharacters = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")

  /// A server-supplied code or field, kept only when it is a short
  /// identifier.
  static func identifier(_ value: String) -> String {
    guard !value.isEmpty, value.count <= 64,
      value.unicodeScalars.allSatisfy(identifierCharacters.contains)
    else { return "(unrecognized)" }
    return value
  }

  /// A cause with every word that holds a URL scheme or an `@` replaced and
  /// control characters removed, bounded to 160 characters.
  static func sentence(_ value: String) -> String {
    let words = value.split(whereSeparator: \.isWhitespace).map { word -> String in
      word.contains("://") || word.contains("@") ? "(redacted)" : String(word)
    }
    let joined = words.joined(separator: " ").unicodeScalars
      .filter { !CharacterSet.controlCharacters.contains($0) }
    let text = String(String.UnicodeScalarView(joined))
    return text.count > 160 ? String(text.prefix(160)) + "…" : text
  }
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

  private enum PollOutcome: Sendable {
    case answered(DevicePoll)
    case failed(APIError)
    case deadline
  }

  /// One poll, raced against the code's deadline. The loser is cancelled.
  private func poll(deviceSecret: String, before deadline: TimeInterval) async -> PollOutcome {
    let api = self.api
    let clock = self.clock
    return await withTaskGroup(of: PollOutcome.self) { group in
      group.addTask {
        do throws(APIError) {
          return .answered(try await api.pollSignIn(deviceSecret: deviceSecret))
        } catch {
          return .failed(error)
        }
      }
      group.addTask {
        try? await clock.sleep(until: deadline)
        return .deadline
      }
      let first = await group.next() ?? .deadline
      group.cancelAll()
      return first
    }
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
      Self.log.error(
        "Sign-in start failed: \(SignInStartDiagnostic.describe(error), privacy: .public)")
      phase = .failed(.start(error))
      return
    }
    guard isCurrent(id) else { return }

    // Polling stops `expires_in` seconds after the start. The deadline also
    // bounds the last wait and any poll still in flight, so the code shows
    // as expired on time.
    let deadline = clock.now() + TimeInterval(started.expiresIn)
    let interval = TimeInterval(max(1, started.interval))
    phase = .waiting(code: started.displayCode, machineName: machineName)

    while true {
      let remaining = deadline - clock.now()
      guard remaining > 0 else {
        phase = .failed(.expired)
        return
      }
      do {
        try await clock.sleep(seconds: min(interval, remaining))
      } catch {
        return
      }
      guard isCurrent(id) else { return }
      guard clock.now() < deadline else {
        phase = .failed(.expired)
        return
      }

      let outcome = await poll(deviceSecret: started.deviceSecret, before: deadline)
      guard isCurrent(id) else { return }
      // An answer at or after the deadline is discarded with the attempt, so
      // a late approval never stores a token.
      guard clock.now() < deadline else {
        phase = .failed(.expired)
        return
      }

      let result: DevicePoll
      switch outcome {
      case .answered(let answer):
        result = answer
      case .failed(let error):
        if error.isRateLimited {
          phase = .failed(.rateLimited)
          return
        }
        // A failed poll leaves the code valid, so polling continues until
        // the code expires.
        Self.log.error("A sign-in poll failed")
        continue
      case .deadline:
        phase = .failed(.expired)
        return
      }

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
