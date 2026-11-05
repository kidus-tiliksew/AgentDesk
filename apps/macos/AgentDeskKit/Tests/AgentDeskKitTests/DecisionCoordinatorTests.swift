import Foundation
import XCTest

@testable import AgentDeskKit

/// The list, the panel, the drafts, and the held answers together, through the
/// object `AppState` delegates to (component-mac-app §Pending answers;
/// req-mac-app AC-4.7, AC-4.8, AC-11.5).
@MainActor
final class DecisionCoordinatorTests: XCTestCase {
  private let listedOne = Fixtures.pending("listed", ["title": "Listed?"])
  private let linked = Fixtures.pending(
    "linked",
    [
      "title": "Linked?", "input_type": "free_text",
    ])
  private let settledLinked = Fixtures.pending(
    "linked", ["state": "answered", "answer": ["kind": "text", "text": "elsewhere"], "answered_via": "api"])
  private let notFound = APIError.response(status: 404, code: "not_found", message: "gone", field: nil)
  private let conflict = APIError.response(status: 409, code: "conflict", message: "settled", field: nil)

  private var sender: FakeSender!
  private var reader: FakeDecisionReader!
  private var clock: ManualClock!
  private var coordinator: DecisionCoordinator!

  override func setUp() async throws {
    sender = FakeSender()
    reader = FakeDecisionReader()
    clock = ManualClock()
    coordinator = DecisionCoordinator(sender: sender, reader: reader, clock: clock)
  }

  private var listedIDs: [String] { coordinator.listed.map(\.id) }

  private func settle() async {
    await Task.yield()
    try? await Task.sleep(nanoseconds: 20_000_000)
  }

  /// A pending decision absent from the list, opened through a link, with an
  /// answer and a note typed.
  private func openLinkedWithDraft() async {
    coordinator.applySnapshot([listedOne], isNewRead: true)
    reader.answer("linked", .success(linked))
    coordinator.show("linked")
    await eventually("the linked record") { self.coordinator.detail.decision == self.linked }
    coordinator.drafts["linked"]?.text = "ship it"
    coordinator.drafts["linked"]?.note = "after the soak"
  }

  /// `openLinkedWithDraft`, then Send: held, with the panel closed.
  private func holdLinked() async {
    await openLinkedWithDraft()
    coordinator.send("linked")
    XCTAssertNil(coordinator.detail.shownID, "answering closes the panel")
    XCTAssertEqual(listedIDs, ["listed"], "the held answer's row leaves")
  }

  /// `holdLinked`, then the send fails.
  private func failLinkedSend() async {
    await holdLinked()
    sender.answerPosts(.failure(.transport("offline")))
    coordinator.pending.flush()
    await eventually("the failure") { self.coordinator.pending.failures["linked"] != nil }
  }

  private func assertRecovered(file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(listedIDs.contains("linked"), "the row is back", file: file, line: line)
    XCTAssertEqual(
      coordinator.pending.failures["linked"], PendingAnswers.failureMessage, file: file, line: line)
    XCTAssertEqual(coordinator.drafts["linked"]?.text, "ship it", file: file, line: line)
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak", file: file, line: line)
  }

  // MARK: A failed send of a decision the list does not hold

  func testAFailedSendRestoresTheRowDraftAndMessageWithoutARead() async {
    await failLinkedSend()
    assertRecovered()
    XCTAssertEqual(sender.posts.count, 1)
    XCTAssertEqual(
      sender.posts, [FakeSender.Post(id: "linked", answer: .text("ship it"), note: "after the soak")])
  }

  func testAFailedListReadAndARepeatedPublishKeepTheRecovery() async {
    await failLinkedSend()
    // A failed decisions read publishes the last read again, with an agents
    // success or on the next tick.
    coordinator.applySnapshot([listedOne], isNewRead: false)
    coordinator.applySnapshot([listedOne], isNewRead: false)
    assertRecovered()
    XCTAssertEqual(reader.reads, ["linked"], "a repeated publish reads nothing")
    XCTAssertEqual(sender.posts.count, 1, "and posts nothing")
  }

