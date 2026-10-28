import Foundation
import XCTest

@testable import AgentDeskKit

/// `PendingAnswers` on virtual time with scripted server answers
/// (component-mac-app §Pending answers, §Verification; req-mac-app AC-4.8,
/// AC-4.9).
@MainActor
final class PendingAnswersTests: XCTestCase {
  private let first = Fixtures.pending("dec_1", ["title": "Ship it?"])
  private let second = Fixtures.pending("dec_2", ["title": "Delete the previews?"])
  private let approve = AnswerDraft.Submission(answer: .approve)

  private var sender: FakeSender!
  private var clock: ManualClock!
  private var pending: PendingAnswers!
  private var restored: [PendingAnswers.Attempt] = []

  override func setUp() async throws {
    sender = FakeSender()
    clock = ManualClock()
    pending = PendingAnswers(sender: sender, clock: clock)
    restored = []
    pending.onRestore = { [unowned self] in self.restored.append($0) }
  }

  private func conflict() -> APIError {
    .response(status: 409, code: "conflict", message: "The decision is not pending", field: nil)
  }

  private func settled(_ id: String, _ fields: [String: Any]) -> Decision {
    Fixtures.pending(id, fields)
  }

  /// Waits until the hold timer sleeps, so advancing the clock reaches it.
  private func holding(file: StaticString = #filePath, line: UInt = #line) async {
    await eventually("the hold timer", file: file, line: line) { self.clock.sleeping == 1 }
  }

  // MARK: Hold and undo

  func testAnswerHidesTheRowAndSendsAfterExactlyFourSeconds() async {
    XCTAssertTrue(pending.answer(first, approve))
    XCTAssertTrue(pending.hides("dec_1"))
    XCTAssertEqual(pending.undoText, "Approve · Ship it?")
    await holding()
    XCTAssertEqual(clock.requests, [PendingAnswers.holdDuration])

    clock.advance(by: 3.999)
    await Task.yield()
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(sender.posts, [], "nothing is sent before 4 seconds")
    XCTAssertNotNil(pending.held)

    clock.advance(by: 0.001)
    await eventually("the post") { self.sender.posts.count == 1 }
    XCTAssertEqual(sender.posts, [FakeSender.Post(id: "dec_1", answer: .approve, note: nil)])
    XCTAssertNil(pending.held)
    XCTAssertNil(pending.undoText)
    await eventually("the post to finish") { self.pending.sending.isEmpty }
    XCTAssertTrue(pending.hides("dec_1"), "a sent answer keeps its row hidden")
    XCTAssertTrue(pending.failures.isEmpty)
  }

  func testUndoRestoresTheRowAndDraftAndSendsNothing() async {
    var draft = AnswerDraft(decision: first)
    draft.isNoteOpen = true
    draft.note = "after the soak"
    pending.answer(first, AnswerDraft.Submission(answer: .reject, note: "after the soak"), draft: draft)
    await holding()

    let undone = pending.undo()
    XCTAssertEqual(undone?.draft, draft)
    XCTAssertEqual(undone?.decision.id, "dec_1")
    XCTAssertFalse(pending.hides("dec_1"))
    XCTAssertNil(pending.undoText)
    XCTAssertNil(pending.undo(), "a second undo finds nothing")

    clock.advance(by: 10)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(sender.posts, [])
    XCTAssertFalse(pending.hasUnsent)
  }

  func testSecondAnswerSendsTheFirstAndHoldsTheSecond() async {
    pending.answer(first, approve)
    pending.answer(second, AnswerDraft.Submission(answer: .reject))
    await eventually("the first post") { self.sender.posts.count == 1 }
    XCTAssertEqual(sender.posts.first?.id, "dec_1")
    XCTAssertEqual(pending.held?.decision.id, "dec_2")
    XCTAssertEqual(pending.undoText, "Reject · Delete the previews?")
    XCTAssertTrue(pending.hides("dec_1"))
    XCTAssertTrue(pending.hides("dec_2"))

    // The first timer was cancelled: only the second answer's timer remains.
    await holding()
    clock.advance(by: 4)
    await eventually("the second post") { self.sender.posts.count == 2 }
    XCTAssertEqual(sender.posts.map(\.id), ["dec_1", "dec_2"])
  }

