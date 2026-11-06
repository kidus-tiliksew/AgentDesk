import Foundation
import XCTest

@testable import AgentDeskKit

/// The agent session the panel shows (component-mac-app §Detail panel;
/// req-mac-app AC-5.3, AC-11.3, AC-11.4, AC-11.5, AC-11.7, AC-11.10).
@MainActor
final class AgentDetailTests: XCTestCase {
  private let now = Fixtures.instant("2026-10-27T12:10:00Z")
  private let seed = Fixtures.session("s1", ["line": "From the list"])
  private let session = Fixtures.session("s1", ["line": "From the read"])
  private let history = [
    StatusHistoryEntry(state: .waiting, line: "newest", at: Fixtures.instant("2026-10-27T12:08:00Z")),
    StatusHistoryEntry(state: .working, line: "older", at: Fixtures.instant("2026-10-27T11:10:00Z")),
  ]

  private func makeDetail() -> (AgentDetail, FakeAgentDetailReads) {
    let reads = FakeAgentDetailReads()
    return (AgentDetail(reads: reads), reads)
  }

  private func target(_ id: String = "s1", _ generation: Int = 1) -> AgentDetailTarget {
    AgentDetailTarget(id: id, generation: generation)
  }

  // MARK: Target

  func testToggleOpensClosesAndReplaces() {
    let (detail, reads) = makeDetail()
    detail.toggle("s1", known: seed)
    XCTAssertEqual(detail.shownID, "s1")
    XCTAssertEqual(detail.content, .loading(seed))
    detail.toggle("s2", known: nil)
    XCTAssertEqual(detail.shownID, "s2")
    XCTAssertEqual(detail.content, .loading(nil))
    detail.toggle("s2", known: nil)
    XCTAssertNil(detail.shownID)
    XCTAssertNil(detail.content)
    XCTAssertEqual(reads.shows, ["s1", "s2"])
    XCTAssertEqual(reads.hideCalls, 1)
  }

  func testShowingTheShownSessionChangesNothing() {
    let (detail, reads) = makeDetail()
    detail.show("s1", known: seed)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    detail.show("s1", known: seed)
    XCTAssertEqual(detail.content, .loaded(session, history))
    XCTAssertEqual(reads.shows, ["s1"])
  }

  // MARK: Reads

  func testAPairReplacesTheSeedAndAnUnchangedPairPublishesNothing() {
    let (detail, _) = makeDetail()
    var changes = 0
    detail.show("s1", known: seed)
    detail.onChange = { changes += 1 }
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    XCTAssertEqual(detail.content, .loaded(session, history))
    XCTAssertEqual(changes, 1)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    XCTAssertEqual(changes, 1)
  }

