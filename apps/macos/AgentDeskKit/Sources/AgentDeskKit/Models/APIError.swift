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

/// A failed request. A non-2xx answer with the contract error body maps to
/// `.response`; anything else, including an answer the app cannot read, maps
/// to `.transport` (component-mac-app §API client). No case carries a
/// credential.
public enum APIError: Error, Equatable, Sendable {
  case response(status: Int, code: String, message: String, field: String?)
  case transport(String)
  /// No credential was available, so no request was sent.
  case signedOut

  public var status: Int? {
    if case .response(let status, _, _, _) = self { return status }
    return nil
  }

  public var code: String? {
    if case .response(_, let code, _, _) = self { return code }
    return nil
  }

  public var isUnauthenticated: Bool { status == 401 }
  public var isRateLimited: Bool { status == 429 }
}
