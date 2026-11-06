import Foundation
import XCTest

@testable import AgentDeskKit

/// `APIClient` against a `URLProtocol` stub (component-mac-app §API client,
/// §Verification).
final class APIClientTests: XCTestCase {
  // MARK: Server configuration

  func testDefaultOriginIsThePublicOrigin() {
    let configuration = ServerConfiguration(defaults: makeDefaults())
    XCTAssertEqual(
      configuration.origin.absoluteString, "https://agentdesk-gateway.kidus-tiliksew.workers.dev")
    XCTAssertEqual(configuration.account, "https://agentdesk-gateway.kidus-tiliksew.workers.dev")
  }

  func testServerURLOverrideKeepsOnlyItsHTTPSOrigin() {
    let defaults = makeDefaults()
    defaults.set("https://Desk.Example.com:8443/some/path?x=1", forKey: "ServerURL")
    XCTAssertEqual(
      ServerConfiguration(defaults: defaults).origin.absoluteString, "https://desk.example.com:8443")

    defaults.set("https://desk.example.com:443/", forKey: "ServerURL")
    XCTAssertEqual(
      ServerConfiguration(defaults: defaults).origin.absoluteString, "https://desk.example.com")
  }

  func testServerURLOverrideThatIsNotAbsoluteHTTPSIsIgnored() {
    for value in [
      "http://desk.example.com", "desk.example.com", "https://", "ftp://desk.example.com",
      "https://user:pw@desk.example.com", "",
    ] {
      let defaults = makeDefaults()
      defaults.set(value, forKey: "ServerURL")
      XCTAssertEqual(
        ServerConfiguration(defaults: defaults).origin, ServerConfiguration.publicOrigin, value)
    }
  }

