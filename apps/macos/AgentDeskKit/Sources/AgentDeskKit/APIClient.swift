import Foundation
import OSLog

/// The app's only network client: the `/v1` routes and the sign-in endpoints
/// on the configured origin (component-mac-app §API client; DEC-19(2);
/// req-mac-app REQ-10).
public final class APIClient: Sendable {
  /// The token current requests carry, or nil when signed out.
  public typealias TokenSource = @Sendable () async -> String?
  /// Runs when a `/v1` request answers 401, with the token it carried
  /// (req-mac-app AC-2.6).
  public typealias UnauthorizedHandler = @Sendable (_ rejectedToken: String) async -> Void

  public static let timeout: TimeInterval = 15
  public static let pageLimit = 100

  public let configuration: ServerConfiguration
  private let session: URLSession
  private let userAgent: String
  private let token: TokenSource
  private let onUnauthorized: UnauthorizedHandler
  private let redirects: SameOriginRedirects

  private static let log = Logger(subsystem: "sh.kidus.agentdesk.mac", category: "api")

  public init(
    configuration: ServerConfiguration,
    session: URLSession = APIClient.makeSession(),
    userAgent: String = APIClient.userAgent(bundle: .main),
    token: @escaping TokenSource,
    onUnauthorized: @escaping UnauthorizedHandler
  ) {
    self.configuration = configuration
    self.session = session
    self.userAgent = userAgent
    self.token = token
    self.onUnauthorized = onUnauthorized
    self.redirects = SameOriginRedirects(configuration: configuration)
  }