  func testClosingThePopoverSendsTheHeldAnswerOnce() async {
    pending.answer(first, AnswerDraft.Submission(answer: .approve, note: "ok"))
    XCTAssertNotNil(pending.flush())
    XCTAssertNil(pending.flush(), "the second flush finds nothing held")
    await eventually("the post") { self.sender.posts.count == 1 }
    XCTAssertEqual(sender.posts, [FakeSender.Post(id: "dec_1", answer: .approve, note: "ok")])
    clock.advance(by: 10)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(sender.posts.count, 1, "the cancelled timer sends nothing")
  }

  func testOverlappingTriggersPostOnce() async {
    let gate = sender.holdNextPost()
    pending.answer(first, approve)
    await holding()
    // Timer, close, and quit all fire while the post is in flight.
    clock.advance(by: 4)
    pending.flush()
    let quit = Task { await self.pending.flushAndWait() }
    pending.flush()
    await eventually("the post") { self.sender.posts.count == 1 }
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(sender.posts.count, 1)
    XCTAssertTrue(pending.hides("dec_1"), "a sending answer keeps its row hidden")
    await gate.open()
    let delivered = await quit.value
    XCTAssertTrue(delivered)
    XCTAssertEqual(sender.posts.count, 1)
  }

  // MARK: Quit

  func testQuitWaitsForTheHeldAnswer() async {
    let gate = sender.holdNextPost()
    pending.answer(first, approve)
    XCTAssertTrue(pending.hasUnsent)
    let quit = Task { await self.pending.flushAndWait() }
    await eventually("the post") { self.sender.posts.count == 1 }
    XCTAssertTrue(pending.hasUnsent, "quitting waits while the post is in flight")
    await gate.open()
    let delivered = await quit.value
    XCTAssertTrue(delivered)
    XCTAssertFalse(pending.hasUnsent)
  }

  func testQuitReportsATransportFailureAndRestoresTheRow() async {
    sender.answerPosts(.failure(.transport("offline")))
    let draft = AnswerDraft(decision: first)
    pending.answer(first, approve, draft: draft)
    let delivered = await pending.flushAndWait()
    XCTAssertFalse(delivered)
    XCTAssertFalse(pending.hides("dec_1"))
    XCTAssertEqual(pending.failures["dec_1"], "Couldn't send. Try again.")
    XCTAssertEqual(restored.map(\.draft), [draft])
  }

  func testQuitWithNothingUnsentReturnsAtOnce() async {
    XCTAssertFalse(pending.hasUnsent)
    let delivered = await pending.flushAndWait()
    XCTAssertTrue(delivered)
    XCTAssertEqual(sender.posts, [])
  }

  func testQuitAcceptsAConflictAndANotFound() async {
    sender.answerPosts(.failure(conflict()), .failure(.response(status: 404, code: "not_found", message: "", field: nil)))
    sender.answerReads(.success(settled("dec_1", ["state": "cancelled"])))
    pending.answer(first, approve)
    pending.answer(second, approve)
    let delivered = await pending.flushAndWait()
    XCTAssertTrue(delivered)
    XCTAssertTrue(pending.failures.isEmpty)
  }

  // MARK: Server answers

  func testConflictShowsTheRecordedOutcomeForFourSecondsAndDiscardsTheAttempt() async {
    sender.answerPosts(.failure(conflict()))
    sender.answerReads(
      .success(
        settled(
          "dec_1",
          ["state": "answered", "answer": ["kind": "reject"], "answered_via": "chat", "chat_message": "no"])))
    pending.answer(first, approve)
    pending.flush()
    await eventually("the outcome") { self.pending.outcome != nil }
    XCTAssertEqual(pending.outcome, "Already answered in chat: Reject")
    XCTAssertEqual(sender.posts.count, 1, "the attempted answer is discarded, never retried")
    XCTAssertEqual(sender.reads, ["dec_1"])
    XCTAssertTrue(pending.hides("dec_1"))
    XCTAssertTrue(pending.failures.isEmpty)
    XCTAssertTrue(restored.isEmpty)

    await eventually("the outcome timer") { self.clock.sleeping == 1 }
    clock.advance(by: 3.9)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertNotNil(pending.outcome)
    clock.advance(by: 0.1)
    await eventually("the outcome to clear") { self.pending.outcome == nil }
  }

