import Foundation

/// The read the detail panel makes. `APIClient` provides it.
public protocol DecisionReader: Sendable {
  func decision(id: String) async throws(APIError) -> Decision
}

extension APIClient: DecisionReader {}

/// The decision the detail panel shows and its reads (component-mac-app
/// §Detail panel; req-mac-app AC-11.2, AC-11.5, AC-11.6).
///
/// The panel reads its target at once and every 5 seconds while it shows it,
/// except that Undo shows the record it held and reads first after 5 seconds,
/// apart from the pending-only list, so a target that leaves the list shows
/// its recorded outcome instead of closing. Each target has a token, so a
/// response for a closed, replaced, or signed-out target changes nothing.
///
/// | Answer to the read | Panel |
/// | --- | --- |
/// | 2xx | shows the decision, which reads as its recorded outcome once settled |
/// | 403, 404 | a neutral message and no controls; reading stops |
/// | 401, signed out | nothing; the account signs out, which resets the panel |
/// | anything else, with nothing loaded yet | a message with Try Again; reading continues |
/// | anything else, with a decision loaded | the decision stays, marked as not refreshed |
@MainActor
public final class DecisionDetail {
  public static let refreshInterval: TimeInterval = 5

  public enum Content: Equatable, Sendable {
    case loading
    case loaded(Decision)
    /// Missing or not this account's.
    case unavailable
    /// A transient failure with nothing to show yet; Try Again reads again.
    case failed
  }

  public private(set) var panel = DetailPanelState()
  /// Nil while the panel is closed.
  public private(set) var content: Content?
  /// The last read failed and `content` holds an older record.
  public private(set) var refreshFailed = false
  /// Runs on the main actor after every change.
  public var onChange: (@MainActor () -> Void)?

  private let reader: any DecisionReader
  private let clock: any SyncClock
  private var token = 0
  private var reading: Task<Void, Never>?
  /// A notification opened this target from a list that may be behind: a
  /// first read finding it settled or gone closes the panel instead of showing
  /// it (req-mac-app AC-6.4).
  private var closesIfStale = false

  public init(reader: any DecisionReader, clock: any SyncClock = SystemSignInClock()) {
    self.reader = reader
    self.clock = clock
  }

  public var shownID: String? { panel.shownID }

  /// The record shown, when one is loaded.
  public var decision: Decision? {
    if case .loaded(let decision)? = content { return decision }
    return nil
  }

  /// Opens the target, or closes the panel when it already shows it. `known`
  /// is the list's record, shown until the first read answers.
  public func toggle(_ id: String, known: Decision?) {
    if panel.shownID == id {
      close()
    } else {
      show(id, known: known)
    }
  }

  /// Shows the target in the panel. Showing the shown target changes nothing.
  public func show(_ id: String, known: Decision?, closesIfStale: Bool = false) {
    guard panel.shownID != id else { return }
    panel.show(id)
    start(id, known: known, closesIfStale: closesIfStale)
  }

  public func close() {
    stopReading()
    guard panel.shownID != nil else { return }
    panel.close()
    content = nil
    refreshFailed = false
    changed()
  }

  /// Try Again after a transient failure.
  public func retry() {
    guard let id = panel.shownID else { return }
    start(id, known: decision, closesIfStale: closesIfStale)
  }

  /// An answer is held: a panel showing that decision closes (AC-4.8).
  public func answerHeld(_ id: String) {
    let wasShown = panel.shownID == id
    panel.answerHeld(id)
    guard wasShown else { return }
    stopReading()
    content = nil
    refreshFailed = false
    changed()
  }

  /// The held answer was undone: the panel reopens from `known` when that
  /// answer closed it, with no read until the next refresh.
  public func answerUndone(_ id: String, known: Decision?) {
    guard panel.reopenOnUndo == id else {
      panel.answerUndone(id)
      return
    }
    let wasShown = panel.shownID == id
    panel.answerUndone(id)
    if !wasShown { start(id, known: known, closesIfStale: false, readsAtOnce: false) }
  }

  /// Sign-out: nothing of the old account stays, and no late read lands.
  public func reset() {
    stopReading()
    panel.reset()
    content = nil
    refreshFailed = false
    changed()
  }

  // MARK: Reading

  private func stopReading() {
    token += 1
    reading?.cancel()
    reading = nil
  }

  private func start(
    _ id: String, known: Decision?, closesIfStale: Bool, readsAtOnce: Bool = true
  ) {
    stopReading()
    self.closesIfStale = closesIfStale
    content = known.map(Content.loaded) ?? .loading
    refreshFailed = false
    let token = self.token
    let reader = self.reader
    let clock = self.clock
    reading = Task { [weak self] in
      if !readsAtOnce {
        do {
          try await clock.sleep(seconds: Self.refreshInterval)
        } catch {
          return
        }
      }
      while !Task.isCancelled {
        let result = await Self.read(id, reader: reader)
        guard let self, self.token == token else { return }
        guard self.apply(result) else { return }
        do {
          try await clock.sleep(seconds: Self.refreshInterval)
        } catch {
          return
        }
      }
    }
    changed()
  }

