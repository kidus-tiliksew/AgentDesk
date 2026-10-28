import Foundation
import XCTest

@testable import AgentDeskKit

/// A notification center in memory that can hold or fail a post.
@MainActor
final class FakeNotificationCenter: NotificationCenterAdapter {
  var status: NotificationAuthorization = .authorized
  var grants = true
  var authorizationRequests = 0
  private(set) var added: [NotificationRequest] = []
  private(set) var delivered: [String] = []
  private(set) var removed: [[String]] = []
  private(set) var removedAll = 0
  private var failures: [Error] = []
  private var holds: [Gate] = []

  struct Refused: Error {}

  /// Fails the next post.
  func failNextAdd() { failures.append(Refused()) }

  /// Holds the next post until the returned gate opens.
  func holdNextAdd() -> Gate {
    let gate = Gate()
    holds.append(gate)
    return gate
  }

  func deliver(_ ids: String...) { delivered += ids }

  func authorization() async -> NotificationAuthorization { status }

  func requestAuthorization() async -> Bool {
    authorizationRequests += 1
    if status == .notDetermined { status = grants ? .authorized : .denied }
    return status == .authorized
  }

  func add(_ request: NotificationRequest) async throws {
    if !holds.isEmpty { await holds.removeFirst().wait() }
    if !failures.isEmpty { throw failures.removeFirst() }
    added.append(request)
    delivered.append(request.identifier)
  }

  func deliveredIdentifiers() async -> [String] { delivered }

  func removeDelivered(_ identifiers: [String]) {
    removed.append(identifiers)
    delivered.removeAll { identifiers.contains($0) }
  }

  func removeAllDelivered() {
    removedAll += 1
    delivered = []
  }
}

/// A live-agent read that answers from a script and counts its calls.
final class FakeAgentRead: @unchecked Sendable {
  private let lock = NSLock()
  private var script: [Result<[AgentSession], APIError>] = []
  private var calls = 0

  var count: Int { lock.withLock { calls } }

  func answer(_ results: Result<[AgentSession], APIError>...) {
    lock.withLock { script += results }
  }

  func read() throws(APIError) -> [AgentSession] {
    let result: Result<[AgentSession], APIError> = lock.withLock {
      calls += 1
      return script.isEmpty ? .success([]) : script.removeFirst()
    }
    return try result.get()
  }
}

/// `Notifier` against the fake center: authorization, content, the store,
/// in-flight posts, retries, removal, and account cleanup (component-mac-app
/// §Notifications; req-mac-app AC-6.1 to AC-6.7).
@MainActor
final class NotifierTests: XCTestCase {
  private var center: FakeNotificationCenter!
  private var agents: FakeAgentRead!
  private var defaults: UserDefaults!
  private var notifier: Notifier!
  private var now = Fixtures.instant("2026-10-27T12:00:30Z")

  override func setUp() async throws {
    center = FakeNotificationCenter()
    agents = FakeAgentRead()
    defaults = makeDefaults()
    now = Fixtures.instant("2026-10-27T12:00:30Z")
    let agents = self.agents!
    notifier = Notifier(
      center: center, settings: NotificationSettings(defaults: defaults),
      store: NotifiedStore(defaults: defaults), readAgents: { () throws(APIError) in try agents.read() },
      now: { [unowned self] in self.now })
  }

  private func pushed(_ id: String, _ overrides: [String: Any] = [:]) -> Decision {
    var fields: [String: Any] = ["notification_action": "push", "agent_session_id": "ags_1"]
    fields.merge(overrides) { $1 }
    return Fixtures.pending(id, fields)
  }

  private func read(_ decisions: [Decision], agents: [AgentSession] = []) async {
    notifier.didRead(pending: decisions, agents: agents)
    await notifier.settle()
  }

  // MARK: Authorization

  func testAuthorizationIsRequestedOnRequest() async {
    center.status = .notDetermined
    notifier.requestAuthorization()
    await eventually("the request") { self.center.authorizationRequests == 1 }
    XCTAssertEqual(center.status, .authorized)
  }

