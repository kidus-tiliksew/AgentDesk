import Foundation
import XCTest

@testable import AgentDeskKit

/// The five posting conditions, removal, and the notification content
/// (component-mac-app §Notifications, §Verification; req-mac-app AC-6.1,
/// AC-6.2, AC-6.5, AC-6.7; req-notification-rules REQ-1, REQ-7, REQ-8).
final class NotificationPlannerTests: XCTestCase {
  private let created = Fixtures.instant("2026-10-27T12:00:00Z")

  private func decision(
    _ id: String = "dec_1", action: String? = "push", interactive: Bool = false,
    state: String = "pending", _ overrides: [String: Any] = [:]
  ) -> Decision {
    var fields: [String: Any] = [
      "notification_action": action.map { $0 as Any } ?? NSNull(), "interactive": interactive,
      "state": state,
    ]
    fields.merge(overrides) { $1 }
    return Fixtures.pending(id, fields)
  }

  private func at(_ seconds: TimeInterval) -> Date {
    created.addingTimeInterval(seconds)
  }

  /// Every condition holds unless the test changes one.
  private func context(
    _ seconds: TimeInterval = 30, open: Bool = false, allows: Bool = true,
    notified: Set<String> = [], posting: Set<String> = [], delivered: Set<String> = []
  ) -> NotificationPlanner.Context {
    NotificationPlanner.Context(
      now: at(seconds), isPopoverOpen: open, allowsPosting: allows, notified: notified,
      posting: posting, delivered: delivered)
  }

  private func posted(_ decisions: [Decision], _ context: NotificationPlanner.Context) -> [String] {
    NotificationPlanner.plan(pending: decisions, context: context).post.map(\.id)
  }

  // MARK: The five conditions

  func testAPushedPendingDecisionIsPostedWhenEveryConditionHolds() {
    XCTAssertEqual(posted([decision()], context()), ["dec_1"])
  }

  func testConditionOneOnlyPushPosts() {
    XCTAssertEqual(posted([decision(action: "push")], context()), ["dec_1"])
    XCTAssertEqual(posted([decision(action: "digest")], context()), [], "digest never posts")
    XCTAssertEqual(posted([decision(action: "mute")], context()), [], "mute never posts")
    XCTAssertEqual(posted([decision(action: nil)], context()), [], "unrouted never posts")
  }

  func testConditionTwoANotifiedOrPostingDecisionIsNotPostedAgain() {
    XCTAssertEqual(posted([decision()], context(notified: ["dec_1"])), [])
    XCTAssertEqual(posted([decision()], context(posting: ["dec_1"])), [])
  }

  func testRepeatedReadsPostOnceOnceTheIdIsStored() {
    let pending = [decision()]
    XCTAssertEqual(posted(pending, context(30)), ["dec_1"])
    XCTAssertEqual(posted(pending, context(45, notified: ["dec_1"])), [])
    XCTAssertEqual(posted(pending, context(60, notified: ["dec_1"])), [])
  }

  func testConditionThreeTheTenMinuteBoundary() {
    XCTAssertEqual(posted([decision()], context(600)), ["dec_1"], "exactly 10 minutes posts")
    XCTAssertEqual(posted([decision()], context(600.001)), [], "just over 10 minutes does not")
    XCTAssertEqual(posted([decision()], context(3600)), [])
  }

  func testStartAndSignInApplyTheSameAgeRule() {
    // The first read after starting or signing in carries an empty store;
    // only `created_at` decides, never when the app first saw the decision.
    let old = decision("dec_old", ["created_at": "2026-10-27T11:49:00Z"])
    let young = decision("dec_young", ["created_at": "2026-10-27T11:55:00Z"])
    XCTAssertEqual(posted([old, young], context(0, notified: [])), ["dec_young"])
  }

  func testConditionFourTheInteractiveHold() {
    let interactive = decision(interactive: true)
    XCTAssertEqual(posted([interactive], context(0)), [])
    XCTAssertEqual(posted([interactive], context(119.999)), [], "just under 2 minutes holds")
    XCTAssertEqual(posted([interactive], context(120)), ["dec_1"], "exactly 2 minutes posts")
    XCTAssertEqual(posted([interactive], context(600)), ["dec_1"])
    XCTAssertEqual(posted([interactive], context(600.001)), [])
    XCTAssertEqual(posted([decision(interactive: false)], context(0)), ["dec_1"], "no hold otherwise")
  }

  func testAnInteractiveDecisionStaysEligibleOnLaterReadsUntilItsHoldEnds() {
    let interactive = [decision(interactive: true)]
    XCTAssertEqual(posted(interactive, context(15)), [])
    XCTAssertEqual(posted(interactive, context(105)), [])
    XCTAssertEqual(posted(interactive, context(135)), ["dec_1"])
  }

  func testAnInteractiveDecisionSettledDuringItsHoldIsNeverPosted() {
    XCTAssertEqual(posted([decision(interactive: true)], context(60)), [])
    // The next read no longer lists it, so nothing posts after the hold.
    XCTAssertEqual(posted([], context(135)), [])
  }

  func testConditionFiveClosedOnAndNotPaused() {
    XCTAssertEqual(posted([decision()], context(open: true)), [], "no post while open")
    XCTAssertEqual(posted([decision()], context(allows: false)), [], "no post while off or paused")
  }

