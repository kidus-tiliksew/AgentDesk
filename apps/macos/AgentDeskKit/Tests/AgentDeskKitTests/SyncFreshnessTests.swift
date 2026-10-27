import Foundation
import XCTest

@testable import AgentDeskKit

/// A controlled measurement of how long a change on the server takes to
/// reach the published snapshot (req-mac-app AC-3.6, AC-4.10).
///
/// The worst case for a successful read is a change that lands just after a
/// read: the next tick is one full interval away, and the read that follows
/// must page through the list. The interval runs on virtual time, exactly as
/// `Sync` schedules it. The read runs for real through `APIClient`,
/// `URLSession`, and the in-process `URLProtocol` stub, three pages long, and
/// is timed on the wall clock. The stub has no network latency, so this
/// bounds the app's own share of the delay, not a slow or failing network:
/// a request may take up to the 15-second timeout, and a failed read backs
/// off instead (component-mac-app §Sync).
@MainActor
final class SyncFreshnessTests: XCTestCase {
  private final class ServerState: @unchecked Sendable {
    private let lock = NSLock()
    private var current = ["dec_1", "dec_2"]
    var ids: [String] { lock.withLock { current } }
    func set(_ ids: [String]) { lock.withLock { current = ids } }
  }

  @MainActor
  private final class Published {
    var snapshots: [(snapshot: Sync.Snapshot, at: ContinuousClock.Instant)] = []
  }

  private struct Measurement {
    var interval: TimeInterval
    var read: Duration
    var pages: Int

    var total: TimeInterval {
      interval + Double(read.components.seconds) + Double(read.components.attoseconds) / 1e18
    }
  }

  private func measure(open: Bool) async throws -> Measurement {
    let state = ServerState()
    let server = StubServer { request in
      if request.path == "/v1/agent-sessions" {
        return .json(200, Fixtures.page([Fixtures.agentSession()], next: nil))
      }
      // One decision per page, so a read follows every cursor.
      let ids = state.ids
      let index = request.query["cursor"].flatMap(Int.init) ?? 0
      let next = index + 1 < ids.count ? String(index + 1) : nil
      return .json(200, Fixtures.page([Fixtures.pendingDecision(id: ids[index])], next: next))
    }
    let clock = ManualClock()
    let published = Published()
    let sync = Sync(
      reader: server.makeClient(), clock: clock, now: { Date(timeIntervalSince1970: clock.now) },
      publish: { published.snapshots.append(($0, ContinuousClock.now)) })
    defer { sync.stop() }
    await sync.setOpen(open)
    sync.start()
    await eventually { clock.sleeping == 1 && published.snapshots.count == 1 }
    let interval = try XCTUnwrap(clock.requests.last)

    // A decision is created just after the read.
    state.set(["dec_1", "dec_2", "dec_3"])
    let started = ContinuousClock.now
    clock.advance(by: interval)
    await eventually { published.snapshots.count == 2 }
    let arrival = try XCTUnwrap(published.snapshots.last)
    XCTAssertEqual(arrival.snapshot.decisions.map(\.id), ["dec_1", "dec_2", "dec_3"])
    return Measurement(interval: interval, read: arrival.at - started, pages: 3)
  }

  private func report(_ name: String, _ m: Measurement, bound: TimeInterval) {
    print(
      String(
        format: "FRESHNESS %@: timer %.3f s + read %.4f s (%d pages, in-process stub) = %.4f s; bound %.0f s",
        name, m.interval, m.total - m.interval, m.pages, m.total, bound))
  }

  /// Closed popover: the menu bar must reflect a change within 20 s (AC-3.6).
  func testClosedPopoverReflectsAChangeWithin20Seconds() async throws {
    let m = try await measure(open: false)
    report("closed", m, bound: 20)
    XCTAssertEqual(m.interval, Sync.closedInterval)
    XCTAssertLessThan(m.total, 20)
  }

  /// Open popover: a settled decision must leave the list within 10 s
  /// (AC-4.10). Creation and settlement are the same read.
  func testOpenPopoverReflectsAChangeWithin10Seconds() async throws {
    let m = try await measure(open: true)
    report("open", m, bound: 10)
    XCTAssertEqual(m.interval, Sync.openInterval)
    XCTAssertLessThan(m.total, 10)
  }
}
