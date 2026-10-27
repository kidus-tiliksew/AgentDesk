import Foundation
import OSLog

/// The signed-in state for the configured server: the API token held in the
/// `CredentialStore`, the `APIClient` that carries it, and the one place that
/// clears local account state (component-mac-app §Sign-in).
@MainActor
public final class Account {
  public enum State: Equatable, Sendable {
    case signedOut
    case signedIn
  }

  public let configuration: ServerConfiguration
  public private(set) var state: State
  /// Runs on the main actor after every change of `state`.
  public var onChange: (@MainActor () -> Void)?

  private let credentials: CredentialStore
  private let session: URLSession
  private let userAgent: String
  private var token: String?
  private var cleanupSteps: [@MainActor () -> Void] = []

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "account")

  /// Reads any stored token for the configured origin. A Keychain failure
  /// starts signed out.
  public init(
    configuration: ServerConfiguration,
    credentials: CredentialStore,
    session: URLSession = APIClient.makeSession(),
    userAgent: String = APIClient.userAgent(bundle: .main)
  ) {
    self.configuration = configuration
    self.credentials = credentials
    self.session = session
    self.userAgent = userAgent
    do {
      token = try credentials.token(account: configuration.account)
    } catch {
      Self.log.error("Couldn't read the stored credential: \(error.status, privacy: .public)")
      token = nil
    }
    state = token == nil ? .signedOut : .signedIn
  }

  public lazy var api = APIClient(
    configuration: configuration,
    session: session,
    userAgent: userAgent,
    token: { [weak self] in await self?.token },
    onUnauthorized: { [weak self] rejected in await self?.unauthorized(rejected) }
  )

  /// Adds a step that clears per-account local state on every sign-out. Later
  /// stores, such as seen and notified decisions, register here.
  public func addCleanup(_ step: @escaping @MainActor () -> Void) {
    cleanupSteps.append(step)
  }

  /// Stores an approved token before entering the signed-in state, so the app
  /// is never signed in without its credential persisted.
  public func signIn(token: String) throws(CredentialStoreError) {
    try credentials.save(token, account: configuration.account)
    self.token = token
    setState(.signedIn)
  }

  /// Signs out on the user's request (req-mac-app AC-2.7). Local state clears
  /// first, whatever the server answers; then `DELETE /device/connection`
  /// revokes the captured token.
  public func signOut() async -> SignOutOutcome {
    guard let captured = token else {
      return SignOutOutcome(revocationError: nil, keychainError: clearLocal())
    }
    let keychainError = clearLocal()
    do {
      try await api.revokeConnection(token: captured)
      return SignOutOutcome(revocationError: nil, keychainError: keychainError)
    } catch where error.isUnauthenticated {
      // The server no longer accepts the token, so it is already revoked.
      return SignOutOutcome(revocationError: nil, keychainError: keychainError)
    } catch {
      return SignOutOutcome(revocationError: error, keychainError: keychainError)
    }
  }

  /// A `/v1` request answered 401: the connection was revoked elsewhere, so
  /// sign out locally without `DELETE` (req-mac-app AC-2.6). A 401 for a
  /// token that is no longer current changes nothing.
  func unauthorized(_ rejected: String) {
    guard token == rejected else { return }
    _ = clearLocal()
  }

  @discardableResult
  private func clearLocal() -> CredentialStoreError? {
    var failure: CredentialStoreError?
    do {
      try credentials.delete(account: configuration.account)
    } catch {
      Self.log.error("Couldn't delete the stored credential: \(error.status, privacy: .public)")
      failure = error
    }
    token = nil
    for step in cleanupSteps { step() }
    setState(.signedOut)
    return failure
  }

  private func setState(_ new: State) {
    state = new
    onChange?()
  }
}

/// What a sign-out achieved. Local state is always cleared; the server's
/// revocation is confirmed only when `revocationError` is nil.
public struct SignOutOutcome: Equatable, Sendable {
  public var revocationError: APIError?
  public var keychainError: CredentialStoreError?

  /// A notice for the signed-out view, or nil when everything succeeded.
  public var message: String? {
    if keychainError != nil {
      return "Signed out, but the sign-in couldn't be removed from the Keychain."
    }
    if revocationError != nil {
      return "Signed out on this Mac. AgentDesk couldn't confirm the server revoked it; "
        + "revoke AgentDesk for Mac in the mobile app's connections."
    }
    return nil
  }
}
