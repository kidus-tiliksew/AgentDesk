import AgentDeskKit
import AppKit
import Observation

/// The app's observable state: the account, its sign-in, and Open at Login.
/// This slice starts no sync timer and sends no request besides sign-in and
/// sign-out (req-mac-app REQ-10).
@MainActor
@Observable
final class AppState {
  private(set) var isSignedIn: Bool
  private(set) var signInPhase: SignInPhase = .idle
  /// A sign-out result the signed-out view reports.
  private(set) var notice: String?
  private(set) var openAtLogin: Bool
  private(set) var loginItemError: String?

  @ObservationIgnored private let account: Account
  @ObservationIgnored private let signIn: SignInController
  @ObservationIgnored private let loginItems: LoginItems
  @ObservationIgnored private var terminationObserver: NSObjectProtocol?

  init(defaults: UserDefaults = .standard) {
    let account = Account(
      configuration: ServerConfiguration(defaults: defaults), credentials: KeychainCredentialStore())
    self.account = account
    signIn = SignInController(
      api: account.api, machineName: Host.current().localizedName ?? "Mac"
    ) { token in try account.signIn(token: token) }
    loginItems = LoginItems(service: MainAppLoginItem(), defaults: defaults)
    isSignedIn = account.state == .signedIn
    openAtLogin = loginItems.isOn

    account.onChange = { [weak self] in self?.accountChanged() }
    signIn.onChange = { [weak self] in self?.signInChanged() }
    // Polling stops when the app quits.
    terminationObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.signIn.cancel() }
    }
  }

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
    isSignedIn = account.state == .signedIn
    if !isSignedIn {
      signIn.cancel()
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
}
