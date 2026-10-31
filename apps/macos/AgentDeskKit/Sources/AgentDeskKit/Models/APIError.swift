import Foundation

/// The contract error body, `{"error": {code, message, field?}}`.
public struct ErrorBody: Codable, Equatable, Sendable {
  public struct Detail: Codable, Equatable, Sendable {
    public var code: String
    public var message: String
    public var field: String?

    public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
      case code
      case message
      case field
    }
  }

  public var error: Detail

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case error
  }
}

/// A failed request (component-mac-app §API client). No case carries a
/// credential, a response body, or a URL.
///
/// - `.response`: a non-2xx answer with the contract error body.
/// - `.http`: a non-2xx answer without the contract error body, such as an
///   HTML 404 from a host that is not an AgentDesk gateway, or a redirect the
///   client refused to follow.
/// - `.unreadable`: a 2xx answer whose body the app could not decode.
/// - `.transport`: no HTTP answer arrived: a `URLSession` failure or a
///   response that is not HTTP.
/// - `.request`: the app could not build the request, so nothing was sent.
/// - `.signedOut`: no credential was available, so nothing was sent.
public enum APIError: Error, Equatable, Sendable {
  case response(status: Int, code: String, message: String, field: String?)
  case http(status: Int)
  case unreadable(status: Int)
  case transport(String)
  case request(String)
  case signedOut

  /// The status of a contract error answer, and nil for every other case.
  /// `PendingAnswers`, `Sync`, sign-in polling, and sign-out read this, so a
  /// non-contract answer keeps the behavior it had when it was a transport
  /// failure.
  public var status: Int? {
    if case .response(let status, _, _, _) = self { return status }
    return nil
  }

  /// The HTTP status of any answer that arrived, contract or not, and nil
  /// when no answer arrived. Only sign-in start reads it.
  public var httpStatus: Int? {
    switch self {
    case .response(let status, _, _, _), .http(let status), .unreadable(let status): status
    case .transport, .request, .signedOut: nil
    }
  }

  public var code: String? {
    if case .response(_, let code, _, _) = self { return code }
    return nil
  }

  public var isUnauthenticated: Bool { status == 401 }
  public var isRateLimited: Bool { status == 429 }
}