  func testRetrySucceedsWithoutADuplicatePost() async {
    await failLinkedSend()
    coordinator.applySnapshot([listedOne], isNewRead: false)
    coordinator.send("linked")
    XCTAssertEqual(listedIDs, ["listed"], "the retry is held like any answer")
    XCTAssertNil(coordinator.pending.failures["linked"])
    coordinator.pending.flush()
    await eventually("the second post") { self.sender.posts.count == 2 }
    await eventually("the attempt's end") { self.coordinator.pending.sending.isEmpty }
    XCTAssertEqual(listedIDs, ["listed"])
    XCTAssertEqual(coordinator.retainedIDs, [], "a landed send drops the record")
    XCTAssertNil(coordinator.drafts["linked"])
    await settle()
    XCTAssertEqual(sender.posts.count, 2, "each attempt posts once")
  }

  func testAConflictOnRetryDropsTheRecordAndShowsTheOutcome() async {
    await failLinkedSend()
    sender.answerPosts(.failure(conflict))
    sender.answerReads(.success(settledLinked))
    coordinator.send("linked")
    coordinator.pending.flush()
    await eventually("the outcome") { self.coordinator.pending.outcome != nil }
    XCTAssertEqual(coordinator.pending.outcome, "Already answered through the API: elsewhere")
    XCTAssertEqual(listedIDs, ["listed"])
    XCTAssertEqual(coordinator.retainedIDs, [])
    XCTAssertNil(coordinator.drafts["linked"])
    XCTAssertNil(coordinator.pending.failures["linked"])
  }

  func testNotFoundDropsTheRecord() async {
    await holdLinked()
    sender.answerPosts(.failure(notFound))
    coordinator.pending.flush()
    await eventually("the attempt's end") { self.coordinator.pending.sending.isEmpty }
    XCTAssertEqual(coordinator.retainedIDs, [])
    XCTAssertEqual(listedIDs, ["listed"])
  }

  func testTheRestoredRowOpensTheRetainedRecordInThePanel() async {
    await failLinkedSend()
    coordinator.toggle("linked")
    XCTAssertEqual(coordinator.detail.shownID, "linked")
    XCTAssertEqual(coordinator.detail.decision, linked, "no read is needed to show it")
    XCTAssertTrue(coordinator.shownIsAnswerable)
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak")
  }

  // MARK: Evidence about a retained decision

  func testANewReadThatOmitsItChecksTheDecisionDirectly() async {
    await failLinkedSend()
    reader.answer("linked", .success(linked))
    let before = reader.reads.count
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await eventually("the direct read") { self.reader.reads.count == before + 1 }
    await settle()
    assertRecovered()
  }

  func testAFailedDirectReadKeepsTheRecovery() async {
    await failLinkedSend()
    reader.answer("linked", .failure(.transport("offline")))
    let before = reader.reads.count
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await eventually("the direct read") { self.reader.reads.count == before + 1 }
    await settle()
    assertRecovered()
  }

  func testADirectReadFindingItSettledClearsEverything() async {
    await failLinkedSend()
    reader.answer("linked", .success(settledLinked))
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await eventually("the record's end") { self.coordinator.retainedIDs.isEmpty }
    XCTAssertEqual(listedIDs, ["listed"], "a settled record never comes back")
    XCTAssertNil(coordinator.drafts["linked"])
    XCTAssertNil(coordinator.pending.failures["linked"])
  }

  func testADirectReadFindingItGoneClearsEverything() async {
    await failLinkedSend()
    reader.answer("linked", .failure(notFound))
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await eventually("the record's end") { self.coordinator.retainedIDs.isEmpty }
    XCTAssertNil(coordinator.drafts["linked"])
    XCTAssertNil(coordinator.pending.failures["linked"])
  }

