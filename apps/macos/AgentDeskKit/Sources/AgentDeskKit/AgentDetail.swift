import Foundation

/// One target of the panel's agent reads. The generation moves on every change
/// of target, so a result for a closed, replaced, or reopened target matches
/// nothing.
public struct AgentDetailTarget: Equatable, Sendable {
  public let id: String
  public let generation: Int

  public init(id: String, generation: Int) {
    self.id = id
    self.generation = generation
  }
}

/// What the history read found for a session the server has.
public enum AgentHistory: Equatable, Sendable {
  /// The route answered, newest first in the server's order. It may be empty.
  case available([StatusHistoryEntry])
  /// The route answered a contract `not_found`, so this server has no history
  /// to show. Reading continues, so history appears once the route answers.
  case unavailable
}

/// What one read of a session and its history found.
public enum AgentDetailOutcome: Equatable, Sendable {
  /// The session answered, and the history answered or is unavailable.
  case loaded(AgentSession, AgentHistory)
  /// A contract `not_found` from the session request. Reading has stopped.
  case gone
  /// Any other failure of either request. Reading continues under backoff.
  case failed
}

public struct AgentDetailUpdate: Equatable, Sendable {
  public let target: AgentDetailTarget
  public let outcome: AgentDetailOutcome

  public init(target: AgentDetailTarget, outcome: AgentDetailOutcome) {
    self.target = target
    self.outcome = outcome
  }
}

/// The panel's reads of an agent session. `Sync` provides them on its one timer.
public protocol AgentDetailReads: Sendable {
  func showAgent(id: String) -> AgentDetailTarget
  func hideAgent()
  func retryAgent()
}

extension Sync: AgentDetailReads {}

/// Reads nothing: a coordinator with no agent panel.
public struct NoAgentDetailReads: AgentDetailReads {
  public init() {}
  public func showAgent(id: String) -> AgentDetailTarget { AgentDetailTarget(id: id, generation: 0) }
  public func hideAgent() {}
  public func retryAgent() {}
}

/// The agent session the detail panel shows (component-mac-app §Detail panel;
/// req-mac-app AC-5.3, AC-11.3, AC-11.4, AC-11.7, AC-11.10, AC-11.12).
///
/// | Read of the session and its history | Panel |
/// | --- | --- |
/// | both answer | the session and its history |
/// | the session answers, history contract `not_found` | the session with its history unavailable, and no warning; reading continues |
/// | session contract `not_found` | "This agent session is gone."; reading stops |
/// | 401, signed out | nothing; the account signs out, which resets the panel |
/// | any other failure, no session read yet | the list's record, if any, with a failure and Try Again |
/// | any other failure, a session loaded | the session and its history state stay, marked as not refreshed |
@MainActor
public final class AgentDetail {
  public enum Content: Equatable, Sendable {
    /// Before the first read answers, with the list's record when it holds one.
    case loading(AgentSession?)
    case loaded(AgentSession, AgentHistory)
    /// A transient failure before the first read answers; Try Again reads again.
    case failed(AgentSession?)
    case gone
  }

  public private(set) var shownID: String?
  /// Nil while no session is shown.
  public private(set) var content: Content?
  /// The last read failed and `content` holds an older read.
  public private(set) var refreshFailed = false
  /// Runs on the main actor after every change.
  public var onChange: (@MainActor () -> Void)?
  /// Opens a link in the default browser. Only `openLink()` calls it, so
  /// nothing else in the agent panel can open a browser (AC-11.4).
  public var opener: (@MainActor (URL) -> Void)?

  private let reads: any AgentDetailReads
  private var target: AgentDetailTarget?

  public init(reads: any AgentDetailReads) {
    self.reads = reads
  }

  /// The session shown, from the last read or the list's record.
  public var session: AgentSession? {
    switch content {
    case .loading(let seed)?, .failed(let seed)?: seed
    case .loaded(let session, _)?: session
    case .gone?, nil: nil
    }
  }

  /// The link the Open link control opens, when it is an absolute http or
  /// https URL.
  public var link: URL? {
    session?.link.flatMap(AgentEntryModel.webURL)
  }

  /// Opens the session, or closes the panel when it already shows it.
  public func toggle(_ id: String, known: AgentSession?) {
    if shownID == id {
      close()
    } else {
      show(id, known: known)
    }
  }

  public func show(_ id: String, known: AgentSession?) {
    guard shownID != id else { return }
    shownID = id
    content = .loading(known)
    refreshFailed = false
    target = reads.showAgent(id: id)
    changed()
  }

  public func close() {
    guard shownID != nil else { return }
    clear()
    changed()
  }

  /// Try Again: reads this target only, and keeps a loaded session on screen.
  public func retry() {
    guard shownID != nil else { return }
    if case .failed(let seed)? = content {
      content = .loading(seed)
      changed()
    }
    reads.retryAgent()
  }

  /// The Open link control (AC-11.4). Returns whether it opened anything.
  @discardableResult
  public func openLink() -> Bool {
    guard let link, let opener else { return false }
    opener(link)
    return true
  }

  /// Sign-out: nothing of the old account stays, and no late read lands.
  public func reset() {
    clear()
    changed()
  }

