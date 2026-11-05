import Foundation
import XCTest

@testable import AgentDeskKit

/// The popover's keys (component-mac-app §Keyboard and accessibility;
/// req-mac-app AC-7.1).
final class PopoverKeysTests: XCTestCase {
  private let rows = ["a", "b", "c"]

  private func action(
    _ key: PopoverKey, selected: String? = nil, expanded: String? = nil, editing: Bool = false,
    rows: [String]? = nil
  ) -> PopoverKeyAction {
    PopoverKeys.action(
      for: key, rows: rows ?? self.rows, selected: selected, expanded: expanded, editingText: editing)
  }

  func testArrowsMoveTheSelectionAndStopAtTheEnds() {
    XCTAssertEqual(action(.down), .select("a"))
    XCTAssertEqual(action(.up), .select("c"))
    XCTAssertEqual(action(.down, selected: "a"), .select("b"))
    XCTAssertEqual(action(.down, selected: "c"), .select("c"))
    XCTAssertEqual(action(.up, selected: "b"), .select("a"))
    XCTAssertEqual(action(.up, selected: "a"), .select("a"))
    XCTAssertEqual(action(.down, expanded: "b"), .select("c"), "the expanded row stands in for the selection")
    XCTAssertEqual(action(.down, rows: []), .passThrough)
  }

  func testReturnTogglesTheSelectedRow() {
    XCTAssertEqual(action(.returnKey, selected: "b"), .toggle("b"))
    XCTAssertEqual(action(.returnKey, selected: "b", expanded: "b"), .toggle("b"))
    XCTAssertEqual(action(.returnKey), .passThrough)
  }

  func testCommandReturnSendsTheSelectedRow() {
    XCTAssertEqual(action(.commandReturn, selected: "c"), .send("c"))
    XCTAssertEqual(action(.commandReturn, expanded: "a"), .send("a"))
    XCTAssertEqual(action(.commandReturn, selected: "c", editing: true), .send("c"), "⌘↩ sends from a text field")
    XCTAssertEqual(action(.commandReturn), .passThrough)
  }

  func testEscapeCollapsesOrElseClosesThePopover() {
    XCTAssertEqual(action(.escape, expanded: "a"), .collapse)
    XCTAssertEqual(action(.escape, expanded: "a", editing: true), .collapse)
    XCTAssertEqual(action(.escape, selected: "a"), .passThrough, "the popover window closes on Escape")
  }

  func testTextFieldsKeepArrowsAndReturn() {
    XCTAssertEqual(action(.down, selected: "a", editing: true), .passThrough)
    XCTAssertEqual(action(.up, selected: "a", editing: true), .passThrough)
    XCTAssertEqual(action(.returnKey, selected: "a", editing: true), .passThrough)
  }

  func testIdsNoLongerListedCountAsNone() {
    XCTAssertEqual(action(.returnKey, selected: "gone"), .passThrough)
    XCTAssertEqual(action(.down, selected: "gone"), .select("a"))
    XCTAssertEqual(action(.escape, expanded: "gone"), .passThrough)
  }

  func testReselectAfterTheListChanges() {
    XCTAssertEqual(PopoverKeys.reselect("b", previous: rows, rows: ["a", "b"]), "b")
    XCTAssertEqual(PopoverKeys.reselect("b", previous: rows, rows: ["a", "c"]), "c")
    XCTAssertEqual(PopoverKeys.reselect("c", previous: rows, rows: ["a", "b"]), "b")
    XCTAssertNil(PopoverKeys.reselect("b", previous: rows, rows: []))
    XCTAssertNil(PopoverKeys.reselect(nil, previous: rows, rows: rows))
  }
}

/// The list's scroll target (component-mac-app §List scrolling; req-mac-app
/// AC-4.12) and its height budget (§Popover).
final class ListScrollRequestTests: XCTestCase {
  func testTheLatestRequestWins() {
    var request = ListScrollRequest()
    XCTAssertEqual(request.target, .top)
    request.toTop()
    request.toRow("a")
    XCTAssertEqual(request.target, .row("a"), "a notification's row wins over the opening's top")
    request.toRow("b")
    XCTAssertEqual(request.target, .row("b"), "a key press wins over an earlier row")
    request.toTop()
    XCTAssertEqual(request.target, .top, "a later opening wins over a retained row")
  }

  func testRepeatingKeepsTheTargetAndMovesTheGeneration() {
    var request = ListScrollRequest()
    request.toTop()
    var before = request
    request.repeatLast()
    XCTAssertEqual(request.target, .top)
    XCTAssertNotEqual(request, before, "the view sees a repeat as a change")

    request.toRow("a")
    before = request
    request.repeatLast()
    XCTAssertEqual(request.target, .row("a"), "the did-show repeat never turns a row into the top")
    XCTAssertNotEqual(request, before)
  }

  func testARepeatedTargetStillScrolls() {
    var request = ListScrollRequest()
    request.toRow("a")
    let before = request
    request.toRow("a")
    XCTAssertNotEqual(request, before, "the same row asked for again is a new request")
  }

  func testListHeightTakesWhatRemainsOfThePopover() {
    XCTAssertEqual(PopoverLayout.listMaxHeight(chromeHeight: 90), 470)
    XCTAssertEqual(PopoverLayout.listMaxHeight(chromeHeight: 90 + 23), 447, "an Undo strip shortens the list")
    XCTAssertEqual(PopoverLayout.listMaxHeight(chromeHeight: 90 + 160), 310, "the agents list shortens the list")
    XCTAssertEqual(PopoverLayout.listMaxHeight(chromeHeight: 500), PopoverLayout.minListHeight)
  }
}