  func testConflictNamesAnExpiredOrCancelledDecision() async {
    sender.answerPosts(.failure(conflict()), .failure(conflict()))
    sender.answerReads(
      .success(settled("dec_1", ["state": "expired"])),
      .success(settled("dec_2", ["state": "cancelled"])))
    pending.answer(first, approve)
    pending.flush()
    await eventually("the first outcome") { self.pending.outcome == "Expired before your answer" }
    pending.answer(second, approve)
    pending.flush()
    await eventually("the second outcome") { self.pending.outcome == "Cancelled before your answer" }
  }

  func testConflictWhoseReadFailsShowsAnHonestStripWithoutRetrying() async {
    sender.answerPosts(.failure(conflict()))
    sender.answerReads(.failure(.transport("offline")))
    pending.answer(first, approve)
    let delivered = await pending.flushAndWait()
    XCTAssertTrue(delivered, "the server refused the answer, so there is nothing to keep")
    XCTAssertEqual(pending.outcome, "Settled elsewhere. Couldn't read the outcome.")
    XCTAssertEqual(sender.posts.count, 1)
    XCTAssertTrue(pending.hides("dec_1"))
    XCTAssertTrue(restored.isEmpty)
  }

  func testConflictOnAStillPendingDecisionRestoresTheRow() async {
    sender.answerPosts(.failure(conflict()))
    sender.answerReads(.success(first))
    pending.answer(first, approve)
    _ = await pending.flushAndWait()
    XCTAssertNil(pending.outcome, "a pending decision has no recorded outcome to show")
    XCTAssertFalse(pending.hides("dec_1"))
    XCTAssertEqual(pending.failures["dec_1"], PendingAnswers.failureMessage)
  }

  func testConflictWhoseDecisionIsGoneDropsTheRow() async {
    sender.answerPosts(.failure(conflict()))
    sender.answerReads(.failure(.response(status: 404, code: "not_found", message: "", field: nil)))
    pending.answer(first, approve)
    _ = await pending.flushAndWait()
    XCTAssertNil(pending.outcome)
    XCTAssertTrue(pending.hides("dec_1"))
  }

  func testNotFoundDropsTheRow() async {
    sender.answerPosts(.failure(.response(status: 404, code: "not_found", message: "", field: nil)))
    pending.answer(first, approve)
    let delivered = await pending.flushAndWait()
    XCTAssertTrue(delivered)
    XCTAssertTrue(pending.hides("dec_1"))
    XCTAssertTrue(pending.failures.isEmpty)
    XCTAssertNil(pending.outcome)
    XCTAssertEqual(sender.reads, [])
  }

  func testTransportFailureRestoresTheRowWithItsDraft() async {
    sender.answerPosts(.failure(.transport("offline")))
    var draft = AnswerDraft(decision: first)
    draft.isNoteOpen = true
    draft.note = "keep this"
    pending.answer(first, approve, draft: draft)
    pending.flush()
    await eventually("the failure") { !self.pending.failures.isEmpty }
    XCTAssertFalse(pending.hides("dec_1"))
    XCTAssertEqual(pending.failures, ["dec_1": "Couldn't send. Try again."])
    XCTAssertEqual(restored.first?.draft?.note, "keep this")

    // A read that still lists the decision keeps the message; answering
    // again clears it.
    pending.reconcile(pending: ["dec_1"])
    XCTAssertEqual(pending.failures["dec_1"], PendingAnswers.failureMessage)
    pending.answer(first, approve)
    XCTAssertNil(pending.failures["dec_1"])
  }

