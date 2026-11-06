import Foundation

/// Joins the pending list, the detail panel, the answer drafts, and the held
/// answers, so an answer to a decision the list does not hold can recover
/// (component-mac-app §Pending answers; req-mac-app AC-4.7, AC-4.8, AC-11.5).
/// `AppState` delegates to it, and the tests drive the same object.
///
/// A list read can be behind a decision the panel loaded through a link. The
/// coordinator retains that pending record, and the list merges it, so Undo and
/// a failed send both restore a row with its draft and failure message at once.
///
/// | Evidence about a retained decision | Result |
/// | --- | --- |
/// | a publish that repeats the last decisions read | nothing changes |
/// | a new decisions read that lists it | the read's record takes over |
/// | a new decisions read that omits it | one direct read of the decision |
/// | a direct read or the panel's read: still pending, or a transient failure | stays retained |
/// | a direct read or the panel's read: settled, or a contract 403 or 404 | its record, draft, and failure message go |
/// | a send that lands, finds it gone, or conflicts | its record and draft go |
/// | sign-out | everything goes, and a late read changes nothing |
@MainActor
public final class DecisionCoordinator {
  public let pending: PendingAnswers
  public let detail: DecisionDetail
  /// The agent session the panel shows. The panel shows one target, so showing
  /// a session ends the decision's reads, and showing a decision ends the
  /// session's.
  public let agent: AgentDetail
  /// Each decision's answer in progress, kept while it is pending.
  public var drafts: [String: AnswerDraft] = [:]
  /// Runs on the main actor after the list, the answers, or the drafts change.
  public var onAnswersChange: (@MainActor () -> Void)?
  /// Runs on the main actor after the panel's target or content changes.
  public var onDetailChange: (@MainActor () -> Void)?

  private let reader: any DecisionReader
  /// The decisions the last read listed.
  private var snapshot: [Decision] = []
  /// Pending records the last read does not list.
  private var retained: [String: Decision] = [:]
  private var verifying: Set<String> = []
  /// Moves on sign-out, so a late direct read changes nothing.
  private var generation = 0
  /// True while one target replaces another, so the window sees one change.
  private var isReplacingTarget = false

  public init(
    sender: any AnswerSender, reader: any DecisionReader, clock: any SyncClock = SystemSignInClock(),
    agentReads: any AgentDetailReads = NoAgentDetailReads()
  ) {
    self.reader = reader
    pending = PendingAnswers(sender: sender, clock: clock)
    detail = DecisionDetail(reader: reader, clock: clock)
    agent = AgentDetail(reads: agentReads)
    pending.onChange = { [weak self] in self?.onAnswersChange?() }
    pending.onRestore = { [weak self] in self?.restore($0) }
    pending.onComplete = { [weak self] in self?.complete($0, $1) }
    detail.onChange = { [weak self] in self?.detailChanged() }
    agent.onChange = { [weak self] in self?.panelChanged() }
  }

  // MARK: Reads

  /// The pending decisions the list shows, retained records included, without
  /// the ones whose answer is held, sending, or recorded from this Mac.
  public var listed: [Decision] {
    let held = Set(snapshot.map(\.id))
    let extra = retained.values.filter { !held.contains($0.id) }
    return DecisionOrder.sorted(snapshot + extra).filter { !pending.hides($0.id) }
  }

  /// The ids of pending records the list holds only because they are retained.
  public var retainedIDs: Set<String> { Set(retained.keys) }

  /// A listed decision, or a pending one the panel shows.
  public func record(_ id: String) -> Decision? {
    if let listed = listed.first(where: { $0.id == id }) { return listed }
    guard let shown = detail.decision, shown.id == id, shown.state == .pending, !pending.hides(id)
    else { return nil }
    return shown
  }

  /// Whether the panel shows a decision that can take an answer now.
  public var shownIsAnswerable: Bool {
    guard let shown = detail.decision else { return false }
    return shown.state == .pending && !pending.hides(shown.id)
  }

  // MARK: The list

  /// A sync publish. Only a new decisions read is evidence about what is
  /// pending: a publish that repeats the last read prunes nothing.
  public func applySnapshot(_ decisions: [Decision], isNewRead: Bool) {
    snapshot = decisions
    guard isNewRead else { return }
    let ids = Set(decisions.map(\.id))
    retained = retained.filter { !ids.contains($0.key) }
    let shownPending = detail.decision.flatMap { $0.state == .pending ? $0.id : nil }
    drafts = drafts.filter {
      ids.contains($0.key) || retained[$0.key] != nil || $0.key == shownPending
    }
    pending.reconcile(pending: ids.union(retained.keys))
    verifyRetained()
  }

