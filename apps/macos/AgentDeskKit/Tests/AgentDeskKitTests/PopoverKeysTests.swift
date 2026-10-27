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