  func testOnlyPendingDecisionsArePosted() {
    let settled = decision("dec_2", state: "answered")
    XCTAssertEqual(posted([decision(), settled], context()), ["dec_1"])
  }

  // MARK: Open popover

  func testAnOpenPopoverMarksListedDecisionsWithoutAPost() {
    let plan = NotificationPlanner.plan(
      pending: [decision("dec_1"), decision("dec_2", action: "digest"), decision("dec_3")],
      context: context(open: true, notified: ["dec_3"]))
    XCTAssertEqual(plan.post, [])
    XCTAssertEqual(plan.markNotified, ["dec_1", "dec_2"])
  }

  func testADecisionMarkedWhileOpenStaysSuppressedAfterClose() {
    let pending = [decision()]
    let open = NotificationPlanner.plan(pending: pending, context: context(30, open: true))
    let notified = Set(open.markNotified)
    XCTAssertEqual(posted(pending, context(45, open: false, notified: notified)), [])
  }

  // MARK: Removal

  func testDeliveredNotificationsOfDecisionsNoLongerPendingAreRemoved() {
    let plan = NotificationPlanner.plan(
      pending: [decision("dec_1")],
      context: context(notified: ["dec_1"], delivered: ["dec_1", "dec_answered", "dec_expired"]))
    XCTAssertEqual(plan.remove, ["dec_answered", "dec_expired"])
  }

  func testRemovalRunsWhileOpenPausedOrOff() {
    for context in [context(open: true, delivered: ["dec_gone"]), context(allows: false, delivered: ["dec_gone"])] {
      XCTAssertEqual(NotificationPlanner.plan(pending: [], context: context).remove, ["dec_gone"])
    }
  }

  func testAReadListingASettledStateRemovesItsNotification() {
    let plan = NotificationPlanner.plan(
      pending: [decision(state: "cancelled")], context: context(delivered: ["dec_1"]))
    XCTAssertEqual(plan.remove, ["dec_1"])
  }

  // MARK: Content

  func testContentHoldsTheTitleAgentAndTimeLeft() {
    let withDeadline = decision(
      "dec_9", ["title": "Ship it?", "deadline": "2026-10-27T12:05:00Z", "input_type": "approve_reject"])
    let request = NotificationRequest(decision: withDeadline, agentName: "Claude Code · web", now: at(30))
    XCTAssertEqual(
      request,
      NotificationRequest(
        identifier: "dec_9", title: "Ship it?", body: "Claude Code · web · 4m left",
        categoryIdentifier: "decision.approve_reject", playsDefaultSound: true))
  }

  func testContentWithoutADeadlineAndOtherInputTypesHasNoCategory() {
    let choice = decision(
      "dec_2",
      [
        "title": "Which?", "input_type": "single_choice",
        "options": [["id": "a", "label": "A"], ["id": "b", "label": "B"]],
      ])
    let request = NotificationRequest(decision: choice, agentName: "Ended agent", now: at(30))
    XCTAssertEqual(request.body, "Ended agent")
    XCTAssertNil(request.categoryIdentifier)
    XCTAssertTrue(request.playsDefaultSound)
  }

  func testActionsMapToAnswersOnlyForApproveOrReject() {
    let approveReject = decision()
    XCTAssertEqual(NotificationRequest.answer(forAction: "approve", decision: approveReject), .approve)
    XCTAssertEqual(NotificationRequest.answer(forAction: "reject", decision: approveReject), .reject)
    XCTAssertNil(NotificationRequest.answer(forAction: "snooze", decision: approveReject))
    let text = decision("dec_1", ["input_type": "free_text"])
    XCTAssertNil(NotificationRequest.answer(forAction: "approve", decision: text))
  }

  // MARK: Click focus

  func testAClickOnAListedDecisionExpandsItAtOnce() {
    var focus = NotificationFocus()
    XCTAssertEqual(focus.request("dec_1", at: at(0), listed: ["dec_1"]), .expand("dec_1"))
    XCTAssertNil(focus.target)
  }

  func testAClickDuringARefreshWaitsForTheReadThatLandsAfterIt() {
    var focus = NotificationFocus()
    XCTAssertEqual(focus.request("dec_2", at: at(10), listed: ["dec_1"]), .wait)
    XCTAssertEqual(focus.resolve(fetchedAt: at(9), listed: ["dec_1"]), .wait, "an older read")
    XCTAssertEqual(focus.resolve(fetchedAt: at(11), listed: ["dec_1", "dec_2"]), .expand("dec_2"))
    XCTAssertEqual(focus.resolve(fetchedAt: at(12), listed: ["dec_2"]), .wait, "resolved once")
  }

  func testAStaleTargetExpandsNothing() {
    var focus = NotificationFocus()
    _ = focus.request("dec_gone", at: at(10), listed: ["dec_1"])
    XCTAssertEqual(focus.resolve(fetchedAt: at(11), listed: ["dec_1"]), .drop)
    XCTAssertNil(focus.target)
  }

  func testClearingDropsTheTarget() {
    var focus = NotificationFocus()
    _ = focus.request("dec_2", at: at(10), listed: [])
    focus.clear()
    XCTAssertEqual(focus.resolve(fetchedAt: at(11), listed: ["dec_2"]), .wait)
  }
}
