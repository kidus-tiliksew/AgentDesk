import Foundation
import XCTest

@testable import AgentDeskKit

/// Read-only row text and its VoiceOver reading (component-mac-app §Rows,
/// §Keyboard and accessibility; req-mac-app AC-4.2 to AC-4.4, AC-7.2).
final class DecisionPresentationTests: XCTestCase {
  private let now = Fixtures.instant("2026-10-27T12:00:00Z")
  private let agent = Fixtures.session("ags_1", ["display_name": "Claude Code · web"])

  private func row(_ decision: Decision, seen: Set<String> = []) -> DecisionRowModel {
    DecisionRowModel(decision: decision, agents: [agent], seen: seen, now: now)
  }

  func testAgentNameComesFromLiveSessionsWithEndedFallback() {
    let live = Fixtures.pending("a", ["agent_session_id": "ags_1"])
    let ended = Fixtures.pending("b", ["agent_session_id": "ags_gone"])
    let none = Fixtures.pending("c")
    XCTAssertEqual(row(live).agentName, "Claude Code · web")
    XCTAssertEqual(row(ended).agentName, "Ended agent")
    XCTAssertEqual(row(none).agentName, "Ended agent")
  }

  func testAge() {
    let created = Fixtures.instant("2026-10-27T12:00:00Z")
    XCTAssertEqual(DecisionPresentation.age(since: created, now: created.addingTimeInterval(59)), "just now")
    XCTAssertEqual(DecisionPresentation.age(since: created, now: created.addingTimeInterval(60)), "1m ago")
    XCTAssertEqual(DecisionPresentation.age(since: created, now: created.addingTimeInterval(3599)), "59m ago")
    XCTAssertEqual(DecisionPresentation.age(since: created, now: created.addingTimeInterval(7200)), "2h ago")
    XCTAssertEqual(DecisionPresentation.age(since: created, now: created.addingTimeInterval(3 * 86400)), "3d ago")
    XCTAssertEqual(DecisionPresentation.age(since: created, now: created.addingTimeInterval(-30)), "just now")
  }

  func testTimeLeft() {
    func left(_ seconds: TimeInterval) -> String {
      DecisionPresentation.timeLeft(until: now.addingTimeInterval(seconds), now: now)
    }
    XCTAssertEqual(left(0), "Deadline passed")
    XCTAssertEqual(left(-5), "Deadline passed")
    XCTAssertEqual(left(59), "Under 1m left")
    XCTAssertEqual(left(299), "4m left")
    XCTAssertEqual(left(3600), "1h left")
    XCTAssertEqual(left(3900), "1h 5m left")
    XCTAssertEqual(left(2 * 86400 + 60), "2d left")
  }

  func testTimeLeftIsRedOnlyUnderFiveMinutes() {
    var soon = Fixtures.pending("a")
    soon.deadline = now.addingTimeInterval(299)
    var later = Fixtures.pending("b")
    later.deadline = now.addingTimeInterval(300)
    XCTAssertTrue(row(soon).timeLeftIsRed)
    XCTAssertEqual(row(soon).timeLeft, "4m left")
    XCTAssertFalse(row(later).timeLeftIsRed)
    XCTAssertNil(row(Fixtures.pending("c")).timeLeft)
    XCTAssertFalse(row(Fixtures.pending("c", priority: "urgent")).timeLeftIsRed, "urgency is not red")
  }

  func testSuggestionResolvesOptionLabelsAndSkipsApproveReject() {
    let options: [[String: Any]] = [["id": "a", "label": "Ship"], ["id": "b", "label": "Wait"]]
    let single = Fixtures.pending(
      "s", ["input_type": "single_choice", "options": options, "recommendation": ["kind": "option", "option_id": "a"]])
    let multiple = Fixtures.pending(
      "m",
      ["input_type": "multiple_choice", "options": options, "recommendation": ["kind": "options", "option_ids": ["a", "b"]]])
    let text = Fixtures.pending("t", ["input_type": "free_text", "recommendation": ["kind": "text", "text": "Use Postgres"]])
    let unknown = Fixtures.pending(
      "u", ["input_type": "single_choice_or_text", "options": options, "recommendation": ["kind": "option", "option_id": "zz"]])
    let approve = Fixtures.pending("ar", ["recommendation": ["kind": "approve"]])
    let noRecommendation = Fixtures.pending("n", ["input_type": "free_text"])

    XCTAssertEqual(row(single).suggestion, "Suggests Ship")
    XCTAssertEqual(row(multiple).suggestion, "Suggests Ship, Wait")
    XCTAssertEqual(row(text).suggestion, "Suggests Use Postgres")
    XCTAssertEqual(row(unknown).suggestion, "Suggests zz")
    XCTAssertNil(row(approve).suggestion, "approve-or-reject rows show no suggestion")
    XCTAssertNil(row(noRecommendation).suggestion)
  }

  func testNewAndSeenWeights() {
    let decision = Fixtures.pending("a")
    XCTAssertTrue(row(decision).isNew)
    XCTAssertFalse(row(decision, seen: ["a"]).isNew)
  }

  func testAccessibilityReadsEveryState() {
    var decision = Fixtures.pending(
      "a",
      priority: "urgent",
      [
        "title": "Ship the release?", "agent_session_id": "ags_1", "input_type": "single_choice",
        "options": [["id": "a", "label": "Ship"]], "recommendation": ["kind": "option", "option_id": "a"],
      ])
    decision.deadline = now.addingTimeInterval(240)
    let model = row(decision)
    XCTAssertEqual(model.accessibilityLabel, "Ship the release?")
    XCTAssertEqual(model.accessibilityValue, "Claude Code · web, 4m left, new, urgent, suggests Ship")

    let calm = row(Fixtures.pending("b", ["agent_session_id": "ags_1"]), seen: ["b"])
    XCTAssertEqual(calm.accessibilityValue, "Claude Code · web")
  }
}
