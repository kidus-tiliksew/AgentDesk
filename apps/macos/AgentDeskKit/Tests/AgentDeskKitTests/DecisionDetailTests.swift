import Foundation
import XCTest

@testable import AgentDeskKit

/// The panel's target and its reads on virtual time (req-mac-app AC-4.8,
/// AC-6.4, AC-11.5, AC-11.6, AC-11.7).
@MainActor
final class DecisionDetailTests: XCTestCase {
  private let pendingA = Fixtures.pending("a", ["title": "Ship it?"])
  private let pendingB = Fixtures.pending("b", ["title": "Delete it?"])
  private let settledA = Fixtures.pending(
    "a", ["state": "answered", "answer": ["kind": "reject"], "answered_via": "chat"])
  private let notFound = APIError.response(status: 404, code: "not_found", message: "gone", field: nil)

  private var reader: FakeDecisionReader!
  private var clock: ManualClock!
  private var detail: DecisionDetail!
  private var changes = 0

  override func setUp() async throws {
    reader = FakeDecisionReader()
    clock = ManualClock()
    detail = DecisionDetail(reader: reader, clock: clock)
    changes = 0
    detail.onChange = { [unowned self] in self.changes += 1 }
  }

  /// Waits until the loop sleeps between reads, so advancing the clock reaches it.
  private func sleeping(file: StaticString = #filePath, line: UInt = #line) async {
    await eventually("the refresh timer", file: file, line: line) { self.clock.sleeping == 1 }
  }

  private func settle() async {
    await Task.yield()
    try? await Task.sleep(nanoseconds: 20_000_000)
  }

  // MARK: Opening, replacing, closing

  func testOpeningShowsTheKnownRecordAndReadsAtOnce() async {
    reader.answer("a", .success(pendingA))
    detail.toggle("a", known: pendingA)
    XCTAssertEqual(detail.shownID, "a")
    XCTAssertEqual(detail.content, .loaded(pendingA), "no loading state for a listed decision")
    await sleeping()
    XCTAssertEqual(reader.reads, ["a"])
    XCTAssertEqual(clock.requests, [DecisionDetail.refreshInterval])
  }

  func testOpeningAnUnknownTargetLoadsIt() async {
    reader.answer("a", .success(pendingA))
    detail.show("a", known: nil)
    XCTAssertEqual(detail.content, .loading)
    await eventually("the load") { self.detail.content == .loaded(self.pendingA) }
  }

  func testOpeningTheShownTargetCloses() async {
    reader.answer("a", .success(pendingA))
    detail.toggle("a", known: pendingA)
    await sleeping()
    detail.toggle("a", known: pendingA)
    XCTAssertNil(detail.shownID)
    XCTAssertNil(detail.content)
    await eventually("the timer's end") { self.clock.sleeping == 0 }
  }

  func testAnotherTargetReplacesTheShownOne() async {
    reader.answer("a", .success(pendingA))
    reader.answer("b", .success(pendingB))
    detail.toggle("a", known: pendingA)
    await sleeping()
    detail.toggle("b", known: nil)
    XCTAssertEqual(detail.shownID, "b")
    XCTAssertEqual(detail.content, .loading)
    await eventually("the load") { self.detail.content == .loaded(self.pendingB) }
  }

  func testShowingTheShownTargetDoesNotReadAgain() async {
    reader.answer("a", .success(pendingA))
    detail.show("a", known: pendingA)
    await sleeping()
    detail.show("a", known: pendingA)
    await settle()
    XCTAssertEqual(reader.reads, ["a"])
  }

  // MARK: Settled targets

  func testADecisionSettledWhileShownChangesWithinTenSeconds() async {
    reader.answer("a", .success(pendingA), .success(settledA))
    detail.show("a", known: pendingA)
    await sleeping()
    XCTAssertEqual(detail.content, .loaded(pendingA))
    clock.advance(by: DecisionDetail.refreshInterval)
    await eventually("the settled record") { self.detail.content == .loaded(self.settledA) }
    XCTAssertEqual(detail.shownID, "a", "leaving the pending list never closes the target")
    XCTAssertLessThanOrEqual(DecisionDetail.refreshInterval, 10)
  }

