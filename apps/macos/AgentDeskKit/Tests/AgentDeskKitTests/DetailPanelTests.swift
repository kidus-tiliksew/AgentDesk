import Foundation
import XCTest

@testable import AgentDeskKit

/// The panel's side and frame (req-mac-app AC-11.1; DEC-23(2)).
final class DetailPanelPlacementTests: XCTestCase {
  private func popover(x: Double, y: Double = 400, height: Double = 400) -> PanelRect {
    PanelRect(x: x, y: y, width: 340, height: height)
  }

  private let screen = PanelRect(x: 0, y: 0, width: 1440, height: 875)

  func testRightWhenTheScreenHasRoomAndLeftOtherwise() {
    XCTAssertEqual(DetailPanelPlacement.side(popover: popover(x: 100), screen: screen), .right)
    XCTAssertEqual(DetailPanelPlacement.side(popover: popover(x: 1000), screen: screen), .left)
  }

  func testTheBoundaryOfRoomOnTheRight() {
    // 340 wide, 8 gap, 400 wide: exactly 748 pt from the popover to the edge.
    XCTAssertEqual(DetailPanelPlacement.side(popover: popover(x: 692), screen: screen), .right, "exactly fits")
    XCTAssertEqual(DetailPanelPlacement.side(popover: popover(x: 692.5), screen: screen), .left, "half a point short")
  }

  func testAScreenWithANegativeOriginKeepsItsOwnBounds() {
    let left = PanelRect(x: -1920, y: -200, width: 1920, height: 1080)
    XCTAssertEqual(DetailPanelPlacement.side(popover: popover(x: -1800), screen: left), .right)
    XCTAssertEqual(DetailPanelPlacement.side(popover: popover(x: -400), screen: left), .left)
    let frame = DetailPanelPlacement.frame(popover: popover(x: -400), screen: left, contentHeight: 300)
    XCTAssertEqual(frame.x, -808)
    XCTAssertEqual(frame.maxX, -408, "8 pt from the popover")
  }

  func testTheFrameIs400WideAndMeetsThePopoversTop() {
    let frame = DetailPanelPlacement.frame(popover: popover(x: 100), screen: screen, contentHeight: 300)
    XCTAssertEqual(frame, PanelRect(x: 448, y: 500, width: 400, height: 300))
    XCTAssertEqual(frame.maxY, popover(x: 100).maxY)
  }

  func testTheHeightStopsAtTheLimitAndAtTheScreen() {
    let tall = DetailPanelPlacement.frame(popover: popover(x: 100), screen: screen, contentHeight: 5000)
    XCTAssertEqual(tall.height, 560, "at most the popover's limit, with the content scrolling")
    let low = popover(x: 100, y: 50, height: 250)
    let cut = DetailPanelPlacement.frame(popover: low, screen: screen, contentHeight: 5000)
    XCTAssertEqual(cut.height, 300, "only the space below the popover's top")
    XCTAssertEqual(cut.minY, screen.minY)
  }

  func testAScreenTooNarrowForEitherSideStaysOnTheScreen() {
    let narrow = PanelRect(x: 0, y: 0, width: 600, height: 800)
    let frame = DetailPanelPlacement.frame(popover: popover(x: 200), screen: narrow, contentHeight: 200)
    XCTAssertEqual(frame.x, 0)
    XCTAssertEqual(frame.width, 400)
  }
}

/// Opening, replacing, and closing the panel's target (req-mac-app AC-4.8,
/// AC-11.5, AC-11.7).
final class DetailPanelStateTests: XCTestCase {
  func testOpeningReplacingAndClosing() {
    var panel = DetailPanelState()
    panel.toggle("a")
    XCTAssertEqual(panel.shownID, "a", "opens")
    panel.toggle("b")
    XCTAssertEqual(panel.shownID, "b", "another target replaces it in the same panel")
    panel.toggle("b")
    XCTAssertNil(panel.shownID, "the shown target closes")
  }

  func testTheGenerationMovesWithTheTarget() {
    var panel = DetailPanelState()
    panel.show("a")
    let opened = panel.generation
    panel.show("a")
    XCTAssertEqual(panel.generation, opened, "showing the shown target changes nothing")
    panel.show("b")
    XCTAssertGreaterThan(panel.generation, opened)
    let replaced = panel.generation
    panel.close()
    XCTAssertGreaterThan(panel.generation, replaced)
  }

  func testAnAnswerClosesOnlyAPanelShowingThatDecision() {
    var panel = DetailPanelState()
    panel.show("a")
    panel.answerHeld("b")
    XCTAssertEqual(panel.shownID, "a", "an answer from another row leaves the panel")
    XCTAssertNil(panel.reopenOnUndo)
    panel.answerHeld("a")
    XCTAssertNil(panel.shownID)
    XCTAssertEqual(panel.reopenOnUndo, "a")
  }

  func testUndoReopensOnlyWhatTheAnswerClosed() {
    var panel = DetailPanelState()
    panel.show("a")
    panel.answerHeld("a")
    XCTAssertTrue(panel.answerUndone("a"))
    XCTAssertEqual(panel.shownID, "a")
    XCTAssertNil(panel.reopenOnUndo)

    panel.close()
    panel.answerHeld("c")
    XCTAssertFalse(panel.answerUndone("c"), "a panel that was not showing it stays closed")
    XCTAssertNil(panel.shownID)
  }

  func testUndoReplacesATargetOpenedWhileTheAnswerWasHeld() {
    var panel = DetailPanelState()
    panel.show("a")
    panel.answerHeld("a")
    panel.show("b")
    XCTAssertTrue(panel.answerUndone("a"))
    XCTAssertEqual(panel.shownID, "a")
  }

  func testALaterAnswerForgetsAnEarlierReopening() {
    var panel = DetailPanelState()
    panel.show("a")
    panel.answerHeld("a")
    panel.answerHeld("b")
    XCTAssertFalse(panel.answerUndone("a"))
  }

  func testResetDropsEverything() {
    var panel = DetailPanelState()
    panel.show("a")
    panel.answerHeld("a")
    panel.show("b")
    panel.reset()
    XCTAssertNil(panel.shownID)
    XCTAssertNil(panel.reopenOnUndo)
  }
}

/// What a click does to the popover and the panel (req-mac-app AC-11.8).
final class PopoverDismissalTests: XCTestCase {
  func testAClickInEitherWindowKeepsBoth() {
    XCTAssertFalse(PopoverDismissal.closes(.ownedWindow, menuIsTracking: false))
  }

  func testAClickElsewhereClosesBoth() {
    XCTAssertTrue(PopoverDismissal.closes(.elsewhere, menuIsTracking: false))
  }

  func testAClickOnTheMenuBarItemLeavesItToTheItemsAction() {
    XCTAssertFalse(PopoverDismissal.closes(.statusItem, menuIsTracking: false))
  }

  func testAClickInTheOpenMenuKeepsBoth() {
    XCTAssertFalse(PopoverDismissal.closes(.elsewhere, menuIsTracking: true))
  }
}