  func testDeniedAuthorizationPostsNothingAndLeavesTheStoreAlone() async {
    center.status = .denied
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added, [])
    XCTAssertFalse(notifier.store.contains("dec_1"), "a later grant can still post it")
    center.status = .authorized
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added.map(\.identifier), ["dec_1"])
  }

  // MARK: Posting

  func testAPostCarriesTheContentAndEntersTheStore() async {
    let decision = pushed("dec_1", ["title": "Ship it?", "deadline": "2026-10-27T12:30:00Z"])
    await read([decision], agents: [Fixtures.session("ags_1", ["display_name": "Codex · api"])])
    XCTAssertEqual(
      center.added,
      [
        NotificationRequest(
          identifier: "dec_1", title: "Ship it?", body: "Codex · api · 29m left",
          categoryIdentifier: "decision.approve_reject", playsDefaultSound: true)
      ])
    XCTAssertTrue(notifier.store.contains("dec_1"))
    XCTAssertEqual(agents.count, 0, "the snapshot named the agent")
  }

  func testRepeatedReadsPostOnce() async {
    let agentsList = [Fixtures.session("ags_1")]
    await read([pushed("dec_1")], agents: agentsList)
    await read([pushed("dec_1")], agents: agentsList)
    now = now.addingTimeInterval(15)
    await read([pushed("dec_1")], agents: agentsList)
    XCTAssertEqual(center.added.count, 1)
  }

  func testAPostInFlightIsNotRepeatedByAReadDuringIt() async {
    let gate = center.holdNextAdd()
    notifier.didRead(pending: [pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    await eventually("the post in flight") { self.notifier.posting == ["dec_1"] }
    notifier.didRead(pending: [pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    notifier.didRead(pending: [pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    await gate.open()
    await notifier.settle()
    XCTAssertEqual(center.added.map(\.identifier), ["dec_1"])
    XCTAssertTrue(notifier.posting.isEmpty)
  }

  func testAFailedPostIsRetriedOnALaterRead() async {
    center.failNextAdd()
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added, [])
    XCTAssertFalse(notifier.store.contains("dec_1"))
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added.map(\.identifier), ["dec_1"])
  }

  func testNothingPostsWhileOpenPausedOrOff() async {
    notifier.isPopoverOpen = true
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertTrue(notifier.store.contains("dec_1"), "listed while open")
    notifier.isPopoverOpen = false

    notifier.settings.pause(now: now)
    await read([pushed("dec_1"), pushed("dec_2")], agents: [Fixtures.session("ags_1")])
    notifier.settings.resume()
    notifier.settings.setOn(false)
    await read([pushed("dec_1"), pushed("dec_2")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added, [])

    notifier.settings.setOn(true)
    await read([pushed("dec_1"), pushed("dec_2")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added.map(\.identifier), ["dec_2"], "the open popover's row stays quiet")
  }

  func testAPauseExpiringAllowsTheNextRead() async {
    notifier.settings.pause(now: now)
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added, [])
    // The pause ends 1 hour later; the next read posts a fresh decision.
    now = now.addingTimeInterval(3600)
    let fresh = pushed("dec_2", ["created_at": "2026-10-27T13:00:00Z"])
    await read([fresh], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added.map(\.identifier), ["dec_2"])
    XCTAssertTrue(notifier.settings.isOn)
  }

  func testMarkListedSuppressesAfterClose() async {
    notifier.markListed(["dec_1"])
    await read([pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    XCTAssertEqual(center.added, [])
  }

  // MARK: Agent names

  func testAMissingNameIsReadOnceForSeveralDecisions() async {
    agents.answer(.success([Fixtures.session("ags_1", ["display_name": "Cursor · ui"])]))
    await read([pushed("dec_1"), pushed("dec_2")])
    XCTAssertEqual(agents.count, 1)
    XCTAssertEqual(center.added.map(\.body), ["Cursor · ui", "Cursor · ui"])
    await read([pushed("dec_3")])
    XCTAssertEqual(agents.count, 1, "the run caches the name")
  }

  func testASessionTheLiveReadDoesNotListIsAnEndedAgent() async {
    agents.answer(.success([Fixtures.session("ags_other")]))
    await read([pushed("dec_1")])
    XCTAssertEqual(center.added.map(\.body), ["Ended agent"])
  }

  func testAFailedNameReadPostsNothingAndRetries() async {
    agents.answer(.failure(.transport("offline")))
    await read([pushed("dec_1")])
    XCTAssertEqual(center.added, [], "a live agent is never shown as ended")
    XCTAssertFalse(notifier.store.contains("dec_1"))

    agents.answer(.success([Fixtures.session("ags_1", ["display_name": "Claude Code · web"])]))
    await read([pushed("dec_1")])
    XCTAssertEqual(center.added.map(\.body), ["Claude Code · web"])
  }

  func testADecisionWithoutASessionNeedsNoRead() async {
    await read([pushed("dec_1", ["agent_session_id": NSNull()])])
    XCTAssertEqual(agents.count, 0)
    XCTAssertEqual(center.added.map(\.body), ["Ended agent"])
  }

  // MARK: Removal

  func testEveryReadRemovesNotificationsOfDecisionsNoLongerPending() async {
    let agentsList = [Fixtures.session("ags_1")]
    await read([pushed("dec_1"), pushed("dec_2"), pushed("dec_3")], agents: agentsList)
    XCTAssertEqual(Set(center.delivered), ["dec_1", "dec_2", "dec_3"])
    // dec_1 answered, dec_2 cancelled, dec_3 expired: each leaves the read.
    await read([pushed("dec_2"), pushed("dec_3")], agents: agentsList)
    await read([pushed("dec_3")], agents: agentsList)
    await read([], agents: agentsList)
    XCTAssertEqual(center.removed, [["dec_1"], ["dec_2"], ["dec_3"]])
    XCTAssertEqual(center.delivered, [])
    XCTAssertTrue(notifier.store.ids.isEmpty, "the store is pruned to pending ids")
  }

  func testRemovalRunsWhilePausedOrOpen() async {
    center.deliver("dec_old")
    notifier.isPopoverOpen = true
    notifier.settings.pause(now: now)
    await read([])
    XCTAssertEqual(center.removed, [["dec_old"]])
  }

  func testADecisionSettledWhileItsPostIsInFlightIsRemoved() async {
    let gate = center.holdNextAdd()
    notifier.didRead(pending: [pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    await eventually("the post in flight") { self.notifier.posting == ["dec_1"] }
    notifier.didRead(pending: [], agents: [])
    await gate.open()
    await notifier.settle()
    XCTAssertEqual(center.delivered, [])
  }

  // MARK: Account

  func testSignOutDuringAPostRemovesItWhenItLands() async {
    let gate = center.holdNextAdd()
    notifier.didRead(pending: [pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    await eventually("the post in flight") { self.notifier.posting == ["dec_1"] }
    notifier.reset()
    XCTAssertEqual(center.removedAll, 1)
    await gate.open()
    await notifier.settle()
    XCTAssertEqual(center.delivered, [], "the old account's notification does not stay")
    XCTAssertTrue(notifier.store.ids.isEmpty)
  }

  func testResetDropsQueuedReads() async {
    let gate = center.holdNextAdd()
    notifier.didRead(pending: [pushed("dec_1")], agents: [Fixtures.session("ags_1")])
    await eventually("the post in flight") { self.notifier.posting == ["dec_1"] }
    notifier.didRead(pending: [pushed("dec_1"), pushed("dec_2")], agents: [Fixtures.session("ags_1")])
    notifier.reset()
    await gate.open()
    await notifier.settle()
    XCTAssertEqual(center.added.map(\.identifier), ["dec_1"], "the queued read never ran")
    XCTAssertEqual(center.delivered, [])
  }

  func testAPopoverOpeningDuringANameReadStopsThePost() async {
    // The name read is the await before the post; the popover opens then.
    let opened = FakeAgentRead()
    let center = self.center!
    let notifier = Notifier(
      center: center, settings: NotificationSettings(defaults: defaults),
      store: NotifiedStore(defaults: defaults),
      readAgents: { @MainActor [weak self] () throws(APIError) in
        self?.notifier.isPopoverOpen = true
        return try opened.read()
      }, now: { [unowned self] in self.now })
    self.notifier = notifier
    notifier.didRead(pending: [pushed("dec_1")], agents: [])
    await notifier.settle()
    XCTAssertEqual(center.added, [])
  }
}