  /// A session that keeps no cookies, cache, or credentials between requests.
  public static func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.timeoutIntervalForRequest = timeout
    return URLSession(configuration: configuration)
  }

  /// `AgentDeskMac/<CFBundleShortVersionString>`.
  public static func userAgent(bundle: Bundle) -> String {
    let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return "AgentDeskMac/\(version ?? "0")"
  }

  // MARK: /v1

  /// Every pending decision, following `next_cursor` with the same filters.
  public func pendingDecisions() async throws(APIError) -> [Decision] {
    var decisions: [Decision] = []
    var cursor: String?
    repeat {
      let page: DecisionPage = try await get(
        "/v1/decisions", query: Self.pageQuery(["state": "pending"], cursor: cursor))
      decisions += page.items
      cursor = page.nextCursor
    } while cursor != nil
    return decisions
  }

  public func decision(id: String) async throws(APIError) -> Decision {
    try await get("/v1/decisions/\(Self.segment(id))")
  }

  public func answer(id: String, answer: Answer, note: String? = nil) async throws(APIError)
    -> Decision
  {
    try await decode(
      send(
        "POST", "/v1/decisions/\(Self.segment(id))/answer",
        body: AnswerSubmission(answer: answer, note: note), auth: .current))
  }

  /// The live agent sessions. `component-gateway` lists live sessions before
  /// ended ones, so the read stops at the first page holding an ended session.
  public func liveAgentSessions() async throws(APIError) -> [AgentSession] {
    var sessions: [AgentSession] = []
    var cursor: String?
    repeat {
      let page: AgentSessionPage = try await get(
        "/v1/agent-sessions", query: Self.pageQuery([:], cursor: cursor))
      sessions += page.items.filter { $0.endedAt == nil }
      if page.items.contains(where: { $0.endedAt != nil }) { break }
      cursor = page.nextCursor
    } while cursor != nil
    return sessions
  }

  // MARK: Sign-in

  /// `POST /device/start` for this Mac (req-mac-app AC-2.1).
  public func startSignIn(machineName: String) async throws(APIError) -> DeviceStart {
    try await decode(
      send("POST", "/device/start", body: DeviceStartRequest(machineName: machineName), auth: .none))
  }

  /// `POST /device/poll` (req-mac-app AC-2.3).
  public func pollSignIn(deviceSecret: String) async throws(APIError) -> DevicePoll {
    try await decode(
      send("POST", "/device/poll", body: DevicePollRequest(deviceSecret: deviceSecret), auth: .none))
  }

  /// `DELETE /device/connection` with the token being signed out
  /// (req-mac-app AC-2.7). Its 401 never runs the unauthorized handler.
  public func revokeConnection(token: String) async throws(APIError) {
    _ = try await send("DELETE", "/device/connection", body: Empty?.none, auth: .explicit(token))
  }

  // MARK: Requests

  private enum Auth {
    case none
    case current
    case explicit(String)
  }

  private struct Empty: Encodable {}

  private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws(APIError)
    -> T
  {
    try decode(await send("GET", path, query: query, body: Empty?.none, auth: .current))
  }

  private func send<Body: Encodable>(
    _ method: String, _ path: String, query: [URLQueryItem] = [], body: Body?, auth: Auth
  ) async throws(APIError) -> Data {
    var components = URLComponents()
    components.percentEncodedPath = path
    if !query.isEmpty {
      // Every reserved character is escaped, so an opaque cursor holding `+`,
      // `&`, or `=` reaches the server unchanged.
      components.percentEncodedQueryItems = query.map {
        URLQueryItem(name: Self.escape($0.name), value: $0.value.map(Self.escape))
      }
    }
    guard let url = components.url(relativeTo: configuration.origin)?.absoluteURL else {
      throw .transport("Invalid request path")
    }

    var request = URLRequest(url: url, timeoutInterval: Self.timeout)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
    if let body {
      do {
        request.httpBody = try JSONEncoder.agentDesk().encode(body)
      } catch {
        throw .transport("Couldn't encode the request")
      }
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let bearer: String?
    switch auth {
    case .none: bearer = nil
    case .explicit(let token): bearer = token
    case .current:
      guard let current = await token() else { throw .signedOut }
      bearer = current
    }
    if let bearer {
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request, delegate: redirects)
    } catch {
      Self.log.error("\(method, privacy: .public) \(path, privacy: .public) failed")
      throw .transport((error as? URLError)?.localizedDescription ?? "The request failed")
    }
    guard let http = response as? HTTPURLResponse else {
      throw .transport("The server's answer was not HTTP")
    }
    Self.log.debug(
      "\(method, privacy: .public) \(path, privacy: .public) \(http.statusCode, privacy: .public)")
    if (200..<300).contains(http.statusCode) {
      return data
    }

    let failure = Self.failure(status: http.statusCode, data: data)
    if http.statusCode == 401, case .current = auth, let bearer {
      await onUnauthorized(bearer)
    }
    throw failure
  }

  private func decode<T: Decodable>(_ data: Data) throws(APIError) -> T {
    do {
      return try JSONDecoder.agentDesk().decode(T.self, from: data)
    } catch {
      throw .transport("The server's answer could not be read")
    }
  }

  static func failure(status: Int, data: Data) -> APIError {
    guard let body = try? JSONDecoder.agentDesk().decode(ErrorBody.self, from: data) else {
      return .transport("The server answered HTTP \(status)")
    }
    return .response(
      status: status, code: body.error.code, message: body.error.message, field: body.error.field)
  }

  private static func pageQuery(_ filters: [String: String], cursor: String?) -> [URLQueryItem] {
    var items = filters.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    items.append(URLQueryItem(name: "limit", value: String(pageLimit)))
    if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
    return items
  }

  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  /// A value with every character outside RFC 3986's unreserved set escaped.
  static func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  /// One percent-encoded path segment.
  private static func segment(_ value: String) -> String { escape(value) }
}

/// Follows a redirect only within the configured origin, so the bearer token
/// never reaches another server.
private final class SameOriginRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  let configuration: ServerConfiguration

  init(configuration: ServerConfiguration) {
    self.configuration = configuration
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? {
    guard let url = request.url, configuration.contains(url) else { return nil }
    return request
  }
}
