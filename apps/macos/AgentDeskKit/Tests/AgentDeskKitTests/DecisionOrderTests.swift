import Foundation
import XCTest

@testable import AgentDeskKit

/// Every tie-break of the popover's order (component-mac-app §Ordering and
/// attention; req-mac-app AC-4.1).
final class DecisionOrderTests: XCTestCase {
  private func ids(_ decisions: [Decision]) -> [String] {
    DecisionOrder.sorted(decisions).map(\.id)
  }

  func testUrgentComesBeforeNormal() {
    let normal = Fixtures.pending("a", deadline: "2026-10-27T12:01:00Z")
    let urgent = Fixtures.pending("b", priority: "urgent")
    XCTAssertEqual(ids([normal, urgent]), ["b", "a"])
  }

  func testEarliestDeadlineFirstAndNoDeadlineLast() {
    let none = Fixtures.pending("a", created: "2026-10-27T11:00:00Z")
    let later = Fixtures.pending("b", deadline: "2026-10-27T13:00:00Z")
    let sooner = Fixtures.pending("c", deadline: "2026-10-27T12:30:00Z")
    XCTAssertEqual(ids([none, later, sooner]), ["c", "b", "a"])
  }

  func testDeadlineOrderAppliesWithinUrgent() {
    let urgentNone = Fixtures.pending("a", priority: "urgent")
    let urgentDue = Fixtures.pending("b", priority: "urgent", deadline: "2026-10-28T00:00:00Z")
    XCTAssertEqual(ids([urgentNone, urgentDue]), ["b", "a"])
  }

  func testOldestCreationBreaksAnEqualDeadline() {
    let newer = Fixtures.pending("a", deadline: "2026-10-27T13:00:00Z", created: "2026-10-27T12:05:00Z")
    let older = Fixtures.pending("b", deadline: "2026-10-27T13:00:00Z", created: "2026-10-27T12:00:00Z")
    XCTAssertEqual(ids([newer, older]), ["b", "a"])

    let newerNone = Fixtures.pending("c", created: "2026-10-27T12:05:00Z")
    let olderNone = Fixtures.pending("d", created: "2026-10-27T12:00:00Z")
    XCTAssertEqual(ids([newerNone, olderNone]), ["d", "c"])
  }

  func testIdBreaksEverythingElseEqual() {
    let b = Fixtures.pending("dec_b")
    let a = Fixtures.pending("dec_a")
    XCTAssertEqual(ids([b, a]), ["dec_a", "dec_b"])
  }

  func testTheFullOrder() {
    let decisions = [
      Fixtures.pending("normal-none"),
      Fixtures.pending("normal-late", deadline: "2026-10-27T15:00:00Z"),
      Fixtures.pending("urgent-none", priority: "urgent"),
      Fixtures.pending("normal-soon", deadline: "2026-10-27T12:10:00Z"),
      Fixtures.pending("urgent-soon", priority: "urgent", deadline: "2026-10-27T14:00:00Z"),
    ]
    XCTAssertEqual(
      ids(decisions), ["urgent-soon", "urgent-none", "normal-soon", "normal-late", "normal-none"])
  }
}
