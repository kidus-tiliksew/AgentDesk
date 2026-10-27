import Foundation
import XCTest

@testable import AgentDeskKit

/// The agents line and its list (component-mac-app §Agents line;
/// req-mac-app REQ-5).
final class AgentSessionOrderTests: XCTestCase {
  private let now = Fixtures.instant("2026-10-27T12:10:00Z")

  func testOrdersBlockedStaleWaitingWorkingAndKeepsApiOrderWithinAGroup() {
    let sessions = [
      Fixtures.session("work1", ["state": "working"]),
      Fixtures.session("wait1", ["state": "waiting"]),
      Fixtures.session("stale1", ["state": "working", "stale": true]),
      Fixtures.session("block1", ["state": "blocked"]),
      Fixtures.session("work2", ["state": "working"]),
      Fixtures.session("none", ["state": NSNull()]),
      Fixtures.session("block2", ["state": "blocked", "stale": true]),
      Fixtures.session("wait2", ["state": "waiting"]),
    ]
    XCTAssertEqual(
      AgentSessionOrder.sorted(sessions).map(\.id),
      ["block1", "block2", "stale1", "wait1", "wait2", "work1", "work2", "none"])
  }

  func testSummaryCountsRunningAndBlocked() {
    let sessions = [
      Fixtures.session("a", ["state": "blocked"]),
      Fixtures.session("b", ["state": "working"]),
    ]
    let summary = AgentsSummary(agents: sessions)
    XCTAssertEqual(summary.runningText, "2 agents running")
    XCTAssertEqual(summary.blockedText, " · 1 blocked")
    XCTAssertNil(AgentsSummary(agents: [sessions[1]]).blockedText)
    XCTAssertEqual(AgentsSummary(agents: [sessions[1]]).runningText, "1 agent running")
    XCTAssertEqual(AgentsSummary(agents: []).runningText, "0 agents running")
  }

  func testEntryShowsStateOrQuietMinutes() {
    let working = AgentEntryModel(session: Fixtures.session("a", ["state": "waiting"]), now: now)
    XCTAssertEqual(working.stateText, "waiting")
    let stale = AgentEntryModel(
      session: Fixtures.session("b", ["stale": true, "last_activity_at": "2026-10-27T11:57:30Z"]), now: now)
    XCTAssertEqual(stale.stateText, "quiet 12m")
    XCTAssertEqual(stale.line, "Running tests")
    XCTAssertEqual(stale.accessibilityLabel, "Claude Code · web, quiet 12m, Running tests")
  }

  func testOnlyWebLinksOpen() {
    func link(_ value: Any) -> URL? {
      AgentEntryModel(session: Fixtures.session("a", ["link": value]), now: now).link
    }
    XCTAssertEqual(link("https://example.com/s/1"), URL(string: "https://example.com/s/1"))
    XCTAssertNotNil(link("http://localhost:8080/x"))
    XCTAssertNil(link(NSNull()))
    XCTAssertNil(link("file:///etc/passwd"))
    XCTAssertNil(link("javascript:alert(1)"))
    XCTAssertNil(link("not a url"))
  }
}