  func testAnUnchangedReadPublishesNothing() async {
    reader.answer("a", .success(pendingA))
    detail.show("a", known: pendingA)
    await sleeping()
    let before = changes
    clock.advance(by: DecisionDetail.refreshInterval)
    await eventually("the second read") { self.reader.reads.count == 2 }
    await sleeping()
    XCTAssertEqual(changes, before)
  }

  // MARK: Failed reads

  func testAMissingTargetIsUnavailableAndReadingStops() async {
    reader.answer("a", .failure(notFound))
    detail.show("a", known: nil)
    await eventually("the answer") { self.detail.content == .unavailable }
    await settle()
    XCTAssertEqual(clock.sleeping, 0)
    XCTAssertEqual(reader.reads, ["a"])
  }

  func testATargetOfAnotherAccountIsUnavailable() async {
    reader.answer("a", .failure(.response(status: 403, code: "forbidden", message: "no", field: nil)))
    detail.show("a", known: nil)
    await eventually("the answer") { self.detail.content == .unavailable }
  }

  func testATransientFailureOffersRetryAndNeverPretendsItSettled() async {
    reader.answer("a", .failure(.transport("offline")), .success(pendingA))
    detail.show("a", known: nil)
    await eventually("the failure") { self.detail.content == .failed }
    detail.retry()
    XCTAssertEqual(detail.content, .loading)
    await eventually("the retry") { self.detail.content == .loaded(self.pendingA) }
  }

  func testAFailureKeepsTheLoadedRecordAndAReadRecovers() async {
    reader.answer("a", .failure(.transport("offline")), .success(pendingA))
    detail.show("a", known: pendingA)
    await eventually("the failure") { self.detail.refreshFailed }
    XCTAssertEqual(detail.content, .loaded(pendingA))
    await sleeping()
    clock.advance(by: DecisionDetail.refreshInterval)
    await eventually("the recovery") { !self.detail.refreshFailed }
    XCTAssertEqual(detail.content, .loaded(pendingA))
  }

  func testANonContract404IsTransient() async {
    reader.answer("a", .failure(.http(status: 404)))
    detail.show("a", known: nil)
    await eventually("the failure") { self.detail.content == .failed }
  }

  func testA401ChangesNothingAndStopsReading() async {
    reader.answer("a", .failure(.response(status: 401, code: "unauthenticated", message: "no", field: nil)))
    detail.show("a", known: pendingA)
    await eventually("the read") { self.reader.reads.count == 1 }
    await settle()
    XCTAssertEqual(detail.content, .loaded(pendingA))
    XCTAssertFalse(detail.refreshFailed)
    XCTAssertEqual(clock.sleeping, 0)
  }

  // MARK: Late responses

  func testALateResponseForAReplacedTargetChangesNothing() async {
    reader.answer("a", .success(pendingA))
    reader.answer("b", .success(pendingB))
    let gate = reader.holdNextRead(of: "a")
    detail.show("a", known: nil)
    await eventually("the held read") { self.reader.reads == ["a"] }
    detail.show("b", known: nil)
    await eventually("the new target") { self.detail.content == .loaded(self.pendingB) }
    await gate.open()
    await settle()
    XCTAssertEqual(detail.shownID, "b")
    XCTAssertEqual(detail.content, .loaded(pendingB))
  }

  func testALateResponseForAClosedPanelChangesNothing() async {
    reader.answer("a", .success(pendingA))
    let gate = reader.holdNextRead(of: "a")
    detail.show("a", known: nil)
    await eventually("the held read") { self.reader.reads == ["a"] }
    detail.close()
    await gate.open()
    await settle()
    XCTAssertNil(detail.shownID)
    XCTAssertNil(detail.content)
  }

