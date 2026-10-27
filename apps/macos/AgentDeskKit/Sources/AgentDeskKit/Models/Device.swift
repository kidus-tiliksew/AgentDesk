import Foundation

/// The body of `POST /device/start` for the Mac app (component-gateway
/// §Sign-in endpoints; req-mac-app AC-2.1).
struct DeviceStartRequest: Encodable, Equatable {
  var machineName: String
  var client = "macos"

  enum CodingKeys: String, CodingKey {
    case machineName = "machine_name"
    case client
  }
}

/// The answer to `POST /device/start`.
public struct DeviceStart: Decodable, Equatable, Sendable {
  /// The eight bare code symbols; `displayCode` groups them for the user.
  public var userCode: String
  public var deviceSecret: String
  /// Seconds between polls.
  public var interval: Int
  /// Seconds from the start until the code stops working.
  public var expiresIn: Int

  enum CodingKeys: String, CodingKey {
    case userCode = "user_code"
    case deviceSecret = "device_secret"
    case interval
    case expiresIn = "expires_in"
  }

  public init(userCode: String, deviceSecret: String, interval: Int, expiresIn: Int) {
    self.userCode = userCode
    self.deviceSecret = deviceSecret
    self.interval = interval
    self.expiresIn = expiresIn
  }

  /// The code as `XXXX-XXXX` (component-mac-app §Sign-in).
  public var displayCode: String { DeviceStart.display(userCode) }

  static func display(_ code: String) -> String {
    guard code.count == 8 else { return code }
    return "\(code.prefix(4))-\(code.suffix(4))"
  }
}

/// The body of `POST /device/poll`.
struct DevicePollRequest: Encodable, Equatable {
  var deviceSecret: String

  enum CodingKeys: String, CodingKey {
    case deviceSecret = "device_secret"
  }
}

/// The answer to `POST /device/poll`. An approved Mac request carries one API
/// token, returned exactly once (req-mac-app AC-2.3).
public enum DevicePoll: Decodable, Equatable, Sendable {
  case pending
  case approved(token: String)
  case declined
  case expired
  case notFound

  private enum CodingKeys: String, CodingKey {
    case status
    case apiToken = "api_token"
  }

  private struct APIToken: Decodable {
    var token: String
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let status = try container.decode(String.self, forKey: .status)
    switch status {
    case "pending": self = .pending
    case "declined": self = .declined
    case "expired": self = .expired
    case "not_found": self = .notFound
    case "approved":
      self = .approved(token: try container.decode(APIToken.self, forKey: .apiToken).token)
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .status, in: container, debugDescription: "Unknown poll status")
    }
  }
}

// The token never reaches a log or an error description.
extension DevicePoll: CustomStringConvertible, CustomDebugStringConvertible {
  public var description: String {
    switch self {
    case .pending: "pending"
    case .approved: "approved"
    case .declined: "declined"
    case .expired: "expired"
    case .notFound: "not_found"
    }
  }

  public var debugDescription: String { description }
}