  func testAFailureMessageLeavesWithItsDecision() async {
    sender.answerPosts(.failure(.response(status: 500, code: "internal", message: "", field: nil)))
    pending.answer(first, approve)
    _ = await pending.flushAndWait()
    XCTAssertEqual(pending.failures["dec_1"], PendingAnswers.failureMessage)
    pending.reconcile(pending: [])
    XCTAssertTrue(pending.failures.isEmpty)
  }

  func testUnauthorizedRestoresNothing() async {
    sender.answerPosts(.failure(.response(status: 401, code: "unauthenticated", message: "", field: nil)))
    pending.answer(first, approve)
    let delivered = await pending.flushAndWait()
    XCTAssertTrue(delivered)
    XCTAssertTrue(pending.failures.isEmpty)
    XCTAssertTrue(restored.isEmpty)
  }

  // MARK: Sync and accounts

  func testAReadTakenBeforeTheAnswerLandedDoesNotBringTheRowBack() async {
    pending.answer(first, approve)
    _ = await pending.flushAndWait()
    // A poll that started before the post still lists the decision.
    pending.reconcile(pending: ["dec_1", "dec_2"])
    XCTAssertTrue(pending.hides("dec_1"))
    // The next read leaves it out, so the record is dropped.
    pending.reconcile(pending: ["dec_2"])
    XCTAssertFalse(pending.hides("dec_1"))
  }

  func testAHeldAnswerKeepsItsRowHiddenThroughAnyRead() async {
    pending.answer(first, approve)
    pending.reconcile(pending: ["dec_1"])
    XCTAssertTrue(pending.hides("dec_1"))
    pending.reconcile(pending: [])
    XCTAssertTrue(pending.hides("dec_1"))
  }

  func testAnsweringAHiddenDecisionHoldsNothing() async {
    pending.answer(first, approve)
    XCTAssertFalse(pending.answer(first, AnswerDraft.Submission(answer: .reject)))
    XCTAssertEqual(pending.held?.submission.answer, .approve)
  }

  func testSignOutDropsHeldAndLateAnswers() async {
    let gate = sender.holdNextPost()
    sender.answerPosts(.failure(.transport("offline")))
    pending.answer(first, approve)
    let inFlight = pending.flush()
    await eventually("the post") { self.sender.posts.count == 1 }
    pending.answer(second, approve)
    await holding()

    pending.reset()
    XCTAssertNil(pending.held)
    XCTAssertFalse(pending.hasUnsent)
    XCTAssertFalse(pending.hides("dec_1"))
    XCTAssertFalse(pending.hides("dec_2"))

    await gate.open()
    _ = await inFlight?.value
    clock.advance(by: 10)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(sender.posts.map(\.id), ["dec_1"], "the reset hold never posts")
    XCTAssertTrue(pending.failures.isEmpty, "a late failure for the old account changes nothing")
    XCTAssertTrue(restored.isEmpty)
  }

  func testChangesAreReported() async {
    var changes = 0
    pending.onChange = { changes += 1 }
    pending.answer(first, approve)
    XCTAssertGreaterThan(changes, 0)
    let before = changes
    pending.undo()
    XCTAssertGreaterThan(changes, before)
  }

  // MARK: Notification actions

  func testSendNowPostsAtOnceWithoutTheHold() async {
    XCTAssertTrue(pending.sendNow(first, approve))
    XCTAssertNil(pending.held, "no Undo hold")
    XCTAssertNil(pending.undoText)
    await eventually("the post") { self.sender.posts.count == 1 }
    XCTAssertEqual(sender.posts, [FakeSender.Post(id: "dec_1", answer: .approve, note: nil)])
    XCTAssertEqual(clock.requests, [], "no hold timer")
    await eventually("the post to finish") { self.pending.sending.isEmpty }
    XCTAssertTrue(pending.hides("dec_1"))
  }

  func testRepeatedActionsPostOnce() async {
    let gate = sender.holdNextPost()
    XCTAssertTrue(pending.sendNow(first, approve))
    XCTAssertFalse(pending.sendNow(first, approve), "a second action while sending")
    XCTAssertFalse(pending.sendNow(first, AnswerDraft.Submission(answer: .reject)))
    await gate.open()
    await eventually("the post to finish") { self.pending.sending.isEmpty }
    XCTAssertFalse(pending.sendNow(first, approve), "a second action after it landed")
    XCTAssertEqual(sender.posts.count, 1)
  }

