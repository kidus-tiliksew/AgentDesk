import Foundation
import XCTest

@testable import AgentDeskKit

/// The agents line and its list (component-mac-app §Agents line;
/// req-mac-app REQ-5).
final class AgentSessionOrderTests: XCTestCase {
  private let now = Fixtures.instant("2026-10-27T12:10:00Z")

  private let mixed = [
    Fixtures.session("work1", ["state": "working"]),
    Fixtures.session("wait1", ["state": "waiting"]),
    Fixtures.session("stale1", ["state": "working", "stale": true]),
    Fixtures.session("block1", ["state": "blocked"]),
    Fixtures.session("work2", ["state": "working"]),
    Fixtures.session("none", ["state": NSNull()]),
    Fixtures.session("block2", ["state": "blocked", "stale": true]),
    Fixtures.session("stale2", ["state": NSNull(), "stale": true]),
  ]

  func testEachSessionIsInOneGroupWithBlockedBeforeStale() {
    let group = { (id: String) in AgentSessionOrder.group(self.mixed.first { $0.id == id }!) }
    XCTAssertEqual(group("block1"), .blocked)
    XCTAssertEqual(group("block2"), .blocked, "a stale blocked session stays blocked")
    XCTAssertEqual(group("stale1"), .quiet)
    XCTAssertEqual(group("stale2"), .quiet)
    XCTAssertEqual(group("work1"), .active)
    XCTAssertEqual(group("wait1"), .active)
    XCTAssertEqual(group("none"), .active, "a session with no state is active")

    let summary = AgentsSummary(agents: mixed)
    XCTAssertEqual(summary.active, 4)
    XCTAssertEqual(summary.quiet, 2)
    XCTAssertEqual(summary.blocked, 2)
    XCTAssertEqual(summary.total, mixed.count, "the groups do not overlap")
  }

  func testListShowsBlockedThenActiveInApiOrderAndNoQuiet() {
    XCTAssertEqual(
      AgentSessionOrder.listed(mixed).map(\.id),
      ["block1", "block2", "work1", "wait1", "work2", "none"])
  }

  func testQuietSessionsAreMostRecentFirstWithApiOrderBreakingATie() {
    let quiet = [
      Fixtures.session("old", ["stale": true, "last_activity_at": "2026-10-27T09:00:00Z"]),
      Fixtures.session("tieA", ["stale": true, "last_activity_at": "2026-10-27T11:00:00Z"]),
      Fixtures.session("blocked", ["state": "blocked", "stale": true, "last_activity_at": "2026-10-27T12:00:00Z"]),
      Fixtures.session("recent", ["stale": true, "last_activity_at": "2026-10-27T11:30:00Z"]),
      Fixtures.session("tieB", ["stale": true, "last_activity_at": "2026-10-27T11:00:00Z"]),
      Fixtures.session("live", ["last_activity_at": "2026-10-27T12:05:00Z"]),
    ]
    XCTAssertEqual(AgentSessionOrder.quiet(quiet).map(\.id), ["recent", "tieA", "tieB", "old"])
  }

  func testLineLeavesOutZeroGroupsExceptActive() {
    let blocked = Fixtures.session("a", ["state": "blocked"])
    let quiet = Fixtures.session("b", ["stale": true])
    let active = Fixtures.session("c", ["state": "working"])

    XCTAssertEqual(AgentsSummary(agents: [active, quiet, blocked]).text, "1 active · 1 quiet · 1 blocked")
    XCTAssertEqual(AgentsSummary(agents: [active]).text, "1 active")
    XCTAssertEqual(AgentsSummary(agents: [active, quiet]).text, "1 active · 1 quiet")
    XCTAssertEqual(AgentsSummary(agents: [active, blocked]).text, "1 active · 1 blocked")
    XCTAssertEqual(AgentsSummary(agents: [quiet]).text, "0 active · 1 quiet")
    XCTAssertEqual(AgentsSummary(agents: []).text, "0 active")

    XCTAssertEqual(AgentsSummary(agents: [active, blocked]).blockedText, " · 1 blocked")
    XCTAssertNil(AgentsSummary(agents: [active]).blockedText)
    XCTAssertEqual(
      AgentsSummary(agents: [active, quiet, blocked]).accessibilityLabel, "1 active, 1 quiet, 1 blocked")
    XCTAssertEqual(AgentsSummary(agents: [active, quiet, quiet]).showQuietText, "Show 2 quiet")
  }

  func testQuietTimeIsFlooredInMinutesHoursAndDays() {
    func text(_ seconds: TimeInterval) -> String {
      AgentSessionOrder.quietText(since: now.addingTimeInterval(-seconds), now: now)
    }
    XCTAssertEqual(text(0), "quiet 0m")
    XCTAssertEqual(text(59), "quiet 0m")
    XCTAssertEqual(text(44 * 60), "quiet 44m")
    XCTAssertEqual(text(59 * 60 + 59), "quiet 59m")
    XCTAssertEqual(text(60 * 60), "quiet 1h")
    XCTAssertEqual(text(3 * 3600 + 59 * 60), "quiet 3h")
    XCTAssertEqual(text(24 * 3600 - 1), "quiet 23h")
    XCTAssertEqual(text(24 * 3600), "quiet 1d")
    XCTAssertEqual(text(2 * 86400 + 86399), "quiet 2d")
    XCTAssertEqual(text(-90), "quiet 0m", "a clock behind the server never reads negative")
  }

