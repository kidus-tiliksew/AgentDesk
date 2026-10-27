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
    poll: @escaping @Sendable (_ now: TimeInterval) async throws -> StubResponse
  ) -> Harness {
    let clock = VirtualClock()
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

  func testStartUnreachableFails() async {
    let h = harness(start: StubResponse(status: 503, body: Data())) { _ in Self.poll("pending") }
    await run(h)
    XCTAssertEqual(h.controller.phase, .failed(.unreachable))
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
