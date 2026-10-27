import Foundation
import XCTest

@testable import AgentDeskKit

/// `Sync` on virtual time (component-mac-app §Sync, §Verification;
/// DEC-19(4); req-mac-app AC-3.6, AC-4.10).
@MainActor
final class SyncTests: XCTestCase {
  private let first = Fixtures.pending("dec_1")
  private let second = Fixtures.pending("dec_2")
  private let agent = Fixtures.session("ags_1")

  @MainActor
  private final class Harness {
    let sync: Sync
    let reader: FakeReader
    let clock: ManualClock
    let published: Published

    init(reader: FakeReader = FakeReader()) {
      let clock = ManualClock()
      let published = Published()
      self.reader = reader
      self.clock = clock
      self.published = published
      sync = Sync(
        reader: reader, clock: clock, now: { Date(timeIntervalSince1970: clock.now) },
        publish: { published.snapshots.append($0) })
    }

    /// Waits until the timer sleeps, which follows every completed tick.
    func settled(sleeps count: Int, file: StaticString = #filePath, line: UInt = #line) async {
      await eventually("\(count) sleep requests", file: file, line: line) {
        clock.requests.count >= count && clock.sleeping == 1
      }
    }
  }

  @MainActor
  private final class Published {
    var snapshots: [Sync.Snapshot] = []
    var last: Sync.Snapshot? { snapshots.last }
  }

  // MARK: Cadence

  func testStartReadsDecisionsAtOnceThenEvery15SecondsWhileClosed() async {
    let h = Harness()
    h.reader.alwaysAnswerDecisions(.success([first]))
    h.sync.start()
    await h.settled(sleeps: 1)
    XCTAssertEqual(h.reader.decisionCalls, 1)
    XCTAssertEqual(h.reader.agentCalls, 0, "agents are not read while the popover is closed")
    XCTAssertEqual(h.clock.requests, [15])
    XCTAssertEqual(h.published.last?.decisions, [first])

    h.clock.advance(by: 15)
    await h.settled(sleeps: 2)
    XCTAssertEqual(h.reader.decisionCalls, 2)
    XCTAssertEqual(h.reader.agentCalls, 0)
    XCTAssertEqual(h.clock.requests, [15, 15])
  }