  func testALateResponseAfterSignOutChangesNothing() async {
    reader.answer("a", .success(pendingA))
    let gate = reader.holdNextRead(of: "a")
    detail.show("a", known: nil)
    await eventually("the held read") { self.reader.reads == ["a"] }
    detail.reset()
    await gate.open()
    await settle()
    XCTAssertNil(detail.shownID)
    XCTAssertNil(detail.content)
    XCTAssertEqual(clock.sleeping, 0)
  }

  func testAReopenedTargetIgnoresTheEarlierOpeningsLateRead() async {
    reader.answer("a", .success(settledA))
    let gate = reader.holdNextRead(of: "a")
    detail.show("a", known: pendingA)
    await eventually("the held read") { self.reader.reads == ["a"] }
    detail.close()
    reader.answer("a", .success(pendingA))
    detail.show("a", known: pendingA)
    await eventually("the second read") { self.reader.reads.count == 2 }
    await gate.open()
    await settle()
    XCTAssertEqual(detail.content, .loaded(pendingA), "the old opening's answer is dropped")
  }

  // MARK: Answers

  func testAnAnswerClosesThePanelAndUndoReopensIt() async {
    reader.answer("a", .success(pendingA))
    detail.show("a", known: pendingA)
    await sleeping()
    detail.answerHeld("a")
    XCTAssertNil(detail.shownID)
    XCTAssertNil(detail.content)
    await eventually("the timer's end") { self.clock.sleeping == 0 }

    detail.answerUndone("a", known: pendingA)
    XCTAssertEqual(detail.shownID, "a")
    XCTAssertEqual(detail.content, .loaded(pendingA))
    await sleeping()
    XCTAssertEqual(reader.reads, ["a"], "Undo shows the record it held and reads nothing yet")
    clock.advance(by: DecisionDetail.refreshInterval)
    await eventually("the next refresh") { self.reader.reads.count == 2 }
  }

  func testAnAnswerToAnotherRowLeavesThePanel() async {
    reader.answer("a", .success(pendingA))
    detail.show("a", known: pendingA)
    await sleeping()
    detail.answerHeld("b")
    XCTAssertEqual(detail.shownID, "a")
    detail.answerUndone("b", known: pendingB)
    XCTAssertEqual(detail.shownID, "a", "undoing it opens nothing")
  }

  func testUndoAfterAClosedPanelOpensNothing() {
    detail.answerHeld("a")
    detail.answerUndone("a", known: pendingA)
    XCTAssertNil(detail.shownID)
  }

  // MARK: Notification targets

  func testANotificationTargetFoundSettledClosesInsteadOfShowing() async {
    reader.answer("a", .success(settledA))
    detail.show("a", known: pendingA, closesIfStale: true)
    await eventually("the close") { self.detail.shownID == nil }
    XCTAssertNil(detail.content)
    XCTAssertEqual(clock.sleeping, 0)
  }

  func testANotificationTargetFoundMissingCloses() async {
    reader.answer("a", .failure(notFound))
    detail.show("a", known: pendingA, closesIfStale: true)
    await eventually("the close") { self.detail.shownID == nil }
  }

  func testANotificationTargetThatSettlesAfterItsFirstReadStaysShown() async {
    reader.answer("a", .success(pendingA), .success(settledA))
    detail.show("a", known: pendingA, closesIfStale: true)
    await sleeping()
    clock.advance(by: DecisionDetail.refreshInterval)
    await eventually("the settled record") { self.detail.content == .loaded(self.settledA) }
    XCTAssertEqual(detail.shownID, "a")
  }
}

/// What the panel shows for one decision (req-mac-app AC-11.2, AC-11.6).
final class DecisionDetailModelTests: XCTestCase {
  private let now = Fixtures.instant("2026-10-27T12:00:00Z")

