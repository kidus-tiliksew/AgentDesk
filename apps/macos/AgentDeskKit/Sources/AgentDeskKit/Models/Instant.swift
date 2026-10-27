import Foundation

/// ISO 8601 instants as `spec/schemas` writes them: seconds precision with an
/// optional fraction of any length, and `Z` or a `±hh:mm` offset
/// (component-mac-app §Models).
enum Instant {
  // ISO8601DateFormatter is thread-safe once configured.
  nonisolated(unsafe) private static let whole: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  /// The fraction is parsed apart from `yyyy-MM-ddTHH:mm:ss` and the zone,
  /// so that more than three digits keep their value instead of failing the
  /// formatter.
  static func parse(_ text: String) -> Date? {
    let seconds = text.prefix(19)
    var rest = text.dropFirst(19)
    var fraction: Double = 0
    if rest.first == "." {
      let digits = rest.dropFirst().prefix(while: { $0.isASCII && $0.isNumber })
      guard !digits.isEmpty, let value = Double("0." + digits) else { return nil }
      fraction = value
      rest = rest.dropFirst(1 + digits.count)
    }
    guard rest == "Z" || (rest.count == 6 && (rest.first == "+" || rest.first == "-")),
      let base = whole.date(from: String(seconds) + rest)
    else { return nil }
    return base.addingTimeInterval(fraction)
  }

  static func format(_ date: Date) -> String {
    fractional.string(from: date)
  }

  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let text = try container.decode(String.self)
      guard let date = parse(text) else {
        throw DecodingError.dataCorruptedError(
          in: container, debugDescription: "Expected an ISO 8601 instant")
      }
      return date
    }
    return decoder
  }

  static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(format(date))
    }
    return encoder
  }
}

extension JSONDecoder {
  /// The decoder for every API answer.
  public static func agentDesk() -> JSONDecoder { Instant.decoder() }
}

extension JSONEncoder {
  /// The encoder for every API request body.
  public static func agentDesk() -> JSONEncoder { Instant.encoder() }
}