  func testOpeningReadsBothAtOnceThenEvery5Seconds() async {
    let h = Harness()
    h.reader.alwaysAnswerAgents(.success([agent]))
    h.sync.start()
    await h.settled(sleeps: 1)

    await h.sync.setOpen(true)
    await h.settled(sleeps: 2)
    XCTAssertEqual(h.reader.decisionCalls, 2)
    XCTAssertEqual(h.reader.agentCalls, 1)
    XCTAssertEqual(h.clock.requests.last, 5)
    XCTAssertEqual(h.published.last?.agents, [agent])

    h.clock.advance(by: 5)
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.reader.decisionCalls, 3)
    XCTAssertEqual(h.reader.agentCalls, 2)
    XCTAssertEqual(h.clock.requests.last, 5)
  }

  func testClosingSwitchesTo15SecondsWithoutAReadAndStopsAgentReads() async {
    let h = Harness()
    h.sync.start()
    await h.settled(sleeps: 1)
    await h.sync.setOpen(true)
    await h.settled(sleeps: 2)

    await h.sync.setOpen(false)
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.reader.decisionCalls, 2, "closing reads nothing")
    XCTAssertEqual(h.clock.requests.last, 15)

    h.clock.advance(by: 15)
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.reader.decisionCalls, 3)
    XCTAssertEqual(h.reader.agentCalls, 1, "only the open reads included agents")
  }

  func testWakeAndNetworkReturnReadAtOnce() async {
    let h = Harness()
    h.sync.start()
    await h.settled(sleeps: 1)

    await h.sync.readNow()
    await h.settled(sleeps: 2)
    XCTAssertEqual(h.reader.decisionCalls, 2)
    XCTAssertEqual(h.reader.agentCalls, 0, "agents are read at once only when open")
    XCTAssertEqual(h.clock.sleeping, 1, "the trigger replaced the timer")

    await h.sync.setOpen(true)
    await h.settled(sleeps: 3)
    await h.sync.readNow()
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.reader.decisionCalls, 4)
    XCTAssertEqual(h.reader.agentCalls, 2)
  }

  // MARK: Backoff

  func testFailedReadsBackOffTo300SecondsAndASuccessResets() async {
    let h = Harness()
    h.reader.alwaysAnswerDecisions(.failure(.transport("offline")))
    h.sync.start()
    await h.settled(sleeps: 1)
    for (index, wait) in [30.0, 60, 120, 300, 300].enumerated() {
      XCTAssertEqual(h.clock.requests.last, wait, "after failure \(index + 1)")
      h.clock.advance(by: wait)
      await h.settled(sleeps: index + 2)
    }
    h.reader.alwaysAnswerDecisions(.success([first]))
    h.clock.advance(by: 300)
    await h.settled(sleeps: 7)
    XCTAssertEqual(h.clock.requests.last, 15, "a success resets the closed cadence")

    h.reader.alwaysAnswerDecisions(.failure(.transport("offline")))
    await h.sync.setOpen(true)
    await h.settled(sleeps: 8)
    XCTAssertEqual(h.clock.requests.last, 30, "the sequence starts over")
    h.reader.alwaysAnswerDecisions(.success([first]))
    h.clock.advance(by: 30)
    await h.settled(sleeps: 9)
    XCTAssertEqual(h.clock.requests.last, 5, "a success resets the open cadence")
  }

  func testAFailedAgentReadAlsoBacksOff() async {
    let h = Harness()
    h.reader.alwaysAnswerAgents(.failure(.transport("offline")))
    h.sync.start()
    await h.settled(sleeps: 1)
    await h.sync.setOpen(true)
    await h.settled(sleeps: 2)
    XCTAssertEqual(h.clock.requests.last, 30)
  }

  func testAFailedReadKeepsTheLastGoodSnapshot() async {
    let h = Harness()
    h.reader.answerDecisions(.success([first, second]), .failure(.transport("offline")))
    h.reader.alwaysAnswerDecisions(.failure(.transport("offline")))
    h.sync.start()
    await h.settled(sleeps: 1)
    XCTAssertEqual(h.published.snapshots.count, 1)

    h.clock.advance(by: 15)
    await h.settled(sleeps: 2)
    XCTAssertEqual(h.published.snapshots.count, 1, "a failure publishes nothing")
    XCTAssertEqual(h.published.last?.decisions, [first, second])
    XCTAssertEqual(h.published.last?.fetchedAt, Date(timeIntervalSince1970: 0))
  }

  func testAgentsKeepTheirLastGoodListWhenDecisionsFail() async {
    let h = Harness()
    h.reader.answerAgents(.success([agent]))
    h.reader.alwaysAnswerAgents(.failure(.transport("offline")))
    h.sync.start()
    await h.settled(sleeps: 1)
    await h.sync.setOpen(true)
    await h.settled(sleeps: 2)
    h.reader.alwaysAnswerDecisions(.success([first]))
    h.clock.advance(by: 30)
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.published.last?.decisions, [first])
    XCTAssertEqual(h.published.last?.agents, [agent])
  }

  func testOnlyACompleteReadOfEveryPageReplacesTheList() async throws {
    let calls = Counter()
    let server = StubServer { request in
      let call = calls.next()
      if request.query["cursor"] == nil {
        let id = call == 0 ? "dec_1" : "dec_3"
        return .json(200, Fixtures.page([Fixtures.pendingDecision(id: id)], next: "page2"))
      }
      // The first run's second page answers; later second pages fail.
      return call == 1
        ? .json(200, Fixtures.page([Fixtures.pendingDecision(id: "dec_2")], next: nil))
        : .error(500, "internal", "Boom")
    }
    let clock = ManualClock()
    let published = Published()
    let sync = Sync(
      reader: server.makeClient(), clock: clock, now: { Date(timeIntervalSince1970: clock.now) },
      publish: { published.snapshots.append($0) })
    sync.start()
    await eventually { clock.sleeping == 1 }
    XCTAssertEqual(published.last?.decisions.map(\.id), ["dec_1", "dec_2"])

    clock.advance(by: 15)
    await eventually { clock.requests.count == 2 && clock.sleeping == 1 }
    XCTAssertEqual(published.snapshots.count, 1, "a partial read publishes nothing")
    XCTAssertEqual(clock.requests.last, 30)
    sync.stop()
  }

  // MARK: Overlap

  func testATickThatFindsAReadInFlightIsSkipped() async {
    let h = Harness()
    h.sync.start()
    await h.settled(sleeps: 1)

    let gate = h.reader.holdNextRead()
    h.clock.advance(by: 15)
    await eventually { h.reader.decisionCalls == 2 }
    // Opening waits for the held read; closing again restarts the closed
    // timer while that read is still in flight.
    await h.sync.setOpen(true)
    await h.sync.setOpen(false)
    await eventually { h.clock.sleeping == 1 }
    h.clock.advance(by: 15)
    await eventually { h.clock.sleeping == 1 && h.clock.requests.count >= 3 }
    XCTAssertEqual(h.reader.decisionCalls, 2, "the tick was skipped")

    await gate.open()
    await eventually { h.published.snapshots.count == 2 }
    XCTAssertEqual(h.reader.peakConcurrency, 1)
  }

  func testATriggerDuringAReadWaitsAndReadsAgain() async {
    let h = Harness()
    h.reader.alwaysAnswerAgents(.success([agent]))
    let gate = h.reader.holdNextRead()
    h.sync.start()
    await eventually { h.reader.decisionCalls == 1 }

    await h.sync.setOpen(true)
    await h.sync.readNow()
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(h.reader.decisionCalls, 1, "no read starts while one is in flight")

    await gate.open()
    await h.settled(sleeps: 1)
    XCTAssertEqual(h.reader.decisionCalls, 2)
    XCTAssertEqual(h.reader.agentCalls, 1, "the read after opening includes agents")
    XCTAssertEqual(h.reader.peakConcurrency, 1)
  }

  // MARK: Stopping

  func testUnauthorizedStopsPolling() async {
    let h = Harness()
    h.reader.alwaysAnswerDecisions(.failure(.response(status: 401, code: "unauthenticated", message: "No", field: nil)))
    h.sync.start()
    await eventually { await !h.sync.isRunning }
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(h.clock.sleeping, 0)
    XCTAssertEqual(h.reader.decisionCalls, 1)
    XCTAssertTrue(h.published.snapshots.isEmpty)

    await h.sync.readNow()
    await h.sync.setOpen(true)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(h.reader.decisionCalls, 1, "a stopped run ignores triggers")
  }

  func testStopDropsAResultStillInFlightAndARestartBeginsEmpty() async {
    let h = Harness()
    let gate = h.reader.holdNextRead()
    h.reader.answerDecisions(.success([first]), .success([second]))
    h.sync.start()
    await eventually { h.reader.decisionCalls == 1 }

    h.sync.stop()
    await gate.open()
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertTrue(h.published.snapshots.isEmpty, "the late result was dropped")
    XCTAssertEqual(h.clock.sleeping, 0)

    h.sync.start()
    await h.settled(sleeps: 1)
    XCTAssertEqual(h.published.snapshots.map(\.decisions), [[second]])
  }

  func testStopRightAfterStartStartsNothing() async {
    let h = Harness()
    h.sync.start()
    h.sync.stop()
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(h.reader.decisionCalls, 0)
    let running = await h.sync.isRunning
    XCTAssertFalse(running)
  }

  func testSignOutThroughAccountStopsSync() async throws {
    let store = MemoryCredentialStore()
    let server = StubServer { request in
      request.path == "/device/connection"
        ? .json(204, "") : .json(200, Fixtures.page([Fixtures.pendingDecision()], next: nil))
    }
    let account = Account(
      configuration: server.configuration, credentials: store, session: server.makeSession(),
      userAgent: "AgentDeskMac/9.9.9")
    try account.signIn(token: "adp_live")
    let clock = ManualClock()
    let sync = Sync(reader: account.api, clock: clock, publish: { _ in })
    account.addCleanup { sync.stop() }
    sync.start()
    await eventually { clock.sleeping == 1 }

    _ = await account.signOut()
    let running = await sync.isRunning
    XCTAssertFalse(running)
  }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  func next() -> Int {
    lock.withLock {
      defer { value += 1 }
      return value
    }
  }
}
