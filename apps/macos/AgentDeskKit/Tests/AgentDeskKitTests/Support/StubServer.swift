import Foundation

@testable import AgentDeskKit

/// A request as the stub server saw it.
struct RecordedRequest: Sendable {
  var method: String
  var url: URL
  var headers: [String: String]
  var body: Data?
  var timeout: TimeInterval

  var path: String { url.path }

  var query: [String: String] {
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
  }

  var jsonBody: [String: Any]? {
    body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }
}

struct StubResponse: Sendable {
  var status: Int
  var body: Data
  var headers: [String: String] = ["Content-Type": "application/json"]

  static func json(_ status: Int, _ text: String) -> StubResponse {
    StubResponse(status: status, body: Data(text.utf8))
  }

  static func error(_ status: Int, _ code: String, _ message: String, field: String? = nil)
    -> StubResponse
  {
    let fieldPart = field.map { #", "field": "\#($0)""# } ?? ""
    return .json(status, #"{"error": {"code": "\#(code)", "message": "\#(message)"\#(fieldPart)}}"#)
  }

  static func redirect(to location: String) -> StubResponse {
    StubResponse(status: 302, body: Data(), headers: ["Location": location])
  }
}

/// A fake server on its own origin, reached through `StubProtocol`. Each
/// server registers under a unique host, so tests never share handlers.
final class StubServer: @unchecked Sendable {
  typealias Handler = @Sendable (RecordedRequest) async throws -> StubResponse

  let origin: URL
  private let lock = NSLock()
  private var recorded: [RecordedRequest] = []
  private let handler: Handler

  init(host: String = "agentdesk-\(UUID().uuidString.lowercased()).test", handler: @escaping Handler) {
    origin = URL(string: "https://\(host)")!
    self.handler = handler
    StubProtocol.register(self, host: host)
  }

  var configuration: ServerConfiguration { ServerConfiguration(origin: origin) }

  var requests: [RecordedRequest] {
    lock.withLock { recorded }
  }

  func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return URLSession(configuration: configuration)
  }

  func makeClient(
    token: String? = "adp_test",
    onUnauthorized: @escaping APIClient.UnauthorizedHandler = { _ in }
  ) -> APIClient {
    APIClient(
      configuration: configuration, session: makeSession(), userAgent: "AgentDeskMac/9.9.9",
      token: { token }, onUnauthorized: onUnauthorized)
  }

  fileprivate func respond(to request: RecordedRequest) async throws -> StubResponse {
    lock.withLock { recorded.append(request) }
    return try await handler(request)
  }
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var servers: [String: StubServer] = [:]
  private var loading: Task<Void, Never>?

  static func register(_ server: StubServer, host: String) {
    lock.withLock { servers[host] = server }
  }

  static func server(host: String?) -> StubServer? {
    lock.withLock { host.flatMap { servers[$0] } }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let request = self.request
    guard let url = request.url, let server = Self.server(host: url.host) else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
      return
    }
    let recorded = RecordedRequest(
      method: request.httpMethod ?? "GET",
      url: url,
      headers: request.allHTTPHeaderFields ?? [:],
      body: request.httpBody ?? request.httpBodyStream.map(Self.read),
      timeout: request.timeoutInterval)
    // URLProtocol predates Sendable; the box carries it into the task.
    let this = Unchecked(self)
    loading = Task { await this.value.load(recorded, from: server, request: request, url: url) }
  }

  private func load(
    _ recorded: RecordedRequest, from server: StubServer, request: URLRequest, url: URL
  ) async {
    do {
      let stub = try await server.respond(to: recorded)
      guard !Task.isCancelled else { return }
      deliver(stub, for: request, url: url)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {
    loading?.cancel()
  }

  private func deliver(_ stub: StubResponse, for request: URLRequest, url: URL) {
    let response = HTTPURLResponse(
      url: url, statusCode: stub.status, httpVersion: "HTTP/1.1", headerFields: stub.headers)!
    if (300..<400).contains(stub.status), let location = stub.headers["Location"],
      let target = URL(string: location, relativeTo: url)
    {
      var next = request
      next.url = target.absoluteURL
      client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: stub.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  private static func read(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count > 0 else { break }
      data.append(buffer, count: count)
    }
    return data
  }
}

private struct Unchecked<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}