  private nonisolated static func read(
    _ id: String, reader: any DecisionReader
  ) async -> Result<Decision, APIError> {
    do throws(APIError) {
      return .success(try await reader.decision(id: id))
    } catch {
      return .failure(error)
    }
  }

  /// Applies one read. Returns false when reading stops.
  private func apply(_ result: Result<Decision, APIError>) -> Bool {
    switch result {
    case .success(let decision):
      if closesIfStale, decision.state != .pending {
        close()
        return false
      }
      closesIfStale = false
      let next = Content.loaded(decision)
      guard next != content || refreshFailed else { return true }
      content = next
      refreshFailed = false
    case .failure(let error):
      if error == .signedOut || error.httpStatus == 401 { return false }
      if error.status == 403 || error.status == 404 {
        if closesIfStale {
          close()
          return false
        }
        content = .unavailable
        refreshFailed = false
        changed()
        return false
      }
      if case .loaded? = content {
        guard !refreshFailed else { return true }
        refreshFailed = true
      } else {
        guard content != .failed else { return true }
        content = .failed
      }
    }
    changed()
    return true
  }

  private func changed() {
    onChange?()
  }
}

/// What the detail panel shows for one decision (req-mac-app AC-11.2,
/// AC-11.6), in the mobile decision screen's terms (req-mobile-app AC-3.1).
public struct DecisionDetailModel: Equatable, Sendable, Identifiable {
  /// A parent or follow-up link, which shows that decision in the panel.
  public struct Link: Equatable, Sendable, Identifiable {
    public let id: String
    public let text: String
  }

  public let id: String
  public let title: String
  public let agentName: String
  public let age: String
  public let body: String?
  public let topic: String
  public let urgentMarker: String?
  public let isPending: Bool
  /// The recommended answer as the user reads it.
  public let recommendation: String?
  /// "2:00 PM", "No deadline" while pending, or nil on a settled decision
  /// that had none.
  public let deadline: String?
  public let timeLeft: String?
  public let timeLeftIsRed: Bool
  /// The default sentence while pending, "No default" when there is none, or
  /// the default answer on a settled decision.
  public let defaultAnswer: String?
  /// The recorded outcome, on a decision that is not pending.
  public let outcome: DecisionOutcome?
  public let parent: Link?
  public let followUps: [Link]

  /// `titles` names related decisions the app already holds. A related
  /// decision it does not hold reads by its position, as the mobile screen
  /// does while one loads.
  public init(
    decision: Decision, agents: [AgentSession], titles: [String: String], now: Date,
    calendar: Calendar = .current, locale: Locale = .current
  ) {
    id = decision.id
    title = decision.title
    agentName = DecisionPresentation.agentName(for: decision, agents: agents)
    age = DecisionPresentation.age(since: decision.createdAt, now: now)
    body = decision.body.flatMap { $0.isEmpty ? nil : $0 }
    topic = decision.topic
    let urgent = Attention.isUrgent(decision)
    urgentMarker = urgent ? "Urgent" : nil
    let pending = decision.state == .pending
    isPending = pending
    recommendation = DecisionPresentation.suggestion(for: decision)
    if let due = decision.deadline {
      deadline = DecisionPresentation.time(due, now: now, calendar: calendar, locale: locale)
      timeLeft = pending ? DecisionPresentation.timeLeft(until: due, now: now) : nil
    } else {
      deadline = pending ? "No deadline" : nil
      timeLeft = nil
    }
    timeLeftIsRed = pending && (urgent || Attention.isDueSoon(decision, now: now))
    let fallback = decision.defaultAnswer.map {
      DecisionPresentation.answerText($0, options: decision.options)
    }
    if pending {
      defaultAnswer =
        DecisionPresentation.defaultSentence(for: decision, now: now, calendar: calendar, locale: locale)
        ?? fallback ?? "No default"
    } else {
      defaultAnswer = fallback
    }
    outcome = DecisionPresentation.settledOutcome(decision, now: now, calendar: calendar, locale: locale)
    parent = decision.parentID.map { id in
      Link(id: id, text: titles[id].map { "Follow-up to \($0)" } ?? "Parent decision")
    }
    followUps = decision.followUpIDs.enumerated().map { index, id in
      Link(id: id, text: titles[id] ?? "Follow-up decision \(index + 1)")
    }
  }
}

/// A settled decision's recorded outcome, as the panel shows it
/// (req-mac-app AC-11.6; req-decision-requests AC-4.3, AC-5.1, AC-8.3).
public struct DecisionOutcome: Equatable, Sendable {
  public let summary: String
  /// When the answer landed.
  public let time: String?
  /// The user's message, for an answer given in chat, shown word for word.
  public let chatMessage: String?
  public let note: String?
}
