import AgentDeskKit
import AppKit
import Observation
import OSLog

/// The app's observable state: the account, its sign-in, Open at Login, the
/// synced decisions and agents with their attention state, and the answers
/// the user gives from the popover. It sends no request besides sign-in,
/// sign-out, the sync reads, and answers (req-mac-app REQ-10).
@MainActor
@Observable
final class AppState {
  private(set) var isSignedIn: Bool
  private(set) var signInPhase: SignInPhase = .idle
  /// A sign-out result the signed-out view reports.
  private(set) var notice: String?
  private(set) var openAtLogin: Bool
  private(set) var loginItemError: String?

  /// The last good snapshot, decisions in popover order.
  private(set) var snapshot = Sync.Snapshot.empty
  private(set) var seenIDs: Set<String>
  /// The clock the dot and row times read. It moves on every publish and
  /// every 30 seconds (component-mac-app §Ordering and attention).
  private(set) var now = Date()
  private(set) var menuBarStyle: MenuBarStyle
  /// The dot's opacity in the menu bar label; 0 when no dot is drawn.
  private(set) var dotOpacity: Double = 0

  /// The row the arrow keys moved to or the user last opened, by decision
  /// id (req-mac-app AC-7.1).
  private(set) var selectedID: String?
  /// The one expanded row, by decision id (req-mac-app AC-4.6).
  private(set) var expandedID: String?
  /// Each expanded row's answer in progress, kept while its decision is
  /// pending so collapsing a row or a failed send loses nothing.
  var drafts: [String: AnswerDraft] = [:]
  /// Moves on every change of `pending`, which is not observable itself.
  private var answersRevision = 0

  @ObservationIgnored private let account: Account
  @ObservationIgnored private let signIn: SignInController
  @ObservationIgnored private let loginItems: LoginItems
  @ObservationIgnored private let seen: SeenStore
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private var terminationObserver: NSObjectProtocol?
  @ObservationIgnored private var triggers: SyncTriggers?
  @ObservationIgnored private var attentionTimer: Task<Void, Never>?
  @ObservationIgnored private var fade: Task<Void, Never>?
  @ObservationIgnored private var isPopoverOpen = false
  /// Every decision the open popover has listed, marked seen when it closes
  /// (req-mac-app AC-3.3).
  @ObservationIgnored private var listedIDs: Set<String> = []
  @ObservationIgnored private var dot = DotPresence()
  /// The decision ids the list showed last, so the selection can move to a
  /// neighbour when its row leaves.
  @ObservationIgnored private var listedOrder: [String] = []
  @ObservationIgnored private lazy var pending: PendingAnswers = {
    let pending = PendingAnswers(sender: account.api)
    pending.onChange = { [weak self] in self?.answersChanged() }
    pending.onRestore = { [weak self] attempt in self?.restore(attempt) }
    return pending
  }()
  private static let log = Logger(
    subsystem: "sh.kidus.agentdesk.mac", category: "popover")
  @ObservationIgnored private lazy var sync = Sync(reader: account.api) { [weak self] snapshot in
    self?.apply(snapshot)
  }

