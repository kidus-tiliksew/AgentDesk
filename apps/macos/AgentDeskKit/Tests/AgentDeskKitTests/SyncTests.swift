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
    /// What `publishAgentDetail` delivered.
    let details: AgentDetails

    init(reader: FakeReader = FakeReader()) {
      let clock = ManualClock()
      let published = Published()
      self.reader = reader
      self.clock = clock
      self.published = published
      let details = AgentDetails()
      self.details = details
      sync = Sync(
        reader: reader, clock: clock, now: { Date(timeIntervalSince1970: clock.now) },
        publish: { published.snapshots.append($0) },
        publishAgentDetail: { details.updates.append($0) })
    }

    /// Starts a run with the popover open and its first reads finished.
    func startOpen() async {
      sync.start()
      await settled(sleeps: 1)
      await sync.setOpen(true)
      await settled(sleeps: 2)
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

  @MainActor
  private final class AgentDetails {
    var updates: [AgentDetailUpdate] = []
    var last: AgentDetailOutcome? { updates.last?.outcome }
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

  // MARK: The panel's agent session

  private let history = [
    StatusHistoryEntry(state: .waiting, line: "newest", at: Fixtures.instant("2026-10-27T11:59:00Z")),
    StatusHistoryEntry(state: .working, line: "older", at: Fixtures.instant("2026-10-27T11:00:00Z")),
  ]
  private let notFound = APIError.response(status: 404, code: "not_found", message: "Missing", field: nil)
  private let unauthenticated = APIError.response(
    status: 401, code: "unauthenticated", message: "No", field: nil)

  func testNoDetailIsReadWhileNoSessionIsShown() async {
    let h = Harness()
    await h.startOpen()
    h.clock.advance(by: 5)
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.reader.sessionReads, [])
    XCTAssertEqual(h.reader.historyReads, [])
    XCTAssertEqual(h.details.updates, [])
  }

  func testShowingASessionReadsItAndItsHistoryAtOnceAndConcurrently() async {
    let h = Harness()
    await h.startOpen()
    h.reader.alwaysAnswerSession(.success(agent))
    h.reader.alwaysAnswerHistory(.success(history))
    let sessionGate = h.reader.holdNextSessionRead()
    let historyGate = h.reader.holdNextHistoryRead()
    let target = h.sync.showAgent(id: "ags_1")

    // Neither answers until the other has started.
    await eventually("both reads in flight") {
      h.reader.sessionReads == ["ags_1"] && h.reader.historyReads == ["ags_1"]
    }
    XCTAssertEqual(h.details.updates, [], "a pair is published whole")
    await sessionGate.open()
    await historyGate.open()
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.details.updates, [AgentDetailUpdate(target: target, outcome: .loaded(agent, history))])
    XCTAssertEqual(h.clock.requests.last, 5)
    XCTAssertEqual(h.clock.sleeping, 1, "no competing timer")
  }

  func testAShownSessionIsReadEvery5SecondsOnTheOneTimerWithTheLists() async {
    let h = Harness()
    await h.startOpen()
    let decisionsBefore = h.reader.decisionCalls
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.reader.sessionReads.count, 1)
    XCTAssertEqual(h.reader.decisionCalls, decisionsBefore + 1, "a selection reads the lists too")

    for tick in 1...3 {
      h.clock.advance(by: 5)
      await h.settled(sleeps: 3 + tick)
      XCTAssertEqual(h.reader.sessionReads.count, 1 + tick)
      XCTAssertEqual(h.reader.historyReads.count, 1 + tick)
      XCTAssertEqual(h.clock.sleeping, 1)
    }
    XCTAssertEqual(h.clock.requests.suffix(4), [5, 5, 5, 5])
  }

  func testAChangeReachesThePanelWithin10Seconds() async {
    let h = Harness()
    await h.startOpen()
    let changed = Fixtures.session("ags_1", ["line": "Changed", "pending_decision_count": 3])
    h.reader.alwaysAnswerSession(.success(agent))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    h.reader.alwaysAnswerSession(.success(changed))
    let interval = h.clock.requests.last ?? 0
    XCTAssertLessThan(interval, 10)
    h.clock.advance(by: interval)
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.details.last, .loaded(changed, []))
  }

  func testHidingStopsTheHistoryReads() async {
    let h = Harness()
    await h.startOpen()
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    h.sync.hideAgent()
    h.clock.advance(by: 5)
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.reader.historyReads.count, 1, "no history once no session is shown")
    XCTAssertEqual(h.reader.sessionReads.count, 1)
    XCTAssertEqual(h.reader.decisionCalls, 4, "the lists go on")
  }

  func testAClosedPopoverReadsNoHistory() async {
    let h = Harness()
    await h.startOpen()
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    await h.sync.setOpen(false)
    await h.settled(sleeps: 4)
    h.clock.advance(by: 15)
    await h.settled(sleeps: 5)
    XCTAssertEqual(h.reader.historyReads.count, 1)
  }

  func testPanelDataNeverMovesFetchedAt() async {
    let h = Harness()
    await h.startOpen()
    h.clock.advance(by: 1)
    let fetchedAt = h.published.last?.fetchedAt
    let publishes = h.published.snapshots.count
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.published.snapshots.count, publishes + 1, "the selection's list read publishes once")
    let afterSelection = h.published.last?.fetchedAt
    XCTAssertNotEqual(afterSelection, fetchedAt, "from that list read")

    h.reader.alwaysAnswerSession(.success(Fixtures.session("ags_1", ["line": "New"])))
    h.sync.retryAgent()
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.published.snapshots.count, publishes + 1, "a panel-only read publishes no snapshot")
    XCTAssertEqual(h.published.last?.fetchedAt, afterSelection)
  }

  func testATransientFailureOfEitherReadFailsThePairAndBacksOff() async {
    for failing in ["session", "history"] {
      let h = Harness()
      await h.startOpen()
      h.reader.alwaysAnswerSession(.success(agent))
      h.reader.alwaysAnswerHistory(.success(history))
      _ = h.sync.showAgent(id: "ags_1")
      await h.settled(sleeps: 3)
      XCTAssertEqual(h.details.last, .loaded(agent, history), failing)

      let offline = APIError.transport("offline")
      if failing == "session" {
        h.reader.alwaysAnswerSession(.failure(offline))
      } else {
        h.reader.alwaysAnswerHistory(.failure(offline))
      }
      var sleeps = 3
      var wait = 5.0
      for backoff in [30.0, 60, 120, 300, 300] {
        h.clock.advance(by: wait)
        sleeps += 1
        await h.settled(sleeps: sleeps)
        XCTAssertEqual(h.details.last, .failed, failing)
        XCTAssertEqual(h.clock.requests.last, backoff, failing)
        wait = backoff
      }

      h.reader.alwaysAnswerSession(.success(agent))
      h.reader.alwaysAnswerHistory(.success(history))
      h.clock.advance(by: wait)
      await h.settled(sleeps: sleeps + 1)
      XCTAssertEqual(h.details.last, .loaded(agent, history), failing)
      XCTAssertEqual(h.clock.requests.last, 5, "a success resets the cadence")
    }
  }

  func testAPanelFailureKeepsTheListsIndependent() async {
    let h = Harness()
    await h.startOpen()
    h.reader.alwaysAnswerDecisions(.success([first]))
    h.reader.alwaysAnswerSession(.failure(.transport("offline")))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.published.last?.decisions, [first], "a successful list read still publishes")
    XCTAssertEqual(h.details.last, .failed)
    XCTAssertEqual(h.clock.requests.last, 30)
  }

  func testClosingThePanelEndsABackoffOnlyItsTargetCaused() async {
    let h = Harness()
    await h.startOpen()
    h.reader.alwaysAnswerHistory(.failure(.transport("offline")))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.clock.requests.last, 30)
    h.clock.advance(by: 30)
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.clock.requests.last, 60)

    h.sync.hideAgent()
    await h.settled(sleeps: 5)
    XCTAssertEqual(h.clock.requests.last, 5, "the lists return to their open cadence")
    XCTAssertEqual(h.clock.sleeping, 1, "no competing timer")
    let decisions = h.reader.decisionCalls
    h.clock.advance(by: 5)
    await eventually("the next list read") { h.reader.decisionCalls == decisions + 1 }
  }

  func testClosingThePanelKeepsABackoffTheListsCaused() async {
    let h = Harness()
    await h.startOpen()
    h.reader.alwaysAnswerDecisions(.failure(.transport("offline")))
    h.reader.alwaysAnswerHistory(.failure(.transport("offline")))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.clock.requests.last, 30)
    let requests = h.clock.requests.count

    h.sync.hideAgent()
    try? await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertEqual(h.clock.requests.count, requests, "the timer keeps its backoff")
    XCTAssertEqual(h.clock.sleeping, 1)
  }

  func testAContractNotFoundFromEitherReadIsGoneAndStopsThatTargetsReads() async {
    for failing in ["session", "history"] {
      let h = Harness()
      await h.startOpen()
      if failing == "session" {
        h.reader.alwaysAnswerSession(.failure(notFound))
      } else {
        h.reader.alwaysAnswerHistory(.failure(notFound))
      }
      let target = h.sync.showAgent(id: "ags_1")
      await h.settled(sleeps: 3)
      XCTAssertEqual(h.details.updates, [AgentDetailUpdate(target: target, outcome: .gone)], failing)
      XCTAssertEqual(h.clock.requests.last, 5, "a missing session is no failed read")
      let reads = h.reader.sessionReads.count

      h.clock.advance(by: 5)
      await h.settled(sleeps: 4)
      XCTAssertEqual(h.reader.sessionReads.count, reads, "reading stops")
      XCTAssertEqual(h.reader.decisionCalls, 4, "the lists go on")
      XCTAssertEqual(h.details.updates.count, 1)

      // Reopening is a new target, read again.
      h.reader.alwaysAnswerSession(.success(agent))
      h.reader.alwaysAnswerHistory(.success(history))
      _ = h.sync.showAgent(id: "ags_1")
      await h.settled(sleeps: 5)
      XCTAssertEqual(h.details.last, .loaded(agent, history))
    }
  }

  func testGoneNeverRemovesAListEntry() async {
    let h = Harness()
    h.reader.alwaysAnswerAgents(.success([agent]))
    await h.startOpen()
    h.reader.alwaysAnswerSession(.failure(notFound))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.details.last, .gone)
    XCTAssertEqual(h.published.last?.agents, [agent])
  }

  func testNonContract404IsTransient() async {
    let h = Harness()
    await h.startOpen()
    h.reader.alwaysAnswerSession(.failure(.http(status: 404)))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.details.last, .failed)
    XCTAssertEqual(h.clock.requests.last, 30)
    h.clock.advance(by: 30)
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.reader.sessionReads.count, 2, "reading continues")
  }

  func testAnUnauthenticatedDetailReadStopsTheRun() async {
    let h = Harness()
    await h.startOpen()
    h.reader.alwaysAnswerHistory(.failure(unauthenticated))
    _ = h.sync.showAgent(id: "ags_1")
    await eventually("the run ends") { await !h.sync.isRunning }
    XCTAssertEqual(h.details.updates, [])
  }

  func testRetryReadsOnlyTheTarget() async {
    let h = Harness()
    await h.startOpen()
    h.reader.answerSession(.failure(.transport("offline")))
    _ = h.sync.showAgent(id: "ags_1")
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.details.last, .failed)
    let decisions = h.reader.decisionCalls
    let agents = h.reader.agentCalls

    h.reader.alwaysAnswerSession(.success(agent))
    h.sync.retryAgent()
    await h.settled(sleeps: 4)
    XCTAssertEqual(h.reader.decisionCalls, decisions)
    XCTAssertEqual(h.reader.agentCalls, agents)
    XCTAssertEqual(h.reader.sessionReads.count, 2)
    XCTAssertEqual(h.reader.historyReads.count, 2)
    XCTAssertEqual(h.details.last, .loaded(agent, []))
    XCTAssertEqual(h.clock.requests.last, 5, "any success resets the cadence")
  }

  func testRetryWithNoTargetReadsNothing() async {
    let h = Harness()
    await h.startOpen()
    let decisions = h.reader.decisionCalls
    h.sync.retryAgent()
    await h.settled(sleeps: 3)
    XCTAssertEqual(h.reader.decisionCalls, decisions)
    XCTAssertEqual(h.reader.sessionReads, [])
  }

  func testARetryNeverDropsAFullReadWaitingForAReadInFlight() async {
    let h = Harness()
    h.sync.start()
    await h.settled(sleeps: 1)
    let gate = h.reader.holdNextRead()
    await h.sync.setOpen(true)
    await eventually("a read in flight") { h.reader.decisionCalls == 2 }
    await h.sync.readNow()
    h.sync.retryAgent()
    try? await Task.sleep(nanoseconds: 20_000_000)
    let agents = h.reader.agentCalls
    await gate.open()
    await eventually("the queued full read") { h.reader.decisionCalls == 3 }
    await h.settled(sleeps: 2)
    XCTAssertEqual(h.reader.agentCalls, agents + 1, "the queued read still reads the agents")
    XCTAssertEqual(h.reader.peakConcurrency, 1, "reads never overlap")
  }

  func testAResultForAnEarlierTargetChangesNothing() async {
    // Each way a target ends, with the read held in flight until after it.
    let endings: [(String, @MainActor (Harness) -> Void)] = [
      ("closed", { $0.sync.hideAgent() }),
      ("another session", { _ = $0.sync.showAgent(id: "ags_2") }),
      ("reopened", { _ = $0.sync.showAgent(id: "ags_1") }),
      ("signed out", { $0.sync.stop() }),
    ]
    for (name, end) in endings {
      let h = Harness()
      await h.startOpen()
      h.reader.answerSession(.failure(.transport("late failure")))
      let gate = h.reader.holdNextSessionRead()
      let first = h.sync.showAgent(id: "ags_1")
      await eventually("the first read in flight") { h.reader.sessionReads.count == 1 }
      end(h)
      await gate.open()
      try? await Task.sleep(nanoseconds: 30_000_000)
      XCTAssertFalse(
        h.details.updates.contains { $0.target == first }, "\(name): the earlier target's result is dropped")
      if name != "signed out" {
        await eventually("\(name): the timer settles") { h.clock.sleeping == 1 }
        XCTAssertNotEqual(
          h.clock.requests.last, 30, "\(name): a dropped failure does not back off")
      }
    }
  }

  func testTheNewTargetsResultLandsAfterASwitch() async {
    let h = Harness()
    await h.startOpen()
    let gate = h.reader.holdNextSessionRead()
    let first = h.sync.showAgent(id: "ags_1")
    await eventually("the first read in flight") { h.reader.sessionReads.count == 1 }
    let second = Fixtures.session("ags_2")
    h.reader.alwaysAnswerSession(.success(second))
    let target = h.sync.showAgent(id: "ags_2")
    XCTAssertNotEqual(first, target)
    await gate.open()
    await eventually("the second target's result") { h.details.updates.contains { $0.target == target } }
    XCTAssertEqual(h.details.updates.map(\.target), [target])
    XCTAssertEqual(h.reader.sessionReads, ["ags_1", "ags_2"])
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

  /// A 401 without the contract body is an ordinary failed read for `Sync`,
  /// as when it mapped to a transport failure; `APIClient` signs the account
  /// out on any HTTP 401, which stops the run through `Account`.
  func testNonContractUnauthorizedBacksOffLikeAnyFailure() async {
    let h = Harness()
    h.reader.alwaysAnswerDecisions(.failure(.http(status: 401)))
    h.sync.start()
    await h.settled(sleeps: 1)
    XCTAssertEqual(h.clock.requests.last, 30)
    let running = await h.sync.isRunning
    XCTAssertTrue(running)
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