  func testEntryShowsStateOrQuietTime() {
    let working = AgentEntryModel(session: Fixtures.session("a", ["state": "waiting"]), now: now)
    XCTAssertEqual(working.stateText, "waiting")
    let stale = AgentEntryModel(
      session: Fixtures.session("b", ["stale": true, "last_activity_at": "2026-10-27T11:57:30Z"]), now: now)
    XCTAssertEqual(stale.stateText, "quiet 12m")
    XCTAssertEqual(stale.line, "Running tests")
    XCTAssertEqual(stale.accessibilityLabel, "Claude Code · web, quiet 12m, Running tests")
    let hours = AgentEntryModel(
      session: Fixtures.session("c", ["stale": true, "last_activity_at": "2026-10-27T09:05:00Z"]), now: now)
    XCTAssertEqual(hours.stateText, "quiet 3h", "time comes from last activity, not the status time")
    let staleBlocked = AgentEntryModel(
      session: Fixtures.session(
        "d", ["state": "blocked", "stale": true, "last_activity_at": "2026-10-27T09:05:00Z"]), now: now)
    XCTAssertEqual(staleBlocked.stateText, "blocked", "a stale blocked session reads blocked")
    XCTAssertEqual(staleBlocked.dot, .red)
  }

  func testShortNameIsTheTopicsLastSegmentOnlyForTheDefaultForm() {
    func short(_ name: String, topic: String) -> String {
      AgentSessionOrder.shortName(Fixtures.session("a", ["display_name": name, "topic": topic]))
    }
    XCTAssertEqual(short("Claude Code · web", topic: "web"), "web", "an unnested topic")
    XCTAssertEqual(short("Claude Code · api/migrations", topic: "api/migrations"), "migrations", "a nested topic")
    XCTAssertEqual(short("Codex · a/b/c", topic: "a/b/c"), "c", "the text after the last slash")
    XCTAssertEqual(short("Release captain", topic: "web"), "Release captain", "a custom name")
    XCTAssertEqual(short("Claude Code · web", topic: ""), "Claude Code · web", "an empty topic")
    XCTAssertEqual(short("Claude Code · web/", topic: "web/"), "Claude Code · web/", "a trailing slash leaves nothing")
    XCTAssertEqual(short("web", topic: "web"), "web", "the name without the separator")
    XCTAssertEqual(short("Fixing web", topic: "web"), "Fixing web", "a name that only ends with the topic")
    XCTAssertEqual(short("Claude Code · web", topic: "api"), "Claude Code · web", "a different topic")
  }

  func testEntryDrawsTheShortNameAndReadsTheFullNameAndStatusLine() {
    let entry = AgentEntryModel(
      session: Fixtures.session(
        "a", ["display_name": "Codex · api/migrations", "topic": "api/migrations", "line": "Running tests"]),
      now: now)
    XCTAssertEqual(entry.shortName, "migrations")
    XCTAssertEqual(entry.displayName, "Codex · api/migrations")
    XCTAssertEqual(entry.accessibilityLabel, "Codex · api/migrations, working, Running tests")
    let silent = AgentEntryModel(
      session: Fixtures.session("b", ["state": NSNull(), "line": NSNull()]), now: now)
    XCTAssertEqual(silent.stateText, "no status")
    XCTAssertEqual(silent.accessibilityLabel, "Claude Code · web, no status")
  }

  func testDotColorForEveryStateWithAndWithoutStale() {
    func dot(_ state: Any, stale: Bool) -> AgentDot {
      let session = Fixtures.session("a", ["state": state, "stale": stale])
      XCTAssertEqual(AgentEntryModel(session: session, now: now).dot, AgentSessionOrder.dot(session))
      return AgentSessionOrder.dot(session)
    }
    XCTAssertEqual(dot("working", stale: false), .green)
    XCTAssertEqual(dot("working", stale: true), .neutral)
    XCTAssertEqual(dot("waiting", stale: false), .amber)
    XCTAssertEqual(dot("waiting", stale: true), .neutral)
    XCTAssertEqual(dot("blocked", stale: false), .red)
    XCTAssertEqual(dot("blocked", stale: true), .red, "blocked wins over stale")
    XCTAssertEqual(dot("done", stale: false), .neutral)
    XCTAssertEqual(dot("done", stale: true), .neutral)
    XCTAssertEqual(dot(NSNull(), stale: false), .neutral, "a session with no state")
    XCTAssertEqual(dot(NSNull(), stale: true), .neutral)
  }

  func testOnlyWebLinksCountAsLinks() {
    func link(_ value: String) -> URL? { AgentEntryModel.webURL(value) }
    XCTAssertEqual(link("https://example.com/s/1"), URL(string: "https://example.com/s/1"))
    XCTAssertNotNil(link("http://localhost:8080/x"))
    XCTAssertNotNil(link("HTTPS://example.com"), "the scheme compares without case")
    XCTAssertNil(link("file:///etc/passwd"))
    XCTAssertNil(link("javascript:alert(1)"))
    XCTAssertNil(link("not a url"))
    XCTAssertNil(link("/relative/path"))
    XCTAssertNil(link("example.com/no-scheme"))
    XCTAssertNil(link("https://"), "no host")
  }
}
