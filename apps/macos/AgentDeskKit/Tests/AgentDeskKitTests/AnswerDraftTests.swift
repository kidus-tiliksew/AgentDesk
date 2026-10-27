import Foundation
import XCTest

@testable import AgentDeskKit

/// The expanded row's draft builds the answer for each input type
/// (component-mac-app §Rows; req-mac-app AC-4.6, AC-4.7, AC-7.1;
/// req-decision-requests REQ-2, REQ-3).
final class AnswerDraftTests: XCTestCase {
  private let options: [[String: String]] = [
    ["id": "a", "label": "Ship now"], ["id": "b", "label": "Wait"], ["id": "c", "label": "Cancel"],
  ]

  private func decision(_ type: String, recommendation: [String: Any]? = nil) -> Decision {
    var fields: [String: Any] = ["input_type": type]
    if type != "approve_reject" && type != "free_text" { fields["options"] = options }
    if let recommendation { fields["recommendation"] = recommendation }
    return Fixtures.pending("dec", fields)
  }

  private func submitted(_ draft: AnswerDraft) -> Answer? { draft.submission?.answer }

  // MARK: Approve or reject

  func testApproveRejectSendsTheButtonAnswerAndCommandReturnSendsTheRecommendation() {
    let draft = AnswerDraft(decision: decision("approve_reject", recommendation: ["kind": "approve"]))
    XCTAssertTrue(draft.isSuggested(.approve))
    XCTAssertFalse(draft.isSuggested(.reject))
    XCTAssertNil(draft.chosenAnswer, "the buttons answer; the draft holds no choice")
    XCTAssertEqual(draft.submission(for: .reject), AnswerDraft.Submission(answer: .reject))
    XCTAssertEqual(submitted(draft), .approve, "⌘↩ sends the recommendation")

    let plain = AnswerDraft(decision: decision("approve_reject"))
    XCTAssertNil(plain.submission, "no recommendation: ⌘↩ sends nothing")
    XCTAssertFalse(plain.canSend)
  }

  // MARK: Single choice

  func testSingleChoicePreselectsTheRecommendationAndSendsTheSelection() {
    var draft = AnswerDraft(decision: decision("single_choice", recommendation: ["kind": "option", "option_id": "b"]))
    XCTAssertEqual(draft.selectedOption, "b")
    XCTAssertTrue(draft.isSuggested("b"))
    XCTAssertFalse(draft.isSuggested("a"))
    XCTAssertEqual(submitted(draft), .option(id: "b"))

    draft.selectedOption = "a"
    XCTAssertEqual(submitted(draft), .option(id: "a"))
  }

  func testSingleChoiceWithoutRecommendationNeedsASelection() {
    var draft = AnswerDraft(decision: decision("single_choice"))
    XCTAssertNil(draft.selectedOption)
    XCTAssertNil(draft.submission)
    XCTAssertFalse(draft.canSend)
    draft.selectedOption = "c"
    XCTAssertEqual(submitted(draft), .option(id: "c"))
  }

  func testSingleChoiceRejectsAnUnknownOption() {
    var draft = AnswerDraft(decision: decision("single_choice", recommendation: ["kind": "option", "option_id": "a"]))
    draft.selectedOption = "zz"
    XCTAssertNil(draft.chosenAnswer)
    XCTAssertNil(draft.submission, "an invalid choice never falls back to the recommendation")
  }

  // MARK: Multiple choice

  func testMultipleChoicePreselectsTheRecommendationAndSendsOptionsInListOrder() {
    var draft = AnswerDraft(
      decision: decision("multiple_choice", recommendation: ["kind": "options", "option_ids": ["c", "a"]]))
    XCTAssertEqual(draft.selectedOptions, ["a", "c"])
    XCTAssertTrue(draft.isSuggested("a"))
    XCTAssertTrue(draft.isSuggested("c"))
    XCTAssertEqual(submitted(draft), .options(ids: ["a", "c"]))

    draft.selectedOptions.insert("b")
    XCTAssertEqual(submitted(draft), .options(ids: ["a", "b", "c"]))
  }

  func testMultipleChoiceClearedByTheUserSendsNothing() {
    var draft = AnswerDraft(
      decision: decision("multiple_choice", recommendation: ["kind": "options", "option_ids": ["a"]]))
    draft.selectedOptions = []
    XCTAssertNil(draft.submission, "clearing the preselection is not an absence of choice")
    XCTAssertFalse(draft.canSend)
  }

  func testMultipleChoiceWithoutRecommendationNeedsOneOption() {
    var draft = AnswerDraft(decision: decision("multiple_choice"))
    XCTAssertNil(draft.submission)
    draft.selectedOptions = ["b"]
    XCTAssertEqual(submitted(draft), .options(ids: ["b"]))
  }

  // MARK: Free text

  func testFreeTextUsesTheRecommendationAsPlaceholderAndTypedTextFirst() {
    var draft = AnswerDraft(decision: decision("free_text", recommendation: ["kind": "text", "text": "agentdesk-core"]))
    XCTAssertEqual(draft.suggestedText, "agentdesk-core")
    XCTAssertEqual(draft.text, "", "the recommendation is a placeholder, not typed text")
    XCTAssertEqual(submitted(draft), .text("agentdesk-core"), "an untouched field sends the recommendation")

    draft.text = "  agentdesk-kit \n"
    XCTAssertEqual(submitted(draft), .text("agentdesk-kit"))
  }