  func testAFirstFailureKeepsTheSeedAndOffersRetry() {
    let (detail, reads) = makeDetail()
    detail.show("s1", known: seed)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .failed))
    XCTAssertEqual(detail.content, .failed(seed))
    XCTAssertFalse(detail.refreshFailed)
    XCTAssertEqual(detail.session, seed, "the list's record stays useful")

    detail.retry()
    XCTAssertEqual(detail.content, .loading(seed))
    XCTAssertEqual(reads.retryCalls, 1)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    XCTAssertEqual(detail.content, .loaded(session, history))
  }

  func testAFailedRefreshKeepsThePairAndWarnsUntilASuccess() {
    let (detail, reads) = makeDetail()
    detail.show("s1", known: seed)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    detail.apply(AgentDetailUpdate(target: target(), outcome: .failed))
    XCTAssertEqual(detail.content, .loaded(session, history))
    XCTAssertTrue(detail.refreshFailed)

    detail.retry()
    XCTAssertEqual(detail.content, .loaded(session, history), "Try Again keeps the pair on screen")
    XCTAssertTrue(detail.refreshFailed)
    XCTAssertEqual(reads.retryCalls, 1)

    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    XCTAssertFalse(detail.refreshFailed, "an unchanged pair still clears the warning")
  }

  func testGoneReplacesAnyContent() {
    let (detail, _) = makeDetail()
    detail.show("s1", known: seed)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    detail.apply(AgentDetailUpdate(target: target(), outcome: .failed))
    detail.apply(AgentDetailUpdate(target: target(), outcome: .gone))
    XCTAssertEqual(detail.content, .gone)
    XCTAssertFalse(detail.refreshFailed)
    XCTAssertNil(detail.session)
    XCTAssertNil(detail.link)
    XCTAssertEqual(detail.shownID, "s1", "the panel stays open on the message")
  }

  func testAResultForAnotherTargetChangesNothing() {
    let (detail, _) = makeDetail()
    detail.show("s1", known: seed)
    let first = target("s1", 1)
    detail.close()
    detail.apply(AgentDetailUpdate(target: first, outcome: .loaded(session, history)))
    XCTAssertNil(detail.content, "closed")

    detail.show("s1", known: seed)
    detail.apply(AgentDetailUpdate(target: first, outcome: .failed))
    XCTAssertEqual(detail.content, .loading(seed), "reopened: an old failure does not land")
    detail.apply(AgentDetailUpdate(target: first, outcome: .gone))
    XCTAssertEqual(detail.content, .loading(seed))
    XCTAssertFalse(detail.refreshFailed)

    detail.show("s2", known: nil)
    detail.apply(AgentDetailUpdate(target: target("s1", 2), outcome: .loaded(session, history)))
    XCTAssertEqual(detail.content, .loading(nil), "replaced")
  }

  func testResetClearsEverythingAndALateResultDoesNotLand() {
    let (detail, reads) = makeDetail()
    detail.show("s1", known: seed)
    detail.reset()
    XCTAssertNil(detail.shownID)
    XCTAssertNil(detail.content)
    XCTAssertEqual(reads.hideCalls, 1)
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    XCTAssertNil(detail.content)
  }

  // MARK: The link

  func testOpenLinkOpensOnlyAnAbsoluteWebLink() {
    let cases: [(Any, URL?)] = [
      ("https://example.com/pr/1", URL(string: "https://example.com/pr/1")),
      ("http://localhost:8080/x", URL(string: "http://localhost:8080/x")),
      (NSNull(), nil),
      ("/relative/path", nil),
      ("file:///etc/passwd", nil),
      ("javascript:alert(1)", nil),
      ("not a url", nil),
    ]
    for (value, expected) in cases {
      let (detail, _) = makeDetail()
      var opened: [URL] = []
      detail.opener = { opened.append($0) }
      let linked = Fixtures.session("s1", ["link": value])
      detail.show("s1", known: linked)
      XCTAssertEqual(detail.openLink(), expected != nil, "\(value)")
      XCTAssertEqual(opened, expected.map { [$0] } ?? [], "\(value)")
      XCTAssertEqual(
        AgentDetailModel(session: linked, history: [], decisions: [], now: now).link, expected, "\(value)")
    }
  }

  func testNoCallButOpenLinkReachesTheOpener() {
    let (detail, _) = makeDetail()
    var opened = 0
    detail.opener = { _ in opened += 1 }
    detail.show("s1", known: Fixtures.session("s1"))
    detail.apply(AgentDetailUpdate(target: target(), outcome: .loaded(session, history)))
    detail.apply(AgentDetailUpdate(target: target(), outcome: .failed))
    detail.retry()
    detail.toggle("s2", known: nil)
    detail.toggle("s2", known: nil)
    detail.reset()
    XCTAssertEqual(opened, 0)
  }

  func testTheAppOpensABrowserInOnePlace() throws {
    let app = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("AgentDesk")
    let names = try FileManager.default.contentsOfDirectory(atPath: app.path).filter {
      $0.hasSuffix(".swift")
    }
    XCTAssertFalse(names.isEmpty)
    var openers: [String] = []
    for name in names {
      let text = try String(contentsOf: app.appendingPathComponent(name), encoding: .utf8)
      for line in text.split(separator: "\n") where line.contains("NSWorkspace.shared.open") {
        openers.append("\(name): \(line.trimmingCharacters(in: .whitespaces))")
      }
    }
    XCTAssertEqual(openers, ["AppState.swift: coordinator.agent.opener = { NSWorkspace.shared.open($0) }"])
  }

  // MARK: The model

  private func model(
    _ overrides: [String: Any] = [:], history: [StatusHistoryEntry]? = [], decisions: [Decision] = []
  ) -> AgentDetailModel {
    AgentDetailModel(
      session: Fixtures.session("s1", overrides), history: history, decisions: decisions, now: now)
  }

  func testEveryFieldOfAWorkingSession() {
    let m = model(
      [
        "line": "Running tests", "display_name": "Claude Code · web", "topic": "web",
        "status_at": "2026-10-27T12:00:00Z", "last_activity_at": "2026-10-27T12:09:30Z",
        "pending_decision_count": 2,
      ], history: history)
    XCTAssertEqual(m.state, "Working")
    XCTAssertFalse(m.isBlocked)
    XCTAssertEqual(m.updateAge, "10m ago", "from status_at, never last_activity_at")
    XCTAssertEqual(m.line, "Running tests")
    XCTAssertEqual(m.displayName, "Claude Code · web")
    XCTAssertEqual(m.topic, "web")
    XCTAssertNil(m.staleMarker)
    XCTAssertEqual(m.pendingCount, 2)
    XCTAssertEqual(m.pendingCountText, "2 pending decisions")
    XCTAssertEqual(m.statusAccessibilityLabel, "Working, 10m ago")
  }

  func testAFullStatusLineIsNotCut() {
    let line = String(repeating: "x", count: 200)
    XCTAssertEqual(model(["line": line]).line, line)
  }

  func testEachStateAndAStaleOrBlockedSessionReadsAsText() {
    XCTAssertEqual(model(["state": "waiting"]).state, "Waiting")
    XCTAssertEqual(model(["state": "done"]).state, "Done")
    let blocked = model(["state": "blocked", "stale": true, "status_at": "2026-10-27T12:09:00Z"])
    XCTAssertEqual(blocked.state, "Blocked")
    XCTAssertTrue(blocked.isBlocked)
    XCTAssertEqual(blocked.staleMarker, "Stale")
    XCTAssertEqual(blocked.statusAccessibilityLabel, "Blocked, 1m ago, Stale")
  }

  func testASessionWithNoStatusInventsNone() {
    let m = model(["state": NSNull(), "line": NSNull(), "status_at": NSNull(), "link": NSNull()])
    XCTAssertEqual(m.state, "No status yet")
    XCTAssertEqual(m.updateAge, "No update yet")
    XCTAssertNil(m.line)
    XCTAssertNil(m.link)
    XCTAssertEqual(m.history, [], "the current status is never appended")
  }

  func testTheCountComesFromTheSessionAndTheListFromTheSnapshot() {
    let mine = Fixtures.pending(
      "mine", ["title": "Mine?", "agent_session_id": "s1", "created_at": "2026-10-27T12:05:00Z"])
    let urgent = Fixtures.pending(
      "urgent", priority: "urgent", deadline: "2026-10-27T12:12:00Z", ["title": "Now?", "agent_session_id": "s1"])
    let other = Fixtures.pending("other", ["agent_session_id": "s2"])
    let none = Fixtures.pending("none")
    let settled = Fixtures.pending(
      "settled",
      ["agent_session_id": "s1", "state": "answered", "answer": ["kind": "approve"], "answered_via": "app"])
    let m = model(["pending_decision_count": 5], decisions: [mine, urgent, other, none, settled])
    XCTAssertEqual(m.pendingCount, 5)
    XCTAssertEqual(m.pendingCountText, "5 pending decisions")
    XCTAssertEqual(m.pending.map(\.id), ["mine", "urgent"], "this session's pending decisions, in list order")
    XCTAssertEqual(m.pending[0].title, "Mine?")
    XCTAssertEqual(m.pending[0].age, "5m ago")
    XCTAssertNil(m.pending[0].timeLeft)
    XCTAssertFalse(m.pending[0].timeLeftIsRed)
    XCTAssertEqual(m.pending[1].urgentMarker, "Urgent")
    XCTAssertEqual(m.pending[1].timeLeft, "2m left")
    XCTAssertTrue(m.pending[1].timeLeftIsRed)
    XCTAssertEqual(m.pending[1].accessibilityValue, "Urgent, 2m left, 10m ago")
    XCTAssertEqual(model(["pending_decision_count": 1]).pendingCountText, "1 pending decision")
    XCTAssertEqual(model(["pending_decision_count": 0]).pending, [])
  }

  func testHistoryKeepsTheServersOrderAndItsLinksAreText() {
    let entries = [
      StatusHistoryEntry(
        state: .blocked, line: "see https://example.com/a", link: "https://example.com/a",
        at: Fixtures.instant("2026-10-27T12:08:00Z")),
      StatusHistoryEntry(state: .working, line: "older", at: Fixtures.instant("2026-10-27T09:10:00Z")),
      StatusHistoryEntry(state: .done, line: "out of order", at: Fixtures.instant("2026-10-27T12:09:00Z")),
    ]
    let m = model(history: entries)
    XCTAssertEqual(m.history?.map(\.line), ["see https://example.com/a", "older", "out of order"])
    XCTAssertEqual(m.history?.map(\.state), ["Blocked", "Working", "Done"])
    XCTAssertEqual(m.history?.map(\.age), ["2m ago", "3h ago", "1m ago"])
    XCTAssertEqual(m.history?.map(\.id), [0, 1, 2], "two equal rows keep distinct ids")
    XCTAssertEqual(m.history?[0].link, "https://example.com/a", "a String: nothing can open it")
  }

  func testHistoryIsNilBeforeTheFirstReadAndEmptyAfterAnEmptyOne() {
    XCTAssertNil(model(history: nil).history)
    XCTAssertEqual(model(history: []).history, [])
  }
}