  private func model(
    _ fields: [String: Any], priority: String = "normal", deadline: String? = nil, titles: [String: String] = [:],
    agents: [AgentSession] = []
  ) -> DecisionDetailModel {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return DecisionDetailModel(
      decision: Fixtures.pending(
        "a", priority: priority, deadline: deadline, created: "2026-10-27T11:48:00Z", fields),
      agents: agents, titles: titles, now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
  }

  func testAPendingDecisionShowsEveryField() {
    let shown = model(
      [
        "title": "Ship the release?", "body": "**Soak** passed.", "topic": "deploy",
        "agent_session_id": "ags_1", "recommendation": ["kind": "approve"], "default": ["kind": "reject"],
        "parent_id": "p", "follow_up_ids": ["f1", "f2"],
      ], priority: "urgent", deadline: "2026-10-27T14:00:00Z", titles: ["p": "Run the soak?", "f2": "Tell the team?"],
      agents: [Fixtures.session("ags_1", ["display_name": "Claude Code · api"])])
    XCTAssertEqual(shown.title, "Ship the release?")
    XCTAssertEqual(shown.agentName, "Claude Code · api")
    XCTAssertEqual(shown.age, "12m ago")
    XCTAssertEqual(shown.body, "**Soak** passed.")
    XCTAssertEqual(shown.topic, "deploy")
    XCTAssertEqual(shown.urgentMarker, "Urgent")
    XCTAssertEqual(shown.recommendation, "Approve")
    XCTAssertEqual(shown.timeLeft, "2h left")
    XCTAssertTrue(shown.timeLeftIsRed, "an urgent decision's time left is red")
    XCTAssertTrue(shown.deadline?.contains("2:00") == true)
    XCTAssertTrue(shown.defaultAnswer?.hasSuffix("the agent goes with Reject.") == true)
    XCTAssertEqual(shown.parent, .init(id: "p", text: "Follow-up to Run the soak?"))
    XCTAssertEqual(
      shown.followUps,
      [.init(id: "f1", text: "Follow-up decision 1"), .init(id: "f2", text: "Tell the team?")])
    XCTAssertTrue(shown.isPending)
    XCTAssertNil(shown.outcome)
  }

  func testThePendingEmptyValuesAreSaid() {
    let shown = model([:])
    XCTAssertEqual(shown.deadline, "No deadline")
    XCTAssertEqual(shown.defaultAnswer, "No default")
    XCTAssertNil(shown.timeLeft)
    XCTAssertNil(shown.recommendation)
    XCTAssertNil(shown.urgentMarker)
    XCTAssertEqual(shown.agentName, DecisionPresentation.endedAgent)
    XCTAssertNil(shown.parent)
    XCTAssertEqual(shown.followUps, [])
  }

  func testAnEmptyBodyIsNoBody() {
    XCTAssertNil(model(["body": ""]).body)
  }

  func testAnUnknownParentReadsByItsRole() {
    XCTAssertEqual(model(["parent_id": "p"]).parent?.text, "Parent decision")
  }

  func testASettledDecisionShowsItsOutcomeAndNoCountdown() {
    let shown = model(
      [
        "state": "answered", "answer": ["kind": "approve"], "answered_via": "app",
        "answered_at": "2026-10-27T11:59:00Z", "recommendation": ["kind": "reject"],
      ], priority: "urgent", deadline: "2026-10-27T12:01:00Z")
    XCTAssertFalse(shown.isPending)
    XCTAssertEqual(shown.outcome?.summary, "Answered in the app: Approve")
    XCTAssertNil(shown.timeLeft)
    XCTAssertFalse(shown.timeLeftIsRed)
    XCTAssertEqual(shown.recommendation, "Reject", "the recommendation stays on a settled decision")
    XCTAssertNil(shown.defaultAnswer, "no default was set")
  }

  func testASettledDecisionOmitsWhatItNeverHad() {
    XCTAssertNil(model(["state": "cancelled"]).deadline)
  }
}