  func testFreeTextRejectsBlankAndOverlongInput() {
    var draft = AnswerDraft(decision: decision("free_text", recommendation: ["kind": "text", "text": "x"]))
    draft.text = "   "
    XCTAssertNil(draft.submission, "spaces are invalid input, not an untouched field")
    draft.text = String(repeating: "a", count: AnswerDraft.textLimit + 1)
    XCTAssertNil(draft.submission)
    draft.text = String(repeating: "a", count: AnswerDraft.textLimit)
    XCTAssertEqual(submitted(draft), .text(String(repeating: "a", count: AnswerDraft.textLimit)))
  }

  func testFreeTextWithoutRecommendationNeedsText() {
    var draft = AnswerDraft(decision: decision("free_text"))
    XCTAssertNil(draft.suggestedText)
    XCTAssertNil(draft.submission)
    draft.text = "yes"
    XCTAssertEqual(submitted(draft), .text("yes"))
  }

  // MARK: Single choice or text

  func testSingleChoiceOrTextTypingClearsTheSelectionAndChoosingClearsTheText() {
    var draft = AnswerDraft(
      decision: decision("single_choice_or_text", recommendation: ["kind": "option", "option_id": "a"]))
    XCTAssertEqual(draft.selectedOption, "a")
    XCTAssertEqual(submitted(draft), .option(id: "a"))

    draft.text = "Ship on Monday"
    XCTAssertNil(draft.selectedOption)
    XCTAssertEqual(submitted(draft), .text("Ship on Monday"))

    draft.selectedOption = "b"
    XCTAssertEqual(draft.text, "")
    XCTAssertEqual(submitted(draft), .option(id: "b"), "exactly one of option or text is sent")
  }

  func testSingleChoiceOrTextWithATextRecommendation() {
    var draft = AnswerDraft(
      decision: decision("single_choice_or_text", recommendation: ["kind": "text", "text": "Next week"]))
    XCTAssertNil(draft.selectedOption)
    XCTAssertEqual(draft.suggestedText, "Next week")
    XCTAssertEqual(submitted(draft), .text("Next week"))
    draft.text = " "
    XCTAssertNil(draft.submission)
  }

  func testSingleChoiceOrTextWithNothingChosenSendsTheRecommendation() {
    var draft = AnswerDraft(
      decision: decision("single_choice_or_text", recommendation: ["kind": "option", "option_id": "c"]))
    draft.text = "x"
    draft.text = ""
    XCTAssertNil(draft.selectedOption)
    XCTAssertEqual(submitted(draft), .option(id: "c"), "with none chosen, ⌘↩ sends the recommendation")
  }

  // MARK: Note

  func testNoteIsSentOnlyWhenOpenAndNotBlank() {
    var draft = AnswerDraft(decision: decision("approve_reject"))
    draft.note = "hidden"
    XCTAssertNil(draft.submission(for: .approve)?.note, "a closed note field sends nothing")
    draft.isNoteOpen = true
    XCTAssertEqual(draft.submission(for: .approve)?.note, "hidden")
    draft.note = "  \n"
    XCTAssertEqual(draft.submission(for: .approve), AnswerDraft.Submission(answer: .approve))
  }

  func testNoteLimitIsTwoThousandUTF16Units() {
    var draft = AnswerDraft(decision: decision("single_choice", recommendation: ["kind": "option", "option_id": "a"]))
    draft.isNoteOpen = true
    draft.note = String(repeating: "n", count: 2000)
    XCTAssertEqual(draft.submission?.note?.count, 2000)
    draft.note = String(repeating: "n", count: 2001)
    XCTAssertFalse(draft.noteIsValid)
    XCTAssertNil(draft.submission)
    XCTAssertNil(draft.submission(for: .approve))
    // An emoji is two UTF-16 units, as the server counts it.
    draft.note = String(repeating: "😀", count: 1001)
    XCTAssertFalse(draft.noteIsValid)
  }

  // MARK: Every input type

  func testEveryInputTypeBuildsAnAnswerOfItsKind() {
    let cases: [(String, [String: Any]?, (inout AnswerDraft) -> Void, Answer)] = [
      ("approve_reject", ["kind": "reject"], { _ in }, .reject),
      ("single_choice", nil, { $0.selectedOption = "b" }, .option(id: "b")),
      ("multiple_choice", nil, { $0.selectedOptions = ["c", "b"] }, .options(ids: ["b", "c"])),
      ("free_text", nil, { $0.text = "free" }, .text("free")),
      ("single_choice_or_text", nil, { $0.text = "other" }, .text("other")),
    ]
    for (type, recommendation, edit, expected) in cases {
      var draft = AnswerDraft(decision: decision(type, recommendation: recommendation))
      edit(&draft)
      XCTAssertEqual(submitted(draft), expected, type)
    }
    XCTAssertEqual(Set(cases.map(\.0)), Set(Decision.InputType.allCases.map(\.rawValue)))
  }
}
