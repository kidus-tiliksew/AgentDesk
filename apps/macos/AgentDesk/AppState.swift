import AgentDeskKit
import AppKit
import Observation
import OSLog

/// The app's observable state: the account, its sign-in, Open at Login, and
/// the synced decisions and agents with their attention state. It sends no
/// request besides sign-in, sign-out, and the sync reads (req-mac-app
/// REQ-10).
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

  var summary: MenuBarSummary {
    MenuBarSummary(decisions: snapshot.decisions, seen: seenIDs, now: now)
  }

  var rows: [DecisionRowModel] {
    snapshot.decisions.map {
      DecisionRowModel(decision: $0, agents: snapshot.agents, seen: seenIDs, now: now)
    }
  }

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

  /// The popover closed: every decision it listed stops counting as new.
  func popoverClosed() {
    guard isPopoverOpen else { return }
    isPopoverOpen = false
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
    }
    if isPopoverOpen {
      listedIDs.formUnion(ids)
    }
    updateDot()
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