  func testKeychainItemIsKeyedByOriginAndNeverSynchronized() {
    let query = KeychainCredentialStore.query(account: "https://desk.example.com")
    XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
    XCTAssertEqual(query[kSecAttrService as String] as? String, "sh.kidus.agentdesk.mac")
    XCTAssertEqual(query[kSecAttrAccount as String] as? String, "https://desk.example.com")
    XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
    let attributes = KeychainCredentialStore.attributes(token: "adp_x")
    XCTAssertEqual(
      attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlock as String)
    XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data("adp_x".utf8))
  }

  // MARK: Requests

  func testRequestsGoToTheConfiguredOriginWithHeaders() async throws {
    let server = StubServer { _ in .json(200, Fixtures.json(Fixtures.pendingDecision(id: "d 1/x"))) }
    let decision = try await server.makeClient(token: "adp_secret").decision(id: "d 1/x")
    XCTAssertEqual(decision.id, "d 1/x")

    let request = try XCTUnwrap(server.requests.first)
    XCTAssertEqual(request.method, "GET")
    XCTAssertEqual(request.url.host, server.origin.host)
    XCTAssertEqual(request.url.absoluteString, "\(server.origin.absoluteString)/v1/decisions/d%201%2Fx")
    XCTAssertEqual(request.headers["Authorization"], "Bearer adp_secret")
    XCTAssertEqual(request.headers["Accept"], "application/json")
    XCTAssertEqual(request.headers["User-Agent"], "AgentDeskMac/9.9.9")
    XCTAssertEqual(request.timeout, 15)
  }

  func testUserAgentNamesTheBundleVersion() {
    XCTAssertTrue(APIClient.userAgent(bundle: .main).hasPrefix("AgentDeskMac/"))
  }

  func testPendingDecisionsFollowCursorsWithTheSameFilters() async throws {
    let cursor = "a+b/c=d&e"
    let server = StubServer { request in
      if request.query["cursor"] == nil {
        return .json(200, Fixtures.page([Fixtures.pendingDecision(id: "d1")], next: cursor))
      }
      return .json(200, Fixtures.page([Fixtures.pendingDecision(id: "d2")], next: nil))
    }
    let decisions = try await server.makeClient().pendingDecisions()
    XCTAssertEqual(decisions.map(\.id), ["d1", "d2"])

    let requests = server.requests
    XCTAssertEqual(requests.count, 2)
    for request in requests {
      XCTAssertEqual(request.path, "/v1/decisions")
      XCTAssertEqual(request.query["state"], "pending")
      XCTAssertEqual(request.query["limit"], "100")
    }
    XCTAssertNil(requests[0].query["cursor"])
    XCTAssertEqual(requests[1].query["cursor"], cursor)
    // Reserved characters are escaped, so the server reads the cursor as sent.
    XCTAssertTrue(
      try XCTUnwrap(requests[1].url.query).contains("cursor=a%2Bb%2Fc%3Dd%26e"),
      requests[1].url.absoluteString)
  }

  func testAnswerPostsTheSubmission() async throws {
    let server = StubServer { _ in
      .json(200, Fixtures.json(Fixtures.decision(["answer": ["kind": "options", "option_ids": ["a"]]])))
    }
    let client = server.makeClient()
    _ = try await client.answer(id: "dec_1", answer: .options(ids: ["a"]), note: "Looks right")
    _ = try await client.answer(id: "dec_1", answer: .approve)

    let requests = server.requests
    XCTAssertEqual(requests.map(\.method), ["POST", "POST"])
    XCTAssertEqual(requests[0].path, "/v1/decisions/dec_1/answer")
    XCTAssertEqual(requests[0].headers["Content-Type"], "application/json")
    XCTAssertEqual(
      requests[0].jsonBody as NSDictionary?,
      ["answer": ["kind": "options", "option_ids": ["a"]], "note": "Looks right"] as NSDictionary)
    XCTAssertEqual(requests[1].jsonBody as NSDictionary?, ["answer": ["kind": "approve"]] as NSDictionary)
  }

  func testLiveAgentsStopAtTheFirstEndedSession() async throws {
    let server = StubServer { request in
      switch request.query["cursor"] {
      case nil:
        return .json(
          200, Fixtures.page([Fixtures.agentSession(id: "s1"), Fixtures.agentSession(id: "s2")], next: "p2"))
      case "p2":
        return .json(
          200,
          Fixtures.page(
            [Fixtures.agentSession(id: "s3"), Fixtures.agentSession(id: "s4", ended: true)], next: "p3"))
      default:
        XCTFail("Read past the first ended session")
        return .json(200, Fixtures.page([], next: nil))
      }
    }
    let sessions = try await server.makeClient().liveAgentSessions()
    XCTAssertEqual(sessions.map(\.id), ["s1", "s2", "s3"])
    XCTAssertEqual(server.requests.count, 2)
    for request in server.requests {
      XCTAssertEqual(request.path, "/v1/agent-sessions")
      XCTAssertEqual(request.query["limit"], "100")
    }
  }

  // MARK: One agent session and its history

  func testAgentSessionReadsOneSessionWithTheBearerAndAnEscapedID() async throws {
    let server = StubServer { _ in .json(200, Fixtures.json(Fixtures.agentSession(id: "s 1/x"))) }
    let session = try await server.makeClient(token: "adp_secret").agentSession(id: "s 1/x")
    XCTAssertEqual(session.id, "s 1/x")
    let request = try XCTUnwrap(server.requests.first)
    XCTAssertEqual(server.requests.count, 1)
    XCTAssertEqual(request.method, "GET")
    XCTAssertEqual(
      request.url.absoluteString, "\(server.origin.absoluteString)/v1/agent-sessions/s%201%2Fx")
    XCTAssertEqual(request.headers["Authorization"], "Bearer adp_secret")
    XCTAssertEqual(request.headers["Accept"], "application/json")
    XCTAssertEqual(request.timeout, 15)
  }

  func testHistoryReadsTheRouteWithNoCursorAndKeepsTheServersOrder() async throws {
    let body = Fixtures.json([
      "items": [
        Fixtures.historyEntry(["line": "newest", "at": "2026-10-27T11:59:00Z"]),
        Fixtures.historyEntry(["line": "older", "link": NSNull(), "at": "2026-10-27T11:00:00+01:00"]),
      ],
      "added_later": true,
    ])
    let server = StubServer { _ in .json(200, body) }
    let history = try await server.makeClient(token: "adp_secret").agentSessionHistory(id: "s 1/x")
    XCTAssertEqual(history.map(\.line), ["newest", "older"])
    XCTAssertNil(history[1].link)
    XCTAssertEqual(history[1].at, Fixtures.instant("2026-10-27T10:00:00Z"))
    let request = try XCTUnwrap(server.requests.first)
    XCTAssertEqual(server.requests.count, 1)
    XCTAssertEqual(
      request.url.absoluteString, "\(server.origin.absoluteString)/v1/agent-sessions/s%201%2Fx/history",
      "the route has no cursor")
    XCTAssertEqual(request.headers["Authorization"], "Bearer adp_secret")
  }

  func testAnEmptyHistoryIsAnEmptyList() async throws {
    let server = StubServer { _ in .json(200, Fixtures.json(["items": [Any]()])) }
    let history = try await server.makeClient().agentSessionHistory(id: "s1")
    XCTAssertEqual(history, [])
  }

  func testDetailReadsMapErrorsAsEveryOtherRead() async throws {
    let notFound = APIError.response(status: 404, code: "not_found", message: "Missing", field: nil)
    let contract = StubServer { _ in .error(404, "not_found", "Missing") }
    await assertThrows(notFound) { _ = try await contract.makeClient().agentSession(id: "s1") }
    await assertThrows(notFound) { _ = try await contract.makeClient().agentSessionHistory(id: "s1") }

    let html = StubServer { _ in StubResponse(status: 404, body: Data("<html>".utf8)) }
    await assertThrows(.http(status: 404)) { _ = try await html.makeClient().agentSessionHistory(id: "s1") }

    let unreadable = StubServer { _ in .json(200, "{\"items\": 1}") }
    await assertThrows(.unreadable(status: 200)) {
      _ = try await unreadable.makeClient().agentSessionHistory(id: "s1")
    }
  }

  @MainActor
  func testDetailReads401SignOut() async throws {
    for read in ["session", "history"] {
      let server = StubServer { _ in .error(401, "unauthenticated", "Missing or invalid credential") }
      let store = MemoryCredentialStore([server.configuration.account: "adp_old"])
      let account = Account(
        configuration: server.configuration, credentials: store, session: server.makeSession(),
        userAgent: "AgentDeskMac/9.9.9")
      XCTAssertEqual(account.state, .signedIn, read)
      do {
        if read == "session" {
          _ = try await account.api.agentSession(id: "s1")
        } else {
          _ = try await account.api.agentSessionHistory(id: "s1")
        }
        XCTFail("expected a 401 from the \(read) read")
      } catch {
        XCTAssertEqual(error.status, 401, read)
      }
      await eventually("\(read): signed out") { account.state == .signedOut }
    }
  }

  func testDetailReadsWithoutATokenSendNothing() async throws {
    let server = StubServer { _ in .json(200, "{}") }
    let client = server.makeClient(token: nil)
    await assertThrows(.signedOut) { _ = try await client.agentSession(id: "s1") }
    await assertThrows(.signedOut) { _ = try await client.agentSessionHistory(id: "s1") }
    XCTAssertTrue(server.requests.isEmpty)
  }

  private func assertThrows(
    _ expected: APIError, file: StaticString = #filePath, line: UInt = #line,
    _ body: () async throws -> Void
  ) async {
    do {
      try await body()
      XCTFail("expected \(expected)", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? APIError, expected, file: file, line: line)
    }
  }

  func testLiveAgentsFollowCursorsUntilNull() async throws {
    let server = StubServer { request in
      request.query["cursor"] == nil
        ? .json(200, Fixtures.page([Fixtures.agentSession(id: "s1")], next: "p2"))
        : .json(200, Fixtures.page([Fixtures.agentSession(id: "s2")], next: nil))
    }
    let sessions = try await server.makeClient().liveAgentSessions()
    XCTAssertEqual(sessions.map(\.id), ["s1", "s2"])
  }

  // MARK: Errors

  func testContractErrorBodyMapsToResponseError() async {
    let server = StubServer { _ in .error(409, "conflict", "Already answered", field: "answer") }
    do {
      _ = try await server.makeClient().answer(id: "dec_1", answer: .approve)
      XCTFail("Expected an error")
    } catch {
      XCTAssertEqual(
        error, .response(status: 409, code: "conflict", message: "Already answered", field: "answer"))
    }
  }

  func testContractErrorKeepsItsStatusForEveryAccessor() {
    let error = APIError.response(status: 404, code: "not_found", message: "m", field: nil)
    XCTAssertEqual(error.status, 404)
    XCTAssertEqual(error.httpStatus, 404)
    XCTAssertEqual(error.code, "not_found")
  }

  /// A non-2xx answer without the contract error body keeps its HTTP status
  /// in `httpStatus` only, so `status`, `code`, `isUnauthenticated`, and
  /// `isRateLimited` read as they did for a transport failure.
  func testNonContractAnswerKeepsItsHTTPStatusOnly() async {
    for status in [401, 404, 409, 429, 500, 502] {
      let server = StubServer { _ in StubResponse(status: status, body: Data("<html>".utf8)) }
      let error = await failure { try await server.makeClient().decision(id: "x") }
      XCTAssertEqual(error, .http(status: status))
      XCTAssertNil(error?.status)
      XCTAssertNil(error?.code)
      XCTAssertEqual(error?.httpStatus, status)
      XCTAssertEqual(error?.isUnauthenticated, false)
      XCTAssertEqual(error?.isRateLimited, false)
    }
    // An empty body and a JSON body that is not the contract shape.
    let empty = StubServer { _ in StubResponse(status: 503, body: Data()) }
    let emptyError = await failure { try await empty.makeClient().pendingDecisions() }
    XCTAssertEqual(emptyError, .http(status: 503))
    let other = StubServer { _ in .json(400, #"{"message": "bad"}"#) }
    let otherError = await failure { try await other.makeClient().decision(id: "x") }
    XCTAssertEqual(otherError, .http(status: 400))
  }

  func testUnreadableSuccessKeepsItsStatus() async {
    let unreadable = StubServer { _ in .json(200, #"{"items": "nope"}"#) }
    let error = await failure { try await unreadable.makeClient().pendingDecisions() }
    XCTAssertEqual(error, .unreadable(status: 200))
    XCTAssertNil(error?.status)
    XCTAssertEqual(error?.httpStatus, 200)

    let start = StubServer { _ in .json(201, #"{"user_code": 7}"#) }
    let startError = await failure { try await start.makeClient().startSignIn(machineName: "Mac") }
    XCTAssertEqual(startError, .unreadable(status: 201))
  }

  func testNoHTTPAnswerMapsToTransport() async {
    let offline = StubServer { _ in throw URLError(.notConnectedToInternet) }
    await assertTransport { try await offline.makeClient().decision(id: "x") }
    let notHTTP = StubServer { _ in .notHTTP }
    await assertTransport { try await notHTTP.makeClient().decision(id: "x") }
    let error = await failure { try await offline.makeClient().decision(id: "x") }
    XCTAssertNil(error?.httpStatus)
  }

  func testSignedOutClientSendsNothing() async {
    let server = StubServer { _ in .json(200, Fixtures.page([], next: nil)) }
    do {
      _ = try await server.makeClient(token: nil).pendingDecisions()
      XCTFail("Expected an error")
    } catch {
      XCTAssertEqual(error, .signedOut)
    }
    XCTAssertTrue(server.requests.isEmpty)
  }

  func testRedirectToAnotherOriginIsNotFollowed() async {
    let elsewhere = StubServer { _ in .json(200, Fixtures.json(Fixtures.pendingDecision())) }
    let server = StubServer { _ in .redirect(to: "\(elsewhere.origin.absoluteString)/v1/decisions/x") }
    // The refused redirect's own 302 is the answer.
    let error = await failure { try await server.makeClient(token: "adp_secret").decision(id: "x") }
    XCTAssertEqual(error, .http(status: 302))
    XCTAssertTrue(elsewhere.requests.isEmpty, "The bearer token reached another origin")
  }

  func testRedirectWithinTheOriginIsFollowed() async throws {
    let server = StubServer { request in
      request.path == "/v1/decisions/old"
        ? .redirect(to: "/v1/decisions/new")
        : .json(200, Fixtures.json(Fixtures.pendingDecision(id: "new")))
    }
    let decision = try await server.makeClient().decision(id: "old")
    XCTAssertEqual(decision.id, "new")
  }

  // MARK: Unauthorized

  @MainActor
  func testUnauthorizedSignsOutWithoutDelete() async throws {
    let server = StubServer { _ in .error(401, "unauthenticated", "Missing or invalid credential") }
    let store = MemoryCredentialStore([server.configuration.account: "adp_old"])
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession(),
      userAgent: "AgentDeskMac/9.9.9")
    var cleanups = 0
    account.addCleanup { cleanups += 1 }
    XCTAssertEqual(account.state, .signedIn)

    do {
      _ = try await account.api.pendingDecisions()
      XCTFail("Expected an error")
    } catch {
      XCTAssertEqual(error.status, 401)
    }
    XCTAssertEqual(account.state, .signedOut)
    XCTAssertTrue(store.stored.isEmpty)
    XCTAssertEqual(cleanups, 1)
    XCTAssertEqual(server.requests.map(\.method), ["GET"])
    XCTAssertFalse(server.requests.contains { $0.path == "/device/connection" })
  }

  /// Any HTTP 401 to a `/v1` request signs out, with or without the contract
  /// body, as before the non-contract case existed.
  @MainActor
  func testNonContractUnauthorizedStillSignsOut() async throws {
    let server = StubServer { _ in StubResponse(status: 401, body: Data("<html>".utf8)) }
    let store = MemoryCredentialStore([server.configuration.account: "adp_old"])
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession(),
      userAgent: "AgentDeskMac/9.9.9")
    XCTAssertEqual(account.state, .signedIn)

    do {
      _ = try await account.api.pendingDecisions()
      XCTFail("Expected an error")
    } catch {
      XCTAssertEqual(error, .http(status: 401))
    }
    XCTAssertEqual(account.state, .signedOut)
    XCTAssertTrue(store.stored.isEmpty)
    XCTAssertFalse(server.requests.contains { $0.path == "/device/connection" })
  }

  @MainActor
  func testUnauthorizedForAReplacedTokenKeepsTheNewSignIn() async throws {
    let store = MemoryCredentialStore()
    let gate = Gate()
    let server = StubServer { _ in
      await gate.wait()
      return .error(401, "unauthenticated", "Missing or invalid credential")
    }
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession())
    try account.signIn(token: "adp_old")
    let read = Task { try await account.api.pendingDecisions() }
    while server.requests.isEmpty { await Task.yield() }
    try account.signIn(token: "adp_new")
    await gate.open()
    _ = await read.result

    XCTAssertEqual(account.state, .signedIn)
    XCTAssertEqual(store.stored, [server.configuration.account: "adp_new"])
  }

  // MARK: Sign-out

  @MainActor
  func testSignOutRevokesTheCapturedTokenAndClearsLocalState() async {
    let server = StubServer { _ in .json(200, "null") }
    let store = MemoryCredentialStore([server.configuration.account: "adp_mine"])
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession())
    var cleanups = 0
    account.addCleanup { cleanups += 1 }

    let outcome = await account.signOut()
    XCTAssertEqual(outcome, SignOutOutcome(revocationError: nil, keychainError: nil))
    XCTAssertNil(outcome.message)
    XCTAssertEqual(account.state, .signedOut)
    XCTAssertTrue(store.stored.isEmpty)
    XCTAssertEqual(cleanups, 1)
    let request = try? XCTUnwrap(server.requests.first)
    XCTAssertEqual(request?.method, "DELETE")
    XCTAssertEqual(request?.path, "/device/connection")
    XCTAssertEqual(request?.headers["Authorization"], "Bearer adp_mine")
  }

  @MainActor
  func testSignOutClearsLocalStateWhenRevocationFails() async {
    let cases: [StubServer.Handler] = [
      { _ in .error(503, "unavailable", "Service unavailable") },
      { _ in throw URLError(.timedOut) },
    ]
    for handler in cases {
      let server = StubServer(handler: handler)
      let store = MemoryCredentialStore([server.configuration.account: "adp_mine"])
      let account = Account(
        configuration: server.configuration, credentials: store, session: server.makeSession())

      let outcome = await account.signOut()
      XCTAssertNotNil(outcome.revocationError)
      XCTAssertNotNil(outcome.message)
      XCTAssertEqual(account.state, .signedOut)
      XCTAssertTrue(store.stored.isEmpty)
      XCTAssertEqual(server.requests.map(\.method), ["DELETE"])
    }
  }

  @MainActor
  func testSignOutOfARevokedTokenCountsAsRevoked() async {
    let server = StubServer { _ in .error(401, "unauthenticated", "Missing or invalid credential") }
    let store = MemoryCredentialStore([server.configuration.account: "adp_mine"])
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession())
    let outcome = await account.signOut()
    XCTAssertNil(outcome.revocationError)
    XCTAssertEqual(account.state, .signedOut)
    XCTAssertEqual(server.requests.count, 1)
  }

  @MainActor
  func testSignOutReportsAKeychainFailure() async {
    let server = StubServer { _ in .json(200, "null") }
    let store = MemoryCredentialStore([server.configuration.account: "adp_mine"])
    store.failDeletes(errSecInteractionNotAllowed)
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession())
    let outcome = await account.signOut()
    XCTAssertEqual(outcome.keychainError, CredentialStoreError(status: errSecInteractionNotAllowed))
    XCTAssertNotNil(outcome.message)
    XCTAssertEqual(account.state, .signedOut)
  }

  // MARK: Helpers

  /// The `APIError` the request threw, or nil when it succeeded.
  private func failure<T>(_ body: () async throws -> T) async -> APIError? {
    do {
      _ = try await body()
      return nil
    } catch {
      return error as? APIError
    }
  }

  private func assertTransport<T>(
    _ body: () async throws -> T, file: StaticString = #filePath, line: UInt = #line
  ) async {
    do {
      _ = try await body()
      XCTFail("Expected a transport error", file: file, line: line)
    } catch {
      guard case .transport = error as? APIError else {
        return XCTFail("Expected a transport error, got \(error)", file: file, line: line)
      }
    }
  }
}
