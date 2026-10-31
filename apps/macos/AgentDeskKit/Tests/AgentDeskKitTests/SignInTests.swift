import Foundation
import XCTest

@testable import AgentDeskKit

/// Short-code sign-in on virtual time (component-mac-app §Sign-in,
/// §Verification; req-mac-app REQ-2).
@MainActor
final class SignInTests: XCTestCase {
  nonisolated private static let secret = String(repeating: "s", count: 43)

  nonisolated private static func started(interval: Int = 2, expiresIn: Int = 600) -> StubResponse {
    .json(
      200,
      Fixtures.json([
        "user_code": "ABCD2345", "device_secret": secret, "interval": interval,
        "expires_in": expiresIn,
      ]))
  }

  nonisolated private static func poll(_ status: String) -> StubResponse {
    .json(200, Fixtures.json(["status": status]))
  }

  nonisolated private static let approved = StubResponse.json(
    200,
    Fixtures.json([
      "status": "approved", "api_token": ["credential_id": "cred_1", "token": "adp_approved"],
    ]))

  private struct Harness {
    let server: StubServer
    let store: MemoryCredentialStore
    let account: Account
    let controller: SignInController
    let clock: VirtualClock
  }

  /// A controller whose `/device/start` answers `start` and whose polls answer
  /// `poll` at the virtual time of the request.
  private func harness(
    start: StubResponse = started(),
    store: MemoryCredentialStore = MemoryCredentialStore(),
    clock: VirtualClock = VirtualClock(),
    poll: @escaping @Sendable (_ now: TimeInterval) async throws -> StubResponse
  ) -> Harness {
    let server = StubServer { request in
      request.path == "/device/start" ? start : try await poll(clock.now())
    }
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession(),
      userAgent: "AgentDeskMac/9.9.9")
    let controller = SignInController(
      api: account.api, clock: clock, machineName: "Kidus's MacBook Pro"
    ) { [account] token in try account.signIn(token: token) }
    return Harness(server: server, store: store, account: account, controller: controller, clock: clock)
  }

  private func run(_ harness: Harness) async {
    harness.controller.start()
    await harness.controller.settle()
  }

  // MARK: Start

  func testStartSendsTheMacPayloadWithoutCredential() async throws {
    let h = harness { _ in Self.approved }
    await run(h)
    let start = try XCTUnwrap(h.server.requests.first)
    XCTAssertEqual(start.method, "POST")
    XCTAssertEqual(start.path, "/device/start")
    XCTAssertEqual(
      start.jsonBody as NSDictionary?,
      ["machine_name": "Kidus's MacBook Pro", "client": "macos"] as NSDictionary)
    XCTAssertNil(start.headers["Authorization"])
  }

  func testCodeIsShownAsTwoGroupsOfFour() async {
    let gate = Gate()
    let h = harness { _ in
      await gate.wait()
      return Self.poll("pending")
    }
    var phases: [SignInPhase] = []
    h.controller.onChange = { phases.append(h.controller.phase) }
    h.controller.start()
    while !phases.contains(where: { if case .waiting = $0 { true } else { false } }) {
      await Task.yield()
    }
    XCTAssertEqual(h.controller.phase, .waiting(code: "ABCD-2345", machineName: "Kidus's MacBook Pro"))
    XCTAssertEqual(DeviceStart.display("ABCD2345"), "ABCD-2345")
    h.controller.cancel()
    await gate.open()
  }

  func testStartRateLimitedShowsTheMessage() async {
    let h = harness(start: .error(429, "rate_limited", "Too many sign-in requests")) { _ in
      XCTFail("Polled without a code")
      return Self.poll("pending")
    }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.rateLimited))
    XCTAssertEqual(
      SignInFailure.rateLimited.message, "Too many sign-in attempts. Try again in a minute.")
  }

  /// Runs a start that fails with `start` and checks the failure, its exact
  /// message, the Try Again button, and that nothing was polled or stored.
  private func assertStartFails(
    _ start: StubResponse, as expected: SignInFailure, message: String,
    file: StaticString = #filePath, line: UInt = #line
  ) async {
    await assertStartFails(
      { _ in start }, as: expected, message: message, file: file, line: line)
  }

  private func assertStartFails(
    _ start: @escaping @Sendable (RecordedRequest) async throws -> StubResponse,
    as expected: SignInFailure, message: String,
    file: StaticString = #filePath, line: UInt = #line
  ) async {
    let store = MemoryCredentialStore()
    let server = StubServer { request in
      request.path == "/device/start" ? try await start(request) : Self.approved
    }
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession(),
      userAgent: "AgentDeskMac/9.9.9")
    let controller = SignInController(
      api: account.api, clock: VirtualClock(), machineName: "Kidus's MacBook Pro"
    ) { [account] token in try account.signIn(token: token) }
    controller.start()
    await controller.settle()

    XCTAssertEqual(controller.phase, .failed(expected), file: file, line: line)
    XCTAssertEqual(expected.message, message, file: file, line: line)
    XCTAssertFalse(expected.offersNewCode, "a start failure offers Try Again", file: file, line: line)
    XCTAssertFalse(
      server.requests.contains { $0.path == "/device/poll" }, "polled without a code",
      file: file, line: line)
    XCTAssertTrue(store.stored.isEmpty, file: file, line: line)
    XCTAssertEqual(account.state, .signedOut, file: file, line: line)
  }

  private static let unreachable = "Couldn't reach AgentDesk. Check your connection and try again."
  private static let serverProblem = "The server had a problem starting sign-in. Try again later."
  private static let rateLimited = "Too many sign-in attempts. Try again in a minute."

  private static func refused(_ status: Int) -> String {
    "The server refused sign-in (HTTP \(status)). Update AgentDesk or check the server setting."
  }

  private static let html = StubResponse(
    status: 404, body: Data("<html>Not Found</html>".utf8), headers: ["Content-Type": "text/html"])

  func testStartWithoutAnHTTPAnswerIsUnreachable() async {
    await assertStartFails(
      { _ in throw URLError(.notConnectedToInternet) }, as: .unreachable, message: Self.unreachable)
    await assertStartFails(
      { _ in throw URLError(.timedOut) }, as: .unreachable, message: Self.unreachable)
    await assertStartFails(.notHTTP, as: .unreachable, message: Self.unreachable)
  }

  /// The 2026-10-28 case: a gateway older than the Mac client refuses the
  /// body without `harnesses`.
  func testStartContractRefusalNamesTheStatus() async {
    await assertStartFails(
      .error(
        400, "invalid",
        "harnesses must be a non-empty list of distinct values from claude-code, codex, and cursor",
        field: "harnesses"),
      as: .serverRefused(status: 400), message: Self.refused(400))
    await assertStartFails(
      .error(403, "forbidden", "No"), as: .serverRefused(status: 403), message: Self.refused(403))
  }

  /// A `ServerURL` host that is not an AgentDesk gateway.
  func testStartNonContractRefusalNamesTheStatus() async {
    await assertStartFails(Self.html, as: .serverRefused(status: 404), message: Self.refused(404))
  }

  func testStartServerErrorIsAServerProblem() async {
    await assertStartFails(
      .error(500, "internal", "Something broke"), as: .serverProblem, message: Self.serverProblem)
    await assertStartFails(
      StubResponse(status: 500, body: Data("<html>".utf8)), as: .serverProblem,
      message: Self.serverProblem)
    await assertStartFails(
      StubResponse(status: 503, body: Data()), as: .serverProblem, message: Self.serverProblem)
  }

  func testStartUnreadableSuccessIsAServerProblem() async {
    await assertStartFails(
      .json(200, #"{"user_code": 7}"#), as: .serverProblem, message: Self.serverProblem)
    await assertStartFails(
      StubResponse(status: 200, body: Data("<html>".utf8)), as: .serverProblem,
      message: Self.serverProblem)
  }

  func testStartRateLimitedWithOrWithoutTheContractBody() async {
    await assertStartFails(
      .error(429, "rate_limited", "Too many sign-in requests"), as: .rateLimited,
      message: Self.rateLimited)
    await assertStartFails(
      StubResponse(status: 429, body: Data("slow down".utf8)), as: .rateLimited,
      message: Self.rateLimited)
  }

  /// A redirect to another origin is refused, so its 3xx is the answer.
  func testStartRefusedRedirectIsAServerProblem() async {
    let elsewhere = StubServer { _ in Self.started() }
    await assertStartFails(
      .redirect(to: "\(elsewhere.origin.absoluteString)/device/start"), as: .serverProblem,
      message: Self.serverProblem)
    XCTAssertTrue(elsewhere.requests.isEmpty)
  }

  /// A start that fails after its attempt was replaced or cancelled changes
  /// nothing.
  func testStartFailureForAnEndedAttemptChangesNothing() async {
    let gate = Gate()
    let starts = Collected()
    let server = StubServer { request in
      guard request.path == "/device/start" else { return Self.poll("declined") }
      if starts.value == nil {
        starts.set(1)
        await gate.wait()
        return .error(400, "invalid", "No", field: "harnesses")
      }
      return Self.started()
    }
    let account = Account(
      configuration: server.configuration, credentials: MemoryCredentialStore(),
      session: server.makeSession(), userAgent: "AgentDeskMac/9.9.9")
    let controller = SignInController(
      api: account.api, clock: VirtualClock(), machineName: "Kidus's MacBook Pro"
    ) { [account] token in try account.signIn(token: token) }

    controller.start()
    while starts.value == nil { await Task.yield() }
    let stale = controller.runningTask
    controller.cancel()
    await gate.open()
    await stale?.value
    XCTAssertEqual(controller.phase, .idle)
  }

  func testOnlyTransportStartFailuresSayUnreachable() {
    let failures: [(APIError, SignInFailure)] = [
      (.transport("The Internet connection appears to be offline."), .unreachable),
      (.response(status: 400, code: "invalid", message: "m", field: "harnesses"), .serverRefused(status: 400)),
      (.response(status: 401, code: "unauthenticated", message: "m", field: nil), .serverRefused(status: 401)),
      (.http(status: 404), .serverRefused(status: 404)),
      (.http(status: 499), .serverRefused(status: 499)),
      (.response(status: 429, code: "rate_limited", message: "m", field: nil), .rateLimited),
      (.http(status: 429), .rateLimited),
      (.response(status: 500, code: "internal", message: "m", field: nil), .serverProblem),
      (.http(status: 502), .serverProblem),
      (.http(status: 302), .serverProblem),
      (.unreadable(status: 200), .serverProblem),
      (.unreadable(status: 204), .serverProblem),
      (.request("Invalid request path"), .serverProblem),
      (.signedOut, .serverProblem),
    ]
    for (error, expected) in failures {
      let failure = SignInFailure.start(error)
      XCTAssertEqual(failure, expected, "\(error)")
      XCTAssertEqual(failure.message == Self.unreachable, expected == .unreachable, "\(error)")
      XCTAssertFalse(failure.offersNewCode, "\(error)")
    }
  }

  // MARK: Start diagnostics

  func testStartDiagnosticNamesStatusCodeAndField() {
    XCTAssertEqual(
      SignInStartDiagnostic.describe(
        .response(status: 400, code: "invalid", message: "harnesses must be a list", field: "harnesses")),
      "HTTP 400, code invalid, field harnesses")
    XCTAssertEqual(
      SignInStartDiagnostic.describe(.response(status: 429, code: "rate_limited", message: "m", field: nil)),
      "HTTP 429, code rate_limited")
    XCTAssertEqual(
      SignInStartDiagnostic.describe(.http(status: 404)), "HTTP 404, no contract error body")
    XCTAssertEqual(
      SignInStartDiagnostic.describe(.unreadable(status: 200)),
      "HTTP 200, the answer could not be decoded")
    XCTAssertEqual(
      SignInStartDiagnostic.describe(.transport("The request timed out.")),
      "no HTTP answer: The request timed out.")
    XCTAssertEqual(
      SignInStartDiagnostic.describe(.request("Invalid request path")),
      "request not sent: Invalid request path")
  }

  /// The diagnostic is logged publicly, so it never carries the contract
  /// message, a URL, a secret, or control characters, and stays bounded.
  func testStartDiagnosticKeepsServerTextOut() {
    let secret = "adp_secret_token"
    let logged = SignInStartDiagnostic.describe(
      .response(status: 400, code: "bad code \(secret)", message: secret, field: "x\ny"))
    XCTAssertEqual(logged, "HTTP 400, code (unrecognized), field (unrecognized)")

    let long = SignInStartDiagnostic.describe(.response(
      status: 400, code: String(repeating: "c", count: 65), message: "", field: nil))
    XCTAssertEqual(long, "HTTP 400, code (unrecognized)")

    let cause = SignInStartDiagnostic.describe(.transport(
      "Could not connect to https://user:\(secret)@desk.example.com/device/start?x=1 now\u{7}"))
    XCTAssertFalse(cause.contains(secret))
    XCTAssertFalse(cause.contains("desk.example.com"))
    XCTAssertEqual(cause, "no HTTP answer: Could not connect to (redacted) now")

    let bounded = SignInStartDiagnostic.describe(.transport(String(repeating: "a ", count: 200)))
    XCTAssertLessThanOrEqual(bounded.count, "no HTTP answer: ".count + 161)
  }

  // MARK: Poll statuses

  func testPendingKeepsPollingAndApprovedStoresTheTokenFirst() async throws {
    let h = harness { now in now < 6 ? Self.poll("pending") : Self.approved }
    var signedInWhenComplete: Bool?
    h.controller.onChange = {
      if h.controller.phase == .complete {
        signedInWhenComplete = h.account.state == .signedIn
      }
    }
    await run(h)

    XCTAssertEqual(h.controller.phase, .complete)
    XCTAssertEqual(signedInWhenComplete, true)
    XCTAssertEqual(h.store.stored, [h.server.configuration.account: "adp_approved"])
    let polls = h.server.requests.filter { $0.path == "/device/poll" }
    XCTAssertEqual(polls.count, 3)
    for poll in polls {
      XCTAssertEqual(poll.method, "POST")
      XCTAssertEqual(poll.jsonBody as NSDictionary?, ["device_secret": Self.secret] as NSDictionary)
      XCTAssertNil(poll.headers["Authorization"])
    }
  }

  func testDeclinedShowsTheMessageAndOffersANewCode() async {
    let h = harness { _ in Self.poll("declined") }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.declined))
    XCTAssertEqual(SignInFailure.declined.message, "Sign-in was declined on your phone")
    XCTAssertTrue(SignInFailure.declined.offersNewCode)
    XCTAssertTrue(h.store.stored.isEmpty)
    XCTAssertEqual(h.account.state, .signedOut)
  }

  func testExpiredAndNotFoundShowExpired() async {
    for status in ["expired", "not_found"] {
      let h = harness { _ in Self.poll(status) }
      await run(h)
      XCTAssertEqual(h.controller.phase, .failed(.expired), status)
    }
    XCTAssertEqual(SignInFailure.expired.message, "This code expired")
    XCTAssertTrue(SignInFailure.expired.offersNewCode)
  }

  func testPollRateLimitedShowsTheMessage() async {
    let h = harness { _ in .error(429, "rate_limited", "Too many requests") }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.rateLimited))
  }

  /// Only start maps a non-contract 429 to rate limited; a poll keeps its
  /// earlier behavior and keeps polling.
  func testNonContractPollFailuresKeepPolling() async {
    let h = harness { now in
      if now < 4 { return StubResponse(status: 429, body: Data("slow down".utf8)) }
      if now < 6 { return StubResponse(status: 404, body: Data("<html>".utf8)) }
      if now < 8 { return .json(200, #"{"status": 7}"#) }
      return Self.approved
    }
    await run(h)
    XCTAssertEqual(h.controller.phase, .complete)
    XCTAssertEqual(h.account.state, .signedIn)
  }

  func testFailedPollKeepsPolling() async {
    let h = harness { now in
      if now < 4 { throw URLError(.networkConnectionLost) }
      return now < 6 ? StubResponse(status: 503, body: Data()) : Self.approved
    }
    await run(h)
    XCTAssertEqual(h.controller.phase, .complete)
    XCTAssertEqual(h.account.state, .signedIn)
  }

  // MARK: Timing

  func testPollsAtTheReturnedInterval() async {
    let h = harness(start: Self.started(interval: 3)) { now in
      now < 12 ? Self.poll("pending") : Self.approved
    }
    await run(h)
    XCTAssertEqual(h.controller.phase, .complete)
    XCTAssertEqual(h.clock.sleeps, [3, 3, 3, 3])
  }

  func testPollingStopsAtExpiresIn() async {
    let h = harness(start: Self.started(interval: 2, expiresIn: 10)) { _ in Self.poll("pending") }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.expired))
    // Polls at 2, 4, 6, and 8 seconds; none at or after 10.
    XCTAssertEqual(h.server.requests.filter { $0.path == "/device/poll" }.count, 4)
    XCTAssertEqual(h.clock.now(), 10)
  }

  /// req-mac-app AC-2.3 under the gateway's 2-second interval with
  /// successful answers: approval at any moment is collected within one
  /// interval, well inside 10 seconds. This is controlled timing, not a live
  /// phone test.
  func testApprovalIsCollectedWithinTenSeconds() async {
    for approvedAt in [0.5, 2.0, 7.3, 31.9] {
      let collectedAt = Collected()
      let h = harness(start: Self.started(interval: 2)) { now in
        guard now >= approvedAt else { return Self.poll("pending") }
        collectedAt.set(now)
        return Self.approved
      }
      await run(h)
      XCTAssertEqual(h.controller.phase, .complete)
      let delay = try? XCTUnwrap(collectedAt.value) - approvedAt
      XCTAssertLessThanOrEqual(delay ?? .infinity, 2, "approved at \(approvedAt)")
      XCTAssertLessThan(delay ?? .infinity, 10)
    }
  }

  // MARK: Expiry

  /// A lifetime that is not a multiple of the interval: the last wait is cut
  /// to the time left, and no poll runs at or after the deadline.
  func testLastWaitIsCutToTheRemainingLifetime() async {
    let h = harness(start: Self.started(interval: 2, expiresIn: 9)) { _ in Self.poll("pending") }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.expired))
    XCTAssertEqual(h.clock.sleeps, [2, 2, 2, 2, 1])
    XCTAssertEqual(h.server.requests.filter { $0.path == "/device/poll" }.count, 4)
    XCTAssertEqual(h.clock.now(), 9)
  }

  /// A poll that starts at 8 s and is still waiting for its answer when the
  /// code's 10-second lifetime ends: the code shows as expired at 10 s, and
  /// the approval that arrives afterwards stores nothing.
  func testPollInFlightAtTheDeadlineExpiresOnTime() async {
    let gate = Gate()
    let held = Collected()
    let h = harness(start: Self.started(interval: 2, expiresIn: 10)) { now in
      guard now >= 8 else { return Self.poll("pending") }
      held.set(now)
      await gate.wait()
      return Self.approved
    }
    h.controller.start()
    // Bounded, so a loop without a deadline on the poll fails instead of hanging.
    for _ in 0..<10_000 where held.value == nil || h.clock.pendingDeadlines == 0 {
      await Task.yield()
    }
    XCTAssertEqual(held.value, 8)
    guard h.clock.pendingDeadlines > 0 else {
      XCTFail("The poll in flight is not bounded by the code's deadline")
      h.controller.cancel()
      await gate.open()
      return
    }
    XCTAssertEqual(h.controller.phase, .waiting(code: "ABCD-2345", machineName: "Kidus's MacBook Pro"))

    h.clock.advance(to: 10)
    await h.controller.settle()
    XCTAssertEqual(h.controller.phase, .failed(.expired))
    XCTAssertEqual(h.clock.now(), 10)

    await gate.open()
    // Give a late answer every chance to arrive before checking.
    for _ in 0..<50 { await Task.yield() }
    XCTAssertEqual(h.controller.phase, .failed(.expired))
    XCTAssertTrue(h.store.stored.isEmpty)
    XCTAssertEqual(h.account.state, .signedOut)
  }

  /// An approval whose answer arrives at the deadline is discarded.
  func testApprovalArrivingAtTheDeadlineIsDiscarded() async {
    let clock = VirtualClock()
    let h = harness(start: Self.started(interval: 2, expiresIn: 10), clock: clock) { now in
      guard now >= 8 else { return Self.poll("pending") }
      // The poll sent at 8 s answers only when the code's lifetime ends.
      clock.advance(to: 10)
      return Self.approved
    }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.expired))
    XCTAssertTrue(h.store.stored.isEmpty)
    XCTAssertEqual(h.account.state, .signedOut)
  }

  // MARK: Cancellation and storage

  func testCancelledAttemptNeverStoresALateApproval() async {
    let gate = Gate()
    let h = harness { _ in
      await gate.wait()
      return Self.approved
    }
    h.controller.start()
    while h.server.requests.filter({ $0.path == "/device/poll" }).isEmpty { await Task.yield() }
    let running = h.controller.runningTask
    h.controller.cancel()
    await gate.open()
    await running?.value

    XCTAssertEqual(h.controller.phase, .idle)
    XCTAssertTrue(h.store.stored.isEmpty)
    XCTAssertEqual(h.account.state, .signedOut)
  }

  func testNewCodeReplacesTheRunningAttempt() async {
    let gate = Gate()
    let first = Collected()
    let h = harness { _ in
      if first.value == nil {
        first.set(1)
        await gate.wait()
        return Self.approved
      }
      return Self.poll("declined")
    }
    h.controller.start()
    while first.value == nil { await Task.yield() }
    let stale = h.controller.runningTask
    h.controller.start()
    await h.controller.settle()
    await gate.open()
    await stale?.value

    XCTAssertEqual(h.controller.phase, .failed(.declined))
    XCTAssertTrue(h.store.stored.isEmpty)
    XCTAssertEqual(h.server.requests.filter { $0.path == "/device/start" }.count, 2)
  }

  func testKeychainFailureFailsTheSignIn() async {
    let store = MemoryCredentialStore()
    store.failSaves(errSecInteractionNotAllowed)
    let h = harness(store: store) { _ in Self.approved }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.keychain))
    XCTAssertEqual(h.account.state, .signedOut)
  }

  func testTokenIsStoredUnderTheConfiguredOrigin() async {
    let store = MemoryCredentialStore()
    let first = harness(store: store) { _ in Self.approved }
    await run(first)
    let second = harness(store: store) { _ in Self.poll("pending") }

    XCTAssertEqual(store.stored, [first.server.configuration.account: "adp_approved"])
    XCTAssertEqual(first.account.state, .signedIn)
    // Another origin reads its own item, so it starts signed out.
    XCTAssertEqual(second.account.state, .signedOut)
    XCTAssertNotEqual(first.server.configuration.account, second.server.configuration.account)
  }

  // MARK: Open at login

  func testFirstSignInTurnsOpenAtLoginOnOnce() {
    let service = FakeLoginService()
    let defaults = makeDefaults()
    let items = LoginItems(service: service, defaults: defaults)

    items.didSignIn()
    XCTAssertEqual(service.registerCalls, 1)
    XCTAssertTrue(items.isOn)

    items.set(false)
    XCTAssertFalse(items.isOn)
    items.didSignIn()
    XCTAssertEqual(service.registerCalls, 1, "A later sign-in overrode the user's choice")
    XCTAssertFalse(items.isOn)
  }

  func testFailedRegistrationIsReportedAndRetried() {
    let service = FakeLoginService()
    service.failure = CocoaError(.featureUnsupported)
    let items = LoginItems(service: service, defaults: makeDefaults())

    items.didSignIn()
    XCTAssertFalse(items.isOn)
    XCTAssertNotNil(items.lastError)

    service.failure = nil
    items.didSignIn()
    XCTAssertTrue(items.isOn)
    XCTAssertNil(items.lastError)
    XCTAssertEqual(service.registerCalls, 2)
  }

  func testRequiresApprovalCountsAsOn() {
    let service = FakeLoginService()
    service.status = .requiresApproval
    XCTAssertTrue(LoginItems(service: service, defaults: makeDefaults()).isOn)
  }
}

/// A value a `@Sendable` handler records for the test to read.
private final class Collected: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: TimeInterval?

  var value: TimeInterval? { lock.withLock { stored } }
  func set(_ value: TimeInterval) { lock.withLock { stored = value } }
}