  func testANewReadThatListsItTakesOverWithoutDuplicatingTheRow() async {
    await failLinkedSend()
    let before = reader.reads.count
    coordinator.applySnapshot([listedOne, linked], isNewRead: true)
    XCTAssertEqual(listedIDs.filter { $0 == "linked" }.count, 1)
    XCTAssertEqual(coordinator.retainedIDs, [])
    assertRecovered()
    await settle()
    XCTAssertEqual(reader.reads.count, before, "a listed decision needs no direct read")
  }

  func testAHeldAnswerIsNotCheckedDirectly() async {
    await holdLinked()
    let before = reader.reads.count
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await settle()
    XCTAssertEqual(reader.reads.count, before, "the answer resolves its own decision")
    XCTAssertEqual(coordinator.retainedIDs, ["linked"])
  }

  // MARK: Undo

  func testUndoRestoresTheRowDraftAndPanelWithoutAReadOrSend() async {
    await holdLinked()
    let reads = reader.reads.count
    let id = coordinator.undo()
    XCTAssertEqual(id, "linked")
    XCTAssertTrue(listedIDs.contains("linked"), "the row is back")
    XCTAssertEqual(coordinator.detail.shownID, "linked", "the panel reopens")
    XCTAssertEqual(coordinator.detail.decision, linked, "from the record it held")
    XCTAssertEqual(coordinator.drafts["linked"]?.text, "ship it")
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak")
    await settle()
    XCTAssertEqual(reader.reads.count, reads, "no read")
    XCTAssertEqual(sender.posts, [], "no send")
    coordinator.applySnapshot([listedOne], isNewRead: false)
    XCTAssertTrue(listedIDs.contains("linked"), "a repeated publish keeps it")
  }

  func testAReadDuringTheHoldDoesNotLoseUndo() async {
    await holdLinked()
    coordinator.applySnapshot([listedOne], isNewRead: true)
    coordinator.undo()
    XCTAssertTrue(listedIDs.contains("linked"))
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak")
  }

  // MARK: Decisions the panel only loaded

  func testALoadedPendingDecisionKeepsItsDraftAfterThePanelCloses() async {
    await openLinkedWithDraft()
    coordinator.detail.close()
    coordinator.applySnapshot([listedOne], isNewRead: false)
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak")
    XCTAssertTrue(listedIDs.contains("linked"), "its row stands until evidence resolves it")
    reader.answer("linked", .failure(.transport("offline")))
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await settle()
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak")
  }

  func testAShownDecisionThatSettlesLeavesNoRecord() async {
    reader.answer("linked", .success(linked), .success(settledLinked))
    coordinator.applySnapshot([listedOne], isNewRead: true)
    coordinator.show("linked")
    await eventually("the linked record") { self.coordinator.retainedIDs == ["linked"] }
    await eventually("the refresh timer") { self.clock.sleeping == 1 }
    clock.advance(by: DecisionDetail.refreshInterval)
    await eventually("the settled record") { self.coordinator.detail.decision == self.settledLinked }
    XCTAssertEqual(coordinator.retainedIDs, [])
    XCTAssertNil(coordinator.drafts["linked"])
    XCTAssertEqual(listedIDs, ["listed"])
    XCTAssertEqual(coordinator.detail.shownID, "linked", "the panel shows its outcome")
    XCTAssertFalse(coordinator.shownIsAnswerable)
  }

  func testAShownDecisionFoundMissingLeavesNoRecord() async {
    reader.answer("linked", .failure(notFound))
    coordinator.show("linked")
    await eventually("the answer") { self.coordinator.detail.content == .unavailable }
    XCTAssertEqual(coordinator.retainedIDs, [])
    XCTAssertEqual(listedIDs, [])
  }

  // MARK: Listed decisions