  /// One read's result. A result for any other target changes nothing.
  public func apply(_ update: AgentDetailUpdate) {
    guard let target, update.target == target else { return }
    switch update.outcome {
    case .loaded(let session, let history):
      let next = Content.loaded(session, history)
      guard next != content || refreshFailed else { return }
      content = next
      refreshFailed = false
    case .gone:
      content = .gone
      refreshFailed = false
    case .failed:
      switch content {
      case .loaded?:
        guard !refreshFailed else { return }
        refreshFailed = true
      case .loading(let seed)?:
        content = .failed(seed)
      case .failed?, .gone?, nil:
        return
      }
    }
    changed()
  }

  private func clear() {
    reads.hideAgent()
    shownID = nil
    target = nil
    content = nil
    refreshFailed = false
  }

  private func changed() {
    onChange?()
  }
}

/// What the detail panel shows for one agent session (req-mac-app AC-11.3), in
/// the mobile agent screen's terms. Its link is a value; only the panel's Open
/// link control acts on it.
public struct AgentDetailModel: Equatable, Sendable, Identifiable {
  /// A pending decision of this session, which shows that decision in the panel
  /// (AC-11.5).
  public struct PendingDecision: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let age: String
    public let timeLeft: String?
    public let timeLeftIsRed: Bool
    public let urgentMarker: String?

    /// What VoiceOver reads beside the title, so no state is carried by color
    /// alone (AC-11.11).
    public var accessibilityValue: String {
      [urgentMarker, timeLeft, age].compactMap { $0 }.joined(separator: ", ")
    }
  }

  /// A previous status. Its link stays inert text (AC-11.4).
  public struct HistoryEntry: Equatable, Sendable, Identifiable {
    /// The entry's place in the server's order: history rows have no id.
    public let id: Int
    public let state: String
    public let line: String
    public let age: String
    public let link: String?
  }

  /// What the panel knows of the session's previous statuses.
  public enum History: Equatable, Sendable {
    /// Before the first read answers.
    case unread
    /// The server has no history route for this session (AC-11.12).
    case unavailable
    /// Newest first, as the server returned them. It may be empty.
    case available([HistoryEntry])

    /// The rows a successful read returned, and nil otherwise.
    public var entries: [HistoryEntry]? {
      if case .available(let entries) = self { return entries }
      return nil
    }
  }

  public let id: String
  /// "Working", "Blocked", or "No status yet" for a session with no status.
  public let state: String
  public let isBlocked: Bool
  /// The time since the last status update, or "No update yet".
  public let updateAge: String
  public let line: String?
  public let displayName: String
  public let topic: String
  public let staleMarker: String?
  public let pendingCount: Int
  public let pendingCountText: String
  public let pending: [PendingDecision]
  /// False until a decisions read has succeeded, so an unread list never reads
  /// as "No pending decisions" beside a positive count.
  public let pendingIsKnown: Bool
  public let history: History
  /// The link Open link opens, when it is an absolute http or https URL.
  public let link: URL?

  /// `decisions` is the complete pending snapshot; the session's own count
  /// comes from the session (AC-11.3). `history` is nil before the first read
  /// answers. `decisionsAreKnown` is false until the snapshot holds a
  /// successful decisions read.
  public init(
    session: AgentSession, history: AgentHistory?, decisions: [Decision], now: Date,
    decisionsAreKnown: Bool = true
  ) {
    pendingIsKnown = decisionsAreKnown
    id = session.id
    state = Self.stateText(session.state)
    isBlocked = session.state == .blocked
    updateAge = session.statusAt.map { DecisionPresentation.age(since: $0, now: now) } ?? "No update yet"
    line = session.line
    displayName = session.displayName
    topic = session.topic
    staleMarker = session.stale ? "Stale" : nil
    pendingCount = session.pendingDecisionCount
    pendingCountText =
      session.pendingDecisionCount == 1
      ? "1 pending decision" : "\(session.pendingDecisionCount) pending decisions"
    pending = decisions.filter { $0.agentSessionID == session.id && $0.state == .pending }.map { decision in
      let urgent = Attention.isUrgent(decision)
      return PendingDecision(
        id: decision.id, title: decision.title,
        age: DecisionPresentation.age(since: decision.createdAt, now: now),
        timeLeft: decision.deadline.map { DecisionPresentation.timeLeft(until: $0, now: now) },
        timeLeftIsRed: urgent || Attention.isDueSoon(decision, now: now),
        urgentMarker: urgent ? "Urgent" : nil)
    }
    switch history {
    case nil:
      self.history = .unread
    case .unavailable:
      self.history = .unavailable
    case .available(let entries):
      self.history = .available(
        entries.enumerated().map { index, entry in
          HistoryEntry(
            id: index, state: Self.stateText(entry.state), line: entry.line,
            age: DecisionPresentation.age(since: entry.at, now: now), link: entry.link)
        })
    }
    link = session.link.flatMap(AgentEntryModel.webURL)
  }

  /// One line for VoiceOver with what the status card shows, so no state is
  /// carried by color or weight alone (AC-11.11).
  public var statusAccessibilityLabel: String {
    [state, updateAge, staleMarker].compactMap { $0 }.joined(separator: ", ")
  }

  private static func stateText(_ state: AgentSession.State?) -> String {
    guard let state else { return "No status yet" }
    return state.rawValue.prefix(1).uppercased() + state.rawValue.dropFirst()
  }
}
