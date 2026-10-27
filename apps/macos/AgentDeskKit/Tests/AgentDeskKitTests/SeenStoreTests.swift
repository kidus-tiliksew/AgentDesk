import Foundation
import XCTest

@testable import AgentDeskKit

/// Decisions seen in a closed popover (component-mac-app §Ordering and
/// attention; req-mac-app AC-3.3).
@MainActor
final class SeenStoreTests: XCTestCase {
  func testStartsEmptyAndEveryDecisionIsNew() {
    let store = SeenStore(defaults: makeDefaults())
    XCTAssertTrue(store.ids.isEmpty)
    XCTAssertTrue(store.isNew(Fixtures.pending("dec_1")))
  }

  func testMarkingTheListedIdsOnClosePersists() {
    let defaults = makeDefaults()
    let store = SeenStore(defaults: defaults)
    store.markSeen(["dec_1", "dec_2"])
    XCTAssertFalse(store.isNew(Fixtures.pending("dec_1")))

    let reopened = SeenStore(defaults: defaults)
    XCTAssertEqual(reopened.ids, ["dec_1", "dec_2"])
  }

  func testADecisionArrivingAfterCloseStaysNew() {
    let store = SeenStore(defaults: makeDefaults())
    store.markSeen(["dec_1"])
    XCTAssertTrue(store.isNew(Fixtures.pending("dec_2")))
  }

  func testPruningKeepsOnlyPendingIds() {
    let defaults = makeDefaults()
    let store = SeenStore(defaults: defaults)
    store.markSeen(["dec_1", "dec_2", "dec_3"])
    store.prune(toPending: ["dec_2", "dec_9"])
    XCTAssertEqual(store.ids, ["dec_2"])
    XCTAssertEqual(SeenStore(defaults: defaults).ids, ["dec_2"])
  }

  func testSignOutClearsTheStore() async throws {
    let defaults = makeDefaults()
    let server = StubServer { _ in .json(204, "") }
    let account = Account(
      configuration: server.configuration, credentials: MemoryCredentialStore(),
      session: server.makeSession(), userAgent: "AgentDeskMac/9.9.9")
    try account.signIn(token: "adp_live")
    let store = SeenStore(defaults: defaults)
    store.clearOnSignOut(of: account)
    store.markSeen(["dec_1"])

    _ = await account.signOut()
    XCTAssertTrue(store.ids.isEmpty)
    XCTAssertNil(defaults.object(forKey: SeenStore.key))
  }

  func testAnUnauthorizedAnswerClearsTheStore() async throws {
    let server = StubServer { _ in .error(401, "unauthenticated", "Revoked") }
    let account = Account(
      configuration: server.configuration, credentials: MemoryCredentialStore(),
      session: server.makeSession(), userAgent: "AgentDeskMac/9.9.9")
    try account.signIn(token: "adp_revoked")
    let store = SeenStore(defaults: makeDefaults())
    store.clearOnSignOut(of: account)
    store.markSeen(["dec_1"])

    _ = try? await account.api.pendingDecisions()
    XCTAssertEqual(account.state, .signedOut)
    XCTAssertTrue(store.ids.isEmpty)
  }
}
