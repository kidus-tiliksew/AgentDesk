import Foundation
import OSLog

/// The two requests an answer makes. `APIClient` provides them.
public protocol AnswerSender: Sendable {
  func answer(id: String, answer: Answer, note: String?) async throws(APIError) -> Decision
  func decision(id: String) async throws(APIError) -> Decision
}

extension APIClient: AnswerSender {}

/// Holds an answer for 4 seconds so the user can undo it, then sends it
/// (component-mac-app §Pending answers; req-mac-app AC-4.8, AC-4.9).
///
/// At most one answer is held. A second answer, the timer, closing the
/// popover, and quitting the app each call `flush()`, which moves the held
/// answer out of the hold before any request starts, so overlapping triggers
/// post it once. A held or sending answer hides its row; so does a decision
/// this Mac settled, until a read no longer lists it, so a read taken before
/// the answer landed cannot bring the row back.
///
/// | Answer to the post | Result |
/// | --- | --- |
/// | 2xx | the row stays gone |
/// | 409 | reads the decision and shows its recorded outcome for 4 s; the attempt is discarded |
/// | 404 | the row stays gone |
/// | 401 or signed out | nothing; the account signs out |
/// | anything else | the row returns with its draft and "Couldn't send. Try again." |
///
/// Each attempt has an id and each account a generation, so a late answer
/// for an undone, replaced, or signed-out attempt changes nothing.
@MainActor
public final class PendingAnswers {
  public static let holdDuration: TimeInterval = 4
  public static let outcomeDuration: TimeInterval = 4
  public static let failureMessage = "Couldn't send. Try again."
  /// The strip after a 409 whose follow-up read failed: the server refused
  /// the answer, and the app does not know what it recorded instead.
  public static let unreadOutcome = "Settled elsewhere. Couldn't read the outcome."

  /// One answer on its way to the server.
  public struct Attempt: Equatable, Sendable {
    public let id: Int
    public let decision: Decision
    public let submission: AnswerDraft.Submission
    /// The expanded row's draft when the user answered, restored with the
    /// row on undo or failure.
    public let draft: AnswerDraft?
  }

  /// How one attempt ended.
  public enum Outcome: Equatable, Sendable {
    case sent
    /// The decision was settled elsewhere. `recorded` is the outcome the
    /// server holds, or nil when it could not be read.
    case conflict(recorded: String?)
    case notFound
    case signedOut
    /// Any other failure; the row returns.
    case failed
  }

  public private(set) var held: Attempt?
  /// Attempts whose request is in flight, by decision id.
  public private(set) var sending: [String: Attempt] = [:]
  /// The message under each restored row, by decision id.
  public private(set) var failures: [String: String] = [:]
  /// The recorded outcome of a conflict, shown for 4 seconds.
  public private(set) var outcome: String?

  /// Runs on the main actor after every change.
  public var onChange: (@MainActor () -> Void)?
  /// Runs when an attempt fails and its row returns, so the app restores
  /// its draft.
  public var onRestore: (@MainActor (Attempt) -> Void)?

