import Foundation

/// One choice of a single- or multiple-choice decision.
public struct Option: Codable, Equatable, Hashable, Sendable, Identifiable {
  public var id: String
  public var label: String

  public enum CodingKeys: String, CodingKey, CaseIterable, Sendable {
    case id
    case label
  }

  public init(id: String, label: String) {
    self.id = id
    self.label = label
  }
}
