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

  // MARK: Expanded row and strips

  func testDefaultSentenceNeedsADeadlineAndADefault() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let locale = Locale(identifier: "en_US_POSIX")
    let options: [[String: String]] = [["id": "a", "label": "Ship"], ["id": "b", "label": "Wait"]]
    let today = Fixtures.pending(
      "a",
      [
        "input_type": "single_choice", "options": options, "deadline": "2026-10-27T14:30:00Z",
        "default": ["kind": "option", "option_id": "b"],
      ])
    // Foundation puts a narrow no-break space before the day period.
    func sentence(_ decision: Decision) -> String? {
      DecisionPresentation.defaultSentence(for: decision, now: now, calendar: calendar, locale: locale)?
        .replacingOccurrences(of: "\u{202F}", with: " ")
    }
    XCTAssertEqual(sentence(today), "If nobody answers by 2:30 PM, the agent goes with Wait.")

    let tomorrow = Fixtures.pending(
      "b", ["deadline": "2026-10-28T09:05:00Z", "default": ["kind": "reject"]])
    XCTAssertEqual(sentence(tomorrow), "If nobody answers by Oct 28 at 9:05 AM, the agent goes with Reject.")

    let noDefault = Fixtures.pending("c", ["deadline": "2026-10-27T14:30:00Z"])
    let noDeadline = Fixtures.pending("d", ["default": ["kind": "approve"]])
    XCTAssertNil(DecisionPresentation.defaultSentence(for: noDefault, now: now))
    XCTAssertNil(DecisionPresentation.defaultSentence(for: noDeadline, now: now))
  }

  func testUndoTextNamesTheAnswerAndTitle() {
    let decision = Fixtures.pending(
      "a",
      [
        "title": "Ship it?", "input_type": "multiple_choice",
        "options": [["id": "x", "label": "Web"], ["id": "y", "label": "API"]],
      ])
    XCTAssertEqual(DecisionPresentation.undoText(.options(ids: ["x", "y"]), decision: decision), "Web, API · Ship it?")
  }

  func testRecordedOutcomeNamesWhatTheServerHolds() {
    func outcome(_ fields: [String: Any]) -> String? {
      DecisionPresentation.recordedOutcome(Fixtures.pending("a", fields))
    }
    XCTAssertNil(outcome([:]), "a pending decision has no recorded outcome")
    XCTAssertEqual(
      outcome(["state": "answered", "answer": ["kind": "approve"], "answered_via": "app"]),
      "Already answered in the app: Approve")
    XCTAssertEqual(
      outcome(["state": "answered", "answer": ["kind": "text", "text": "later"], "answered_via": "notification"]),
      "Already answered from a notification: later")
    XCTAssertEqual(
      outcome(["state": "answered", "answer": ["kind": "reject"], "answered_via": "api"]),
      "Already answered through the API: Reject")
    XCTAssertEqual(
      outcome(["state": "answered", "answer": ["kind": "reject"], "answered_via": "chat", "chat_message": "no"]),
      "Already answered in chat: Reject")
    XCTAssertEqual(outcome(["state": "answered", "answer": ["kind": "reject"]]), "Already answered: Reject")
    XCTAssertEqual(
      outcome(["state": "expired", "answer": ["kind": "approve"], "applied_by_default": true, "answered_via": "default"]),
      "Expired before your answer")
    XCTAssertEqual(outcome(["state": "cancelled"]), "Cancelled before your answer")
  }

  func testAgentLinkNeedsALiveSessionWithAWebLink() {
    let withLink = Fixtures.session("ags_1", ["link": "https://example.com/run/1"])
    let ftp = Fixtures.session("ags_2", ["link": "ftp://example.com/x"])
    let decision = Fixtures.pending("a", ["agent_session_id": "ags_1"])
    XCTAssertEqual(
      DecisionPresentation.agentLink(for: decision, agents: [withLink]), URL(string: "https://example.com/run/1"))
    XCTAssertNil(DecisionPresentation.agentLink(for: decision, agents: []), "an ended session has no link")
    XCTAssertNil(
      DecisionPresentation.agentLink(for: Fixtures.pending("b", ["agent_session_id": "ags_2"]), agents: [ftp]))
  }
}