  private let sender: any AnswerSender
  private let clock: any SyncClock
  private var nextID = 0
  private var generation = 0
  private var settled: Set<String> = []
  private var holdTimer: Task<Void, Never>?
  private var outcomeTimer: Task<Void, Never>?
  private var outcomeToken = 0
  private var tasks: [Int: Task<Outcome, Never>] = [:]

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "answers")

  public init(sender: any AnswerSender, clock: any SyncClock = SystemSignInClock()) {
    self.sender = sender
    self.clock = clock
  }

  // MARK: Reads

  /// Whether the list leaves the decision out: its answer is held or
  /// sending, or this Mac settled it and no read has dropped it yet.
  public func hides(_ id: String) -> Bool {
    held?.decision.id == id || sending[id] != nil || settled.contains(id)
  }

  /// The Undo strip's text while an answer is held.
  public var undoText: String? {
    held.map { DecisionPresentation.undoText($0.submission.answer, decision: $0.decision) }
  }

  /// Whether quitting has anything to wait for.
  public var hasUnsent: Bool { held != nil || !tasks.isEmpty }

  // MARK: Actions

  /// Holds an answer for 4 seconds, sending any answer already held first.
  /// Returns false, and holds nothing, for a decision whose row is hidden.
  @discardableResult
  public func answer(
    _ decision: Decision, _ submission: AnswerDraft.Submission, draft: AnswerDraft? = nil
  ) -> Bool {
    guard !hides(decision.id) else { return false }
    flush()
    nextID += 1
    let attempt = Attempt(id: nextID, decision: decision, submission: submission, draft: draft)
    held = attempt
    failures[decision.id] = nil
    let clock = self.clock
    let generation = self.generation
    holdTimer = Task { [weak self] in
      do {
        try await clock.sleep(seconds: Self.holdDuration)
      } catch {
        return
      }
      self?.holdExpired(attempt.id, generation: generation)
    }
    changed()
    return true
  }

  /// Cancels the held answer and returns it, so the row and its draft come
  /// back. Nothing is sent.
  @discardableResult
  public func undo() -> Attempt? {
    guard let attempt = held else { return nil }
    held = nil
    holdTimer?.cancel()
    holdTimer = nil
    changed()
    return attempt
  }

  /// Sends the held answer now. A second call finds nothing held, so each
  /// answer is posted once whichever trigger comes first.
  @discardableResult
  public func flush() -> Task<Outcome, Never>? {
    guard let attempt = held else { return nil }
    held = nil
    holdTimer?.cancel()
    holdTimer = nil
    let task = send(attempt)
    changed()
    return task
  }

  /// Sends the held answer and waits for every request in flight. Returns
  /// false when one of them failed and its row returned, so quitting would
  /// lose the answer.
  public func flushAndWait() async -> Bool {
    flush()
    var delivered = true
    for task in tasks.values {
      if await task.value == .failed { delivered = false }
    }
    return delivered
  }

  /// A read published these pending decisions. A settled decision stays
  /// hidden until a read leaves it out; a failure message goes with its
  /// decision.
  public func reconcile(pending ids: Set<String>) {
    let before = (settled, failures)
    settled.formIntersection(ids)
    failures = failures.filter { ids.contains($0.key) }
    if before.0 != settled || before.1 != failures { changed() }
  }

  /// Clears every attempt without sending it. Signing out calls it; late
  /// answers for the old account change nothing.
  public func reset() {
    generation += 1
    held = nil
    holdTimer?.cancel()
    holdTimer = nil
    outcomeTimer?.cancel()
    outcomeTimer = nil
    sending = [:]
    tasks = [:]
    settled = []
    failures = [:]
    outcome = nil
    changed()
  }

  // MARK: Sending

  private func holdExpired(_ attemptID: Int, generation: Int) {
    guard generation == self.generation, held?.id == attemptID else { return }
    flush()
  }

  private func send(_ attempt: Attempt) -> Task<Outcome, Never> {
    sending[attempt.decision.id] = attempt
    let sender = self.sender
    let generation = self.generation
    let task = Task { [weak self] in
      let outcome = await Self.deliver(attempt, sender: sender)
      self?.complete(attempt, outcome: outcome, generation: generation)
      return outcome
    }
    tasks[attempt.id] = task
    return task
  }

  private func complete(_ attempt: Attempt, outcome: Outcome, generation: Int) {
    guard generation == self.generation, tasks[attempt.id] != nil else { return }
    tasks[attempt.id] = nil
    let id = attempt.decision.id
    if sending[id]?.id == attempt.id { sending[id] = nil }
    Self.log.debug("Answer attempt \(attempt.id, privacy: .public) ended: \(String(describing: outcome), privacy: .public)")
    switch outcome {
    case .sent, .notFound:
      settled.insert(id)
    case .conflict(let recorded):
      settled.insert(id)
      show(outcome: recorded ?? Self.unreadOutcome)
    case .signedOut:
      break
    case .failed:
      failures[id] = Self.failureMessage
      onRestore?(attempt)
    }
    changed()
  }

  private func show(outcome text: String) {
    outcomeToken += 1
    let token = outcomeToken
    outcome = text
    outcomeTimer?.cancel()
    let clock = self.clock
    outcomeTimer = Task { [weak self] in
      do {
        try await clock.sleep(seconds: Self.outcomeDuration)
      } catch {
        return
      }
      guard let self, self.outcomeToken == token else { return }
      self.outcome = nil
      self.changed()
    }
  }

  private func changed() {
    onChange?()
  }

  /// Posts the answer and, on a 409, reads what the server recorded instead.
  /// The attempted answer is never reported as the recorded one.
  nonisolated static func deliver(_ attempt: Attempt, sender: any AnswerSender) async -> Outcome {
    let id = attempt.decision.id
    do throws(APIError) {
      _ = try await sender.answer(
        id: id, answer: attempt.submission.answer, note: attempt.submission.note)
      return .sent
    } catch {
      switch error.status {
      case 409:
        break
      case 404:
        return .notFound
      case 401:
        return .signedOut
      default:
        return error == .signedOut ? .signedOut : .failed
      }
    }
    do throws(APIError) {
      let recorded = try await sender.decision(id: id)
      // A decision still pending refused the answer for another reason, so
      // the row returns rather than claiming an outcome.
      guard let text = DecisionPresentation.recordedOutcome(recorded) else { return .failed }
      return .conflict(recorded: text)
    } catch {
      switch error.status {
      case 404: return .notFound
      case 401: return .signedOut
      default: return error == .signedOut ? .signedOut : .conflict(recorded: nil)
      }
    }
  }
}