  func testAListedAnswerAndItsFailureNeedNoRetention() async {
    coordinator.applySnapshot([listedOne], isNewRead: true)
    reader.answer("listed", .success(listedOne))
    coordinator.toggle("listed")
    coordinator.send("listed")
    XCTAssertEqual(sender.posts, [], "approve-or-reject with no recommendation sends nothing")
    coordinator.answer("listed", .approve)
    XCTAssertNil(coordinator.detail.shownID)
    XCTAssertEqual(listedIDs, [])
    XCTAssertEqual(coordinator.retainedIDs, [])
    sender.answerPosts(.failure(.transport("offline")))
    coordinator.pending.flush()
    await eventually("the failure") { self.coordinator.pending.failures["listed"] != nil }
    XCTAssertEqual(listedIDs, ["listed"])
    XCTAssertEqual(coordinator.retainedIDs, [])
    coordinator.applySnapshot([], isNewRead: true)
    XCTAssertEqual(listedIDs, [], "a new read that omits a listed decision settles it")
    XCTAssertNil(coordinator.pending.failures["listed"])
  }

  func testAnAnswerToARowLeavesAnotherShownTarget() async {
    await openLinkedWithDraft()
    coordinator.answer("listed", .reject)
    XCTAssertEqual(coordinator.detail.shownID, "linked")
    XCTAssertEqual(coordinator.drafts["linked"]?.note, "after the soak")
    coordinator.undo()
    XCTAssertEqual(coordinator.detail.shownID, "linked", "Undo opens nothing new")
    XCTAssertEqual(listedIDs.sorted(), ["linked", "listed"])
  }

  func testReplacingTheTargetKeepsEachDraft() async {
    await openLinkedWithDraft()
    reader.answer("listed", .success(listedOne))
    coordinator.toggle("listed")
    XCTAssertEqual(coordinator.detail.shownID, "listed")
    XCTAssertEqual(coordinator.drafts["linked"]?.text, "ship it")
    coordinator.toggle("listed")
    XCTAssertNil(coordinator.detail.shownID)
    XCTAssertEqual(coordinator.drafts["linked"]?.text, "ship it")
  }

  func testASecondAnswerSendsTheHeldLinkedAnswerAndAFailureStillRecovers() async {
    await holdLinked()
    sender.answerPosts(.failure(.transport("offline")))
    coordinator.answer("listed", .approve)
    await eventually("the failure") { self.coordinator.pending.failures["linked"] != nil }
    assertRecovered()
    XCTAssertEqual(coordinator.pending.held?.decision.id, "listed")
  }

  // MARK: Account

  func testSignOutClearsEverythingAndALateDirectReadChangesNothing() async {
    await failLinkedSend()
    reader.answer("linked", .success(linked))
    let gate = reader.holdNextRead(of: "linked")
    let before = reader.reads.count
    coordinator.applySnapshot([listedOne], isNewRead: true)
    await eventually("the held read") { self.reader.reads.count == before + 1 }
    coordinator.reset()
    await gate.open()
    await settle()
    XCTAssertEqual(listedIDs, [])
    XCTAssertEqual(coordinator.retainedIDs, [])
    XCTAssertEqual(coordinator.drafts, [:])
    XCTAssertEqual(coordinator.pending.failures, [:])
    XCTAssertNil(coordinator.detail.shownID)
  }

  func testSignOutDuringALinkedSendDropsItsLateAnswer() async {
    await holdLinked()
    let gate = sender.holdNextPost()
    sender.answerPosts(.failure(.transport("offline")))
    coordinator.pending.flush()
    await eventually("the post") { self.sender.posts.count == 1 }
    coordinator.reset()
    await gate.open()
    await settle()
    XCTAssertEqual(listedIDs, [])
    XCTAssertEqual(coordinator.retainedIDs, [])
    XCTAssertEqual(coordinator.drafts, [:])
    XCTAssertEqual(coordinator.pending.failures, [:])
  }

  // MARK: The keys' view of the shown decision

  func testAHeldAnswerIsNotAnswerableAgain() async {
    await openLinkedWithDraft()
    XCTAssertTrue(coordinator.shownIsAnswerable)
    let held = coordinator.record("linked")
    XCTAssertEqual(held, linked)
    coordinator.send("linked")
    XCTAssertFalse(coordinator.shownIsAnswerable)
    XCTAssertNil(coordinator.record("linked"))
  }
}