  init(defaults: UserDefaults = .standard) {
    let account = Account(
      configuration: ServerConfiguration(defaults: defaults), credentials: KeychainCredentialStore())
    self.account = account
    self.defaults = defaults
    signIn = SignInController(
      api: account.api, machineName: Host.current().localizedName ?? "Mac"
    ) { token in try account.signIn(token: token) }
    loginItems = LoginItems(service: MainAppLoginItem(), defaults: defaults)
    seen = SeenStore(defaults: defaults)
    seenIDs = seen.ids
    menuBarStyle = MenuBarStyle(defaults: defaults)
    isSignedIn = account.state == .signedIn
    openAtLogin = loginItems.isOn

    // Sign-out and a 401 stop the sync before anything else clears, so no
    // read publishes into the signed-out state (req-mac-app AC-2.6, AC-2.7).
    account.addCleanup { [weak self] in self?.sync.stop() }
    seen.clearOnSignOut(of: account)
    // Held and sending answers belong to the account that gave them.
    account.addCleanup { [weak self] in self?.clearAnswers() }
    account.onChange = { [weak self] in self?.accountChanged() }
    signIn.onChange = { [weak self] in self?.signInChanged() }
    // Polling stops when the app quits.
    terminationObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.signIn.cancel()
        self?.sync.stop()
      }
    }
    triggers = SyncTriggers { [weak self] in self?.wokeOrReconnected() }
    if isSignedIn {
      startSync()
    }
  }

  // MARK: Derived

  /// The pending decisions the list shows: the snapshot without the ones
  /// whose answer is held, sending, or recorded from this Mac.
  var decisions: [Decision] {
    _ = answersRevision
    return snapshot.decisions.filter { !pending.hides($0.id) }
  }

  var summary: MenuBarSummary {
    MenuBarSummary(decisions: decisions, seen: seenIDs, now: now)
  }

  var rows: [DecisionRowModel] {
    decisions.map {
      DecisionRowModel(decision: $0, agents: snapshot.agents, seen: seenIDs, now: now)
    }
  }

  /// Each listed decision with what its row shows when expanded.
  var listItems: [DecisionListItem] {
    _ = answersRevision
    let failures = pending.failures
    return decisions.map { decision in
      DecisionListItem(
        row: DecisionRowModel(decision: decision, agents: snapshot.agents, seen: seenIDs, now: now),
        decision: decision,
        agentLink: DecisionPresentation.agentLink(for: decision, agents: snapshot.agents),
        defaultSentence: DecisionPresentation.defaultSentence(for: decision, now: now),
        failure: failures[decision.id])
    }
  }

  /// The Undo strip's text while an answer is held (req-mac-app AC-4.8).
  var undoText: String? {
    _ = answersRevision
    return pending.undoText
  }

  /// A conflict's recorded outcome, shown for 4 seconds (req-mac-app AC-4.9).
  var answerOutcome: String? {
    _ = answersRevision
    return pending.outcome
  }

  /// Whether quitting has an answer to send first.
  var hasUnsentAnswers: Bool { pending.hasUnsent }

  /// The menu bar item's VoiceOver description.
  var labelDescription: String {
    isSignedIn ? summary.accessibilityDescription : "AgentDesk, signed out"
  }

  // MARK: Popover

  /// The popover appeared: read at once and poll every 5 seconds.
  func popoverOpened() {
    guard !isPopoverOpen else { return }
    isPopoverOpen = true
    Self.log.debug("Popover opened")
    listedIDs = Set(snapshot.decisions.map(\.id))
    now = Date()
    let sync = self.sync
    Task { await sync.setOpen(true) }
  }

  /// The popover closed: a held answer is sent, and every decision it
  /// listed stops counting as new.
  func popoverClosed() {
    guard isPopoverOpen else { return }
    isPopoverOpen = false
    pending.flush()
    Self.log.debug("Popover closed; \(self.listedIDs.count, privacy: .public) listed")
    seen.markSeen(listedIDs)
    listedIDs = []
    seenIDs = seen.ids
    updateDot()
    let sync = self.sync
    Task { await sync.setOpen(false) }
  }

  func setMenuBarStyle(_ style: MenuBarStyle) {
    guard style != menuBarStyle else { return }
    menuBarStyle = style
    style.save(to: defaults)
    updateDot()
  }

  // MARK: Account

  func startSignIn() {
    notice = nil
    signIn.start()
  }

  func cancelSignIn() {
    signIn.cancel()
  }

  func signOut() {
    Task {
      let outcome = await account.signOut()
      notice = outcome.message
    }
  }

  func setOpenAtLogin(_ on: Bool) {
    loginItems.set(on)
    refreshLoginItem()
  }

  /// Reads the system's status, which the user can change in System Settings.
  func refreshLoginItem() {
    openAtLogin = loginItems.isOn
    loginItemError = loginItems.lastError
  }

  func quit() {
    NSApplication.shared.terminate(nil)
  }

  /// Sends the held answer and waits for every answer in flight before the
  /// app quits. Returns false when one failed and its row returned, so the
  /// app stays open with the answer recoverable.
  func sendAnswersBeforeQuit() async -> Bool {
    await pending.flushAndWait()
  }

  private func accountChanged() {
    let wasSignedIn = isSignedIn
    isSignedIn = account.state == .signedIn
    if isSignedIn, !wasSignedIn {
      startSync()
    } else if !isSignedIn {
      signIn.cancel()
      stopSync()
    }
  }

  private func signInChanged() {
    signInPhase = signIn.phase
    if signIn.phase == .complete {
      // The first sign-in turns on Open at Login (req-mac-app AC-8.2).
      loginItems.didSignIn()
      refreshLoginItem()
    }
  }

  // MARK: Sync

  private func startSync() {
    // Sync keeps the popover's open state across runs, so the first read
    // includes agents when the popover is open.
    sync.start()
    // The dot follows the clock between reads, so a deadline crossing the
    // 5-minute mark shows it without a request (req-mac-app AC-3.1).
    attentionTimer?.cancel()
    attentionTimer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: UInt64(Attention.recomputeInterval * 1_000_000_000))
        guard !Task.isCancelled, let self else { return }
        self.now = Date()
        self.updateDot()
      }
    }
  }

  private func stopSync() {
    sync.stop()
    attentionTimer?.cancel()
    attentionTimer = nil
    snapshot = .empty
    listedIDs = []
    seenIDs = seen.ids
    updateDot()
  }

  private func wokeOrReconnected() {
    guard isSignedIn else { return }
    now = Date()
    updateDot()
    let sync = self.sync
    Task { await sync.readNow() }
  }

  private func apply(_ published: Sync.Snapshot) {
    guard isSignedIn else { return }
    var ordered = published
    ordered.decisions = DecisionOrder.sorted(published.decisions)
    snapshot = ordered
    now = Date()
    let ids = ordered.decisions.map(\.id)
    if ordered.fetchedAt != nil {
      seen.prune(toPending: ids)
      seenIDs = seen.ids
      // Drafts and the answer records go with decisions no longer pending.
      let pendingIDs = Set(ids)
      drafts = drafts.filter { pendingIDs.contains($0.key) }
      pending.reconcile(pending: pendingIDs)
    }
    if isPopoverOpen {
      listedIDs.formUnion(ids)
    }
    listChanged()
    updateDot()
  }

  // MARK: Answers

  /// Expands the row, or collapses it when it is expanded; one row is
  /// expanded at a time (req-mac-app AC-4.6).
  func toggle(_ id: String) {
    selectedID = id
    if expandedID == id {
      expandedID = nil
      return
    }
    guard let decision = decision(id) else { return }
    if drafts[id] == nil { drafts[id] = AnswerDraft(decision: decision) }
    expandedID = id
  }

  func select(_ id: String) {
    selectedID = id
  }

  /// Reject or Approve on an approve-or-reject row, with the row's note.
  func answer(_ id: String, _ answer: Answer) {
    guard let decision = decision(id) else { return }
    let draft = drafts[id] ?? AnswerDraft(decision: decision)
    guard let submission = draft.submission(for: answer) else { return }
    hold(decision, submission, draft: drafts[id])
  }

  /// Send, or ⌘↩: the row's chosen answer, or its recommendation when none
  /// is chosen. Sends nothing when neither exists (req-mac-app AC-7.1).
  func send(_ id: String) {
    guard let decision = decision(id) else { return }
    let draft = drafts[id] ?? AnswerDraft(decision: decision)
    guard let submission = draft.submission else { return }
    hold(decision, submission, draft: drafts[id])
  }

  /// Undo restores the row and the draft it had, expanded again when it was
  /// expanded, and sends nothing (req-mac-app AC-4.8).
  func undo() {
    guard let attempt = pending.undo() else { return }
    let id = attempt.decision.id
    selectedID = id
    if let draft = attempt.draft {
      drafts[id] = draft
      expandedID = id
    }
  }

  /// Handles a popover key. Returns false to leave the key to the focused
  /// control or the window (req-mac-app AC-7.1).
  func handle(_ key: PopoverKey, editingText: Bool) -> Bool {
    let action = PopoverKeys.action(
      for: key, rows: decisions.map(\.id), selected: selectedID, expanded: expandedID,
      editingText: editingText)
    switch action {
    case .select(let id): selectedID = id
    case .toggle(let id): toggle(id)
    case .send(let id): send(id)
    case .collapse: expandedID = nil
    case .passThrough: return false
    }
    return true
  }

  private func decision(_ id: String) -> Decision? {
    decisions.first { $0.id == id }
  }

  private func hold(_ decision: Decision, _ submission: AnswerDraft.Submission, draft: AnswerDraft?) {
    guard pending.answer(decision, submission, draft: draft) else { return }
    drafts[decision.id] = nil
  }

  /// A failed send returns the row with its draft.
  private func restore(_ attempt: PendingAnswers.Attempt) {
    if let draft = attempt.draft { drafts[attempt.decision.id] = draft }
  }

  private func answersChanged() {
    answersRevision += 1
    listChanged()
    updateDot()
  }

  /// Keeps the selection and expansion on listed rows. A selected row that
  /// leaves passes the selection to its neighbour.
  private func listChanged() {
    let ids = decisions.map(\.id)
    selectedID = PopoverKeys.reselect(selectedID, previous: listedOrder, rows: ids)
    if let expandedID, !ids.contains(expandedID) { self.expandedID = nil }
    listedOrder = ids
  }

  private func clearAnswers() {
    pending.reset()
    drafts = [:]
    selectedID = nil
    expandedID = nil
    listedOrder = []
  }

  // MARK: Dot

  /// Fades the dot in once when it appears, over 0.35 s, or shows it at once
  /// with Reduce Motion; a refresh that keeps the dot changes nothing
  /// (req-mac-app AC-3.5).
  private func updateDot() {
    let show = isSignedIn && menuBarStyle == .dot && summary.dot
    let change = dot.update(
      show: show, reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    guard change != .none else { return }
    fade?.cancel()
    fade = nil
    switch change {
    case .none:
      break
    case .hide:
      dotOpacity = 0
    case .appear:
      dotOpacity = 1
    case .fadeIn:
      dotOpacity = 0
      fade = Task { [weak self] in
        let frames = 7
        let step = UInt64(PromptGlyph.fadeDuration / Double(frames) * 1_000_000_000)
        for frame in 1...frames {
          try? await Task.sleep(nanoseconds: step)
          guard !Task.isCancelled, let self else { return }
          self.dotOpacity = Double(frame) / Double(frames)
        }
      }
    }
  }
}