  func testSendNowLeavesAnUnrelatedHeldAnswerHeld() async {
    pending.answer(second, AnswerDraft.Submission(answer: .reject))
    await holding()
    XCTAssertTrue(pending.sendNow(first, approve))
    await eventually("the post") { self.sender.posts.count == 1 }
    XCTAssertEqual(sender.posts.map(\.id), ["dec_1"])
    XCTAssertEqual(pending.held?.decision.id, "dec_2", "the popover answer keeps its Undo")
    XCTAssertEqual(pending.undoText, "Reject · Delete the previews?")
  }

  func testAnActionOnAHeldDecisionSendsNothing() async {
    pending.answer(first, AnswerDraft.Submission(answer: .reject))
    XCTAssertFalse(pending.sendNow(first, approve))
    XCTAssertEqual(pending.held?.submission.answer, .reject)
  }

  func testAnActionConflictWaitsForThePopoverToShowItsOutcome() async {
    pending.isPresented = false
    sender.answerPosts(.failure(conflict()))
    sender.answerReads(
      .success(settled("dec_1", ["state": "answered", "answer": ["kind": "reject"], "answered_via": "app"])))
    pending.sendNow(first, approve)
    await eventually("the outcome") { self.pending.outcome != nil }
    XCTAssertEqual(pending.outcome, "Already answered in the app: Reject")
    XCTAssertEqual(sender.posts.count, 1, "the attempted answer is never posted again")
    XCTAssertTrue(pending.hides("dec_1"))
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(clock.sleeping, 0, "no timer while the popover is closed")

    pending.isPresented = true
    await eventually("the outcome timer") { self.clock.sleeping == 1 }
    clock.advance(by: PendingAnswers.outcomeDuration)
    await eventually("the outcome to clear") { self.pending.outcome == nil }
  }

  func testAnActionThatFailsRestoresTheRowWithItsMessage() async {
    sender.answerPosts(.failure(.transport("offline")))
    pending.sendNow(first, approve)
    await eventually("the failure") { !self.pending.failures.isEmpty }
    XCTAssertEqual(pending.failures, ["dec_1": PendingAnswers.failureMessage])
    XCTAssertFalse(pending.hides("dec_1"), "the row returns for the next popover")
    XCTAssertEqual(restored.map(\.decision.id), ["dec_1"])
    XCTAssertNil(restored.first?.draft)
  }

  func testAnActionOnAMissingDecisionDropsIt() async {
    sender.answerPosts(.failure(.response(status: 404, code: "not_found", message: "", field: nil)))
    pending.sendNow(first, approve)
    await eventually("the post to finish") { self.pending.sending.isEmpty }
    XCTAssertTrue(pending.hides("dec_1"))
    XCTAssertTrue(pending.failures.isEmpty)
  }

  func testAnUnauthorizedActionRestoresNothing() async {
    sender.answerPosts(.failure(.response(status: 401, code: "unauthenticated", message: "", field: nil)))
    pending.sendNow(first, approve)
    await eventually("the post to finish") { self.pending.sending.isEmpty }
    XCTAssertTrue(pending.failures.isEmpty)
    XCTAssertTrue(restored.isEmpty)
  }

  func testQuitWaitsForAnActionInFlight() async {
    let gate = sender.holdNextPost()
    pending.sendNow(first, approve)
    XCTAssertTrue(pending.hasUnsent)
    let quit = Task { await self.pending.flushAndWait() }
    await gate.open()
    let delivered = await quit.value
    XCTAssertTrue(delivered)
  }

  func testAnActionLandingAfterSignOutChangesNothing() async {
    let gate = sender.holdNextPost()
    sender.answerPosts(.failure(.transport("offline")))
    pending.sendNow(first, approve)
    pending.reset()
    await gate.open()
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertTrue(pending.failures.isEmpty)
    XCTAssertTrue(restored.isEmpty)
    XCTAssertFalse(pending.hides("dec_1"))
  }
}
