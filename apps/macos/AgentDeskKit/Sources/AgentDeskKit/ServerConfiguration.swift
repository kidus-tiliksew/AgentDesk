import Foundation

/// The server origin every request goes to (req-mac-app AC-1.3).
///
/// The user default `ServerURL` in the app's domain overrides the public
/// origin. Only an absolute https URL is honoured, and only its origin is
/// kept, so requests and the Keychain account always name the same server
/// (component-mac-app §Server and credential). A user sets it with
/// `defaults write sh.kidus.agentdesk.mac ServerURL <origin>` and restarts the
/// app.
public struct ServerConfiguration: Equatable, Sendable {
  public static let defaultsKey = "ServerURL"
  public static let publicOrigin = URL(string: "https://agentdesk-gateway.kidus-tiliksew.workers.dev")!

  /// Scheme, host, and any explicit port, with no path.
  public let origin: URL

  public init(origin: URL) {
    self.origin = origin
  }

  public init(defaults: UserDefaults) {
    let override = defaults.string(forKey: Self.defaultsKey).flatMap(Self.origin(of:))
    self.init(origin: override ?? Self.publicOrigin)
  }

  /// The origin of an absolute https URL, or nil for anything else.
  public static func origin(of text: String) -> URL? {
    guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespaces)),
      components.scheme?.lowercased() == "https",
      let host = components.host, !host.isEmpty,
      components.user == nil, components.password == nil
    else { return nil }
    var origin = URLComponents()
    origin.scheme = "https"
    origin.host = host.lowercased()
    if let port = components.port, port != 443 {
      origin.port = port
    }
    return origin.url
  }

  /// The Keychain account for this server: its origin as text.
  public var account: String { origin.absoluteString }

  /// True when `url` points at this server's origin.
  public func contains(_ url: URL) -> Bool {
    Self.origin(of: url.absoluteString) == origin
  }
}
