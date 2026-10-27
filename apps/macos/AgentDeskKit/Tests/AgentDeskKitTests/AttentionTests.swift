import Foundation
import XCTest

@testable import AgentDeskKit

/// The menu bar dot and its summary (component-mac-app §Ordering and
/// attention, §Menu bar item; req-mac-app AC-3.1).
final class AttentionTests: XCTestCase {
  private let now = Fixtures.instant("2026-10-27T12:00:00Z")

  private func due(in seconds: TimeInterval, id: String = "dec_1") -> Decision {
    var decision = Fixtures.pending(id)
    decision.deadline = now.addingTimeInterval(seconds)
    return decision
  }

  func testNoDecisionsShowNoDot() {
    XCTAssertFalse(Attention.dot([], seen: [], now: now))
  }

  func testANewDecisionShowsTheDot() {
    let decision = Fixtures.pending("dec_1")
    XCTAssertTrue(Attention.dot([decision], seen: [], now: now))
    XCTAssertFalse(Attention.dot([decision], seen: ["dec_1"], now: now))
  }

  func testAnUrgentDecisionShowsTheDotEvenWhenSeen() {
    let decision = Fixtures.pending("dec_1", priority: "urgent")
    XCTAssertTrue(Attention.dot([decision], seen: ["dec_1"], now: now))
  }

  func testDeadlineBoundaryIsStrictlyUnder300Seconds() {
    XCTAssertTrue(Attention.dot([due(in: 299)], seen: ["dec_1"], now: now), "below 300 s")
    XCTAssertTrue(Attention.dot([due(in: 299.999)], seen: ["dec_1"], now: now), "just below 300 s")
    XCTAssertFalse(Attention.dot([due(in: 300)], seen: ["dec_1"], now: now), "at 300 s")
    XCTAssertFalse(Attention.dot([due(in: 301)], seen: ["dec_1"], now: now), "above 300 s")
  }

  func testAPassedDeadlineStillShowsTheDot() {
    XCTAssertTrue(Attention.dot([due(in: -10)], seen: ["dec_1"], now: now))
  }

  func testTheDotAppearsAsTimePassesWithoutARead() {
    let decision = due(in: 320)
    XCTAssertFalse(Attention.dot([decision], seen: ["dec_1"], now: now))
    let later = now.addingTimeInterval(Attention.recomputeInterval)
    XCTAssertTrue(Attention.dot([decision], seen: ["dec_1"], now: later))
  }

  func testOneQualifyingDecisionAmongSeenOnesShowsTheDot() {
    let seenCalm = Fixtures.pending("dec_1")
    let fresh = Fixtures.pending("dec_2")
    XCTAssertTrue(Attention.dot([seenCalm, fresh], seen: ["dec_1"], now: now))
    XCTAssertFalse(Attention.dot([seenCalm, fresh], seen: ["dec_1", "dec_2"], now: now))
  }

  // MARK: Summary

  func testSummaryDescribesCountNewAndUrgent() {
    let seen = Fixtures.pending("dec_1")
    let urgent = Fixtures.pending("dec_2", priority: "urgent")
    let summary = MenuBarSummary(decisions: [seen, urgent], seen: ["dec_1"], now: now)
    XCTAssertEqual(summary.count, 2)
    XCTAssertTrue(summary.dot)
    XCTAssertEqual(summary.accessibilityDescription, "AgentDesk, 2 waiting, new, urgent")

    let calm = MenuBarSummary(decisions: [seen], seen: ["dec_1"], now: now)
    XCTAssertEqual(calm.accessibilityDescription, "AgentDesk, 1 waiting")
    XCTAssertFalse(calm.dot)

    let empty = MenuBarSummary(decisions: [], seen: [], now: now)
    XCTAssertEqual(empty.accessibilityDescription, "AgentDesk, 0 waiting")
    XCTAssertEqual(empty.count, 0)
  }

  func testStyleDefaultsToDotAndPersists() {
    let defaults = makeDefaults()
    XCTAssertEqual(MenuBarStyle(defaults: defaults), .dot)
    MenuBarStyle.count.save(to: defaults)
    XCTAssertEqual(MenuBarStyle(defaults: defaults), .count)
    defaults.set("sparkle", forKey: MenuBarStyle.key)
    XCTAssertEqual(MenuBarStyle(defaults: defaults), .dot)
  }
}

/// The dot's single fade-in (req-mac-app AC-3.5).
final class DotPresenceTests: XCTestCase {
  func testFadesInOnceAndRefreshesChangeNothing() {
    var presence = DotPresence()
    XCTAssertEqual(presence.update(show: false, reduceMotion: false), .none)
    XCTAssertEqual(presence.update(show: true, reduceMotion: false), .fadeIn)
    XCTAssertEqual(presence.update(show: true, reduceMotion: false), .none, "a refresh does not fade again")
    XCTAssertEqual(presence.update(show: true, reduceMotion: false), .none)
    XCTAssertEqual(presence.update(show: false, reduceMotion: false), .hide)
    XCTAssertEqual(presence.update(show: true, reduceMotion: false), .fadeIn, "a new appearance fades")
  }

  func testReduceMotionAppearsAtOnce() {
    var presence = DotPresence()
    XCTAssertEqual(presence.update(show: true, reduceMotion: true), .appear)
    XCTAssertEqual(presence.update(show: true, reduceMotion: true), .none)
    XCTAssertTrue(presence.shown)
  }
}