  /// Reads each retained decision a new read omitted, once at a time. A held or
  /// sending answer resolves its own decision, and the panel reads its own.
  private func verifyRetained() {
    let generation = self.generation
    for id in retained.keys
    where !verifying.contains(id) && !pending.hides(id) && detail.shownID != id {
      verifying.insert(id)
      let reader = self.reader
      Task { [weak self] in
        let result = await Self.read(id, reader: reader)
        guard let self, self.generation == generation else { return }
        self.verifying.remove(id)
        self.applyDirectRead(id, result)
      }
    }
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

  private func applyDirectRead(_ id: String, _ result: Result<Decision, APIError>) {
    guard retained[id] != nil else { return }
    switch result {
    case .success(let decision) where decision.state == .pending:
      retained[id] = decision
    case .success:
      forget(id)
    case .failure(let error):
      guard error.status == 403 || error.status == 404 else { return }
      forget(id)
    }
    onAnswersChange?()
  }

  /// Confirmed settled or gone: nothing of the decision stays on this Mac.
  private func forget(_ id: String) {
    retained[id] = nil
    drafts[id] = nil
    pending.forgetFailure(id)
  }

  // MARK: The panel

  /// What the panel shows, or nil while it is closed.
  public var panelTarget: DetailPanelTarget? {
    if let id = detail.shownID { return .decision(id) }
    if let id = agent.shownID { return .agent(id) }
    return nil
  }

  /// Opens the row in the panel, or closes the panel when it shows that row.
  public func toggle(_ id: String) {
    replacingTarget {
      agent.close()
      detail.toggle(id, known: record(id))
    }
  }

  /// Shows a linked decision or a notification's target in the panel.
  public func show(_ id: String, closesIfStale: Bool = false) {
    replacingTarget {
      agent.close()
      detail.show(id, known: record(id), closesIfStale: closesIfStale)
    }
  }

  /// Opens the agent session in the panel, or closes the panel when it shows
  /// that session (req-mac-app AC-5.3, AC-11.7). `known` is the list's record,
  /// shown until the first reads answer.
  public func toggleAgent(_ id: String, known: AgentSession?) {
    replacingTarget {
      detail.close()
      agent.toggle(id, known: known)
    }
  }

  /// Closes the panel whichever target it shows.
  public func closePanel() {
    replacingTarget {
      detail.close()
      agent.close()
    }
  }

  /// Runs a change of target as one change for the window, so replacing a
  /// target never hides and shows the panel.
  private func replacingTarget(_ change: () -> Void) {
    let outer = !isReplacingTarget
    isReplacingTarget = true
    change()
    guard outer else { return }
    isReplacingTarget = false
    onDetailChange?()
  }

  private func detailChanged() {
    if let shown = detail.decision {
      let id = shown.id
      if shown.state != .pending {
        forget(id)
      } else if !pending.hides(id) {
        if drafts[id] == nil { drafts[id] = .forPanel(shown) }
        if !snapshot.contains(where: { $0.id == id }) { retained[id] = shown }
      }
    } else if detail.content == .unavailable, let id = detail.shownID {
      forget(id)
    }
    panelChanged()
  }

  private func panelChanged() {
    guard !isReplacingTarget else { return }
    onDetailChange?()
  }

  // MARK: Answers

  /// Reject or Approve, with the decision's note.
  public func answer(_ id: String, _ answer: Answer) {
    guard let decision = record(id) else { return }
    let draft = drafts[id] ?? AnswerDraft(decision: decision)
    guard let submission = draft.submission(for: answer) else { return }
    hold(decision, submission, draft: drafts[id])
  }

  /// Send, or ⌘↩: the chosen answer, or the recommendation when none is
  /// chosen. Sends nothing when neither exists (req-mac-app AC-7.1).
  public func send(_ id: String) {
    guard let decision = record(id) else { return }
    let draft = drafts[id] ?? AnswerDraft(decision: decision)
    guard let submission = draft.submission else { return }
    hold(decision, submission, draft: drafts[id])
  }

  private func hold(_ decision: Decision, _ submission: AnswerDraft.Submission, draft: AnswerDraft?) {
    guard pending.answer(decision, submission, draft: draft) else { return }
    let id = decision.id
    if !snapshot.contains(where: { $0.id == id }) { retained[id] = decision }
    drafts[id] = nil
    detail.answerHeld(id)
    onAnswersChange?()
  }

  /// Undo restores the row and the draft it had, reopens the panel when the
  /// answer closed it, and neither reads nor sends (req-mac-app AC-4.8).
  /// Returns the decision's id.
  @discardableResult
  public func undo() -> String? {
    guard let attempt = pending.undo() else { return nil }
    let id = attempt.decision.id
    if let draft = attempt.draft { drafts[id] = draft }
    replacingTarget {
      // Reopening the decision replaces an agent session the panel shows.
      if detail.panel.reopenOnUndo == id { agent.close() }
      detail.answerUndone(id, known: attempt.decision)
    }
    onAnswersChange?()
    return id
  }

  /// A failed send: the row comes back with its draft and failure message
  /// without another read, listed or not.
  private func restore(_ attempt: PendingAnswers.Attempt) {
    let id = attempt.decision.id
    if let draft = attempt.draft { drafts[id] = draft }
    if !snapshot.contains(where: { $0.id == id }) { retained[id] = attempt.decision }
  }

  private func complete(_ attempt: PendingAnswers.Attempt, _ outcome: PendingAnswers.Outcome) {
    switch outcome {
    case .sent, .notFound, .conflict:
      retained[attempt.decision.id] = nil
      drafts[attempt.decision.id] = nil
    case .signedOut, .failed:
      break
    }
  }

  // MARK: Account

  /// Sign-out: nothing of the old account stays, and no late read lands.
  public func reset() {
    generation += 1
    verifying = []
    retained = [:]
    snapshot = []
    drafts = [:]
    pending.reset()
    replacingTarget {
      detail.reset()
      agent.reset()
    }
  }
}
