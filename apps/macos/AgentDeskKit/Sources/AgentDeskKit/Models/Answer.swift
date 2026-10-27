import Foundation

/// One of the five answer kinds, discriminated by `kind`. The same shape
/// carries a decision's recommendation, default, and recorded answer, and the
/// answer the app submits (component-contract §Decision input and answers).
public enum Answer: Codable, Equatable, Hashable, Sendable {
  case approve
  case reject
  case option(id: String)
  case options(ids: [String])
  case text(String)

  /// The union of every variant's properties in `spec/schemas`.
  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case kind
    case optionID = "option_id"
    case optionIDs = "option_ids"
    case text
  }

  public enum Kind: String, Codable, CaseIterable, Sendable {
    case approve, reject, option, options, text
  }

  public var kind: Kind {
    switch self {
    case .approve: .approve
    case .reject: .reject
    case .option: .option
    case .options: .options
    case .text: .text
    }
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .kind) {
    case .approve: self = .approve
    case .reject: self = .reject
    case .option: self = .option(id: try container.decode(String.self, forKey: .optionID))
    case .options: self = .options(ids: try container.decode([String].self, forKey: .optionIDs))
    case .text: self = .text(try container.decode(String.self, forKey: .text))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(kind, forKey: .kind)
    switch self {
    case .approve, .reject: break
    case .option(let id): try container.encode(id, forKey: .optionID)
    case .options(let ids): try container.encode(ids, forKey: .optionIDs)
    case .text(let text): try container.encode(text, forKey: .text)
    }
  }
}
