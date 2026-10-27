import Foundation
import XCTest

@testable import AgentDeskKit

/// Holds the models' coding keys equal to the repository's published schemas,
/// read at test time (component-mac-app §Models, §Verification; DEC-19(2)).
final class SchemaConformanceTests: XCTestCase {
  /// The repository root, four levels above this file:
  /// apps/macos/AgentDeskKit/Tests/AgentDeskKitTests/.
  private static let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

  private static func load(_ path: String) throws -> [String: Any] {
    let url = repositoryRoot.appendingPathComponent(path)
    let data = try Data(contentsOf: url)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], path)
  }

  private func decisionSchema() throws -> [String: Any] {
    try Self.load("spec/schemas/decision.schema.json")
  }

  private func agentSessionSchema() throws -> [String: Any] {
    try Self.load("spec/schemas/agent-session.schema.json")
  }

  private func openAPISchema(_ name: String) throws -> [String: Any] {
    let spec = try Self.load("spec/openapi.json")
    let components = try XCTUnwrap(spec["components"] as? [String: Any])
    let schemas = try XCTUnwrap(components["schemas"] as? [String: Any])
    return try XCTUnwrap(schemas[name] as? [String: Any], name)
  }

  private func properties(_ schema: [String: Any]) throws -> [String: [String: Any]] {
    try XCTUnwrap(schema["properties"] as? [String: [String: Any]])
  }

  private func keys<K: CodingKey & CaseIterable>(_: K.Type) -> Set<String> {
    Set(K.allCases.map(\.stringValue))
  }

  /// The string values a property allows, from `enum` or `anyOf` branches.
  private func enumValues(_ property: [String: Any]) -> Set<String> {
    if let values = property["enum"] as? [String] { return Set(values) }
    let branches = property["anyOf"] as? [[String: Any]] ?? []
    return branches.reduce(into: Set<String>()) { $0.formUnion(enumValues($1)) }
  }

  /// The `oneOf` variants of an answer-shaped property.
  private func answerVariants(_ property: [String: Any]) throws -> [[String: Any]] {
    if let variants = property["oneOf"] as? [[String: Any]] { return variants }
    let branches = try XCTUnwrap(property["anyOf"] as? [[String: Any]])
    return try XCTUnwrap(branches.compactMap { $0["oneOf"] as? [[String: Any]] }.first)
  }

  // MARK: Coding keys

  func testDecisionCodingKeysMatchSchema() throws {
    let schema = try properties(decisionSchema())
    XCTAssertEqual(keys(Decision.CodingKeys.self), Set(schema.keys))
  }

  func testAgentSessionCodingKeysMatchSchema() throws {
    let schema = try properties(agentSessionSchema())
    XCTAssertEqual(keys(AgentSession.CodingKeys.self), Set(schema.keys))
  }

  func testAnswerCodingKeysMatchEveryAnswerShapedProperty() throws {
    let schema = try properties(decisionSchema())
    for name in ["answer", "recommendation", "default"] {
      let variants = try answerVariants(try XCTUnwrap(schema[name]))
      let union = try variants.reduce(into: Set<String>()) {
        $0.formUnion(try properties($1).keys)
      }
      XCTAssertEqual(keys(Answer.CodingKeys.self), union, name)
      let kinds = try variants.map { try XCTUnwrap(properties($0)["kind"]?["const"] as? String) }
      XCTAssertEqual(Set(Answer.Kind.allCases.map(\.rawValue)), Set(kinds), name)
    }
    let submission = try properties(openAPISchema("AnswerSubmission"))
    let variants = try answerVariants(try XCTUnwrap(submission["answer"]))
    let union = try variants.reduce(into: Set<String>()) { $0.formUnion(try properties($1).keys) }
    XCTAssertEqual(keys(Answer.CodingKeys.self), union)
  }

  func testOptionCodingKeysMatchSchema() throws {
    let options = try XCTUnwrap(properties(decisionSchema())["options"])
    let branches = try XCTUnwrap(options["anyOf"] as? [[String: Any]])
    let item = try XCTUnwrap(branches.compactMap { $0["items"] as? [String: Any] }.first)
    XCTAssertEqual(keys(Option.CodingKeys.self), Set(try properties(item).keys))
  }

  func testEnumerationsMatchSchema() throws {
    let decision = try properties(decisionSchema())
    XCTAssertEqual(
      Set(Decision.InputType.allCases.map(\.rawValue)), enumValues(try XCTUnwrap(decision["input_type"])))
    XCTAssertEqual(
      Set(Decision.Priority.allCases.map(\.rawValue)), enumValues(try XCTUnwrap(decision["priority"])))
    XCTAssertEqual(
      Set(Decision.State.allCases.map(\.rawValue)), enumValues(try XCTUnwrap(decision["state"])))
    XCTAssertEqual(
      Set(Decision.AnsweredVia.allCases.map(\.rawValue)),
      enumValues(try XCTUnwrap(decision["answered_via"])))
    XCTAssertEqual(
      Set(Decision.NotificationAction.allCases.map(\.rawValue)),
      enumValues(try XCTUnwrap(decision["notification_action"])))
    let session = try properties(agentSessionSchema())
    XCTAssertEqual(
      Set(AgentSession.State.allCases.map(\.rawValue)), enumValues(try XCTUnwrap(session["state"])))
  }

  func testPageSubmissionAndErrorKeysMatchOpenAPI() throws {
    XCTAssertEqual(
      keys(DecisionPage.CodingKeys.self), Set(try properties(openAPISchema("DecisionPage")).keys))
    XCTAssertEqual(
      keys(AgentSessionPage.CodingKeys.self),
      Set(try properties(openAPISchema("AgentSessionPage")).keys))
    XCTAssertEqual(
      keys(AnswerSubmission.CodingKeys.self),
      Set(try properties(openAPISchema("AnswerSubmission")).keys))
    let errorBody = try properties(openAPISchema("ErrorBody"))
    XCTAssertEqual(keys(ErrorBody.CodingKeys.self), Set(errorBody.keys))
    let detail = try properties(try XCTUnwrap(errorBody["error"]))
    XCTAssertEqual(keys(ErrorBody.Detail.CodingKeys.self), Set(detail.keys))
  }

  // MARK: Decoding through the declared keys

  /// A fully populated fixture decodes and re-encodes to exactly the schema's
  /// properties, so every declared key is the one decoding reads.
  func testFullDecisionRoundTripsEverySchemaProperty() throws {
    let decision = try JSONDecoder.agentDesk().decode(
      Decision.self, from: Fixtures.data(Fixtures.decision()))
    let encoded = try JSONEncoder.agentDesk().encode(decision)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(Set(object.keys), Set(try properties(decisionSchema()).keys))

    XCTAssertEqual(decision.id, "dec_1")
    XCTAssertEqual(decision.inputType, .singleChoice)
    XCTAssertEqual(decision.options, [Option(id: "a", label: "Ship"), Option(id: "b", label: "Wait")])
    XCTAssertEqual(decision.recommendation, .option(id: "a"))
    XCTAssertEqual(decision.defaultAnswer, .option(id: "b"))
    XCTAssertEqual(decision.answer, .option(id: "a"))
    XCTAssertEqual(decision.priority, .urgent)
    XCTAssertEqual(decision.notificationAction, .push)
    XCTAssertEqual(decision.answeredVia, .chat)
    XCTAssertEqual(decision.chatMessage, "ship it")
    XCTAssertEqual(decision.relayedByAgentSessionID, "ags_2")
    XCTAssertEqual(decision.parentID, "dec_0")
    XCTAssertEqual(decision.followUpIDs, ["dec_2"])
    XCTAssertEqual(decision.agentSessionID, "ags_1")
    XCTAssertTrue(decision.interactive)
  }

  func testFullAgentSessionRoundTripsEverySchemaProperty() throws {
    let session = try JSONDecoder.agentDesk().decode(
      AgentSession.self, from: Fixtures.data(Fixtures.agentSession(ended: true)))
    let encoded = try JSONEncoder.agentDesk().encode(session)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(Set(object.keys), Set(try properties(agentSessionSchema()).keys))
    XCTAssertEqual(session.displayName, "Claude Code · web")
    XCTAssertEqual(session.state, .working)
    XCTAssertEqual(session.pendingDecisionCount, 1)
    XCTAssertNotNil(session.endedAt)
  }

  func testNullableFieldsDecodeAsNil() throws {
    let decision = try JSONDecoder.agentDesk().decode(
      Decision.self, from: Fixtures.data(Fixtures.pendingDecision()))
    XCTAssertNil(decision.body)
    XCTAssertNil(decision.options)
    XCTAssertNil(decision.recommendation)
    XCTAssertNil(decision.notificationAction)
    XCTAssertNil(decision.deadline)
    XCTAssertNil(decision.defaultAnswer)
    XCTAssertNil(decision.answer)
    XCTAssertNil(decision.note)
    XCTAssertNil(decision.answeredAt)
    XCTAssertNil(decision.answeredVia)
    XCTAssertNil(decision.chatMessage)
    XCTAssertNil(decision.relayedByAgentSessionID)
    XCTAssertNil(decision.parentID)
    XCTAssertNil(decision.agentSessionID)

    let session = try JSONDecoder.agentDesk().decode(
      AgentSession.self,
      from: Fixtures.data(
        Fixtures.agentSession([
          "state": NSNull(), "line": NSNull(), "link": NSNull(), "status_at": NSNull(),
        ])))
    XCTAssertNil(session.state)
    XCTAssertNil(session.line)
    XCTAssertNil(session.link)
    XCTAssertNil(session.statusAt)
    XCTAssertNil(session.endedAt)
  }

  func testEveryAnswerKindDecodes() throws {
    let cases: [([String: Any], Answer)] = [
      (["kind": "approve"], .approve),
      (["kind": "reject"], .reject),
      (["kind": "option", "option_id": "a"], .option(id: "a")),
      (["kind": "options", "option_ids": ["a", "b"]], .options(ids: ["a", "b"])),
      (["kind": "text", "text": "Use staging"], .text("Use staging")),
    ]
    for (json, expected) in cases {
      let decision = try JSONDecoder.agentDesk().decode(
        Decision.self,
        from: Fixtures.data(
          Fixtures.pendingDecision(["answer": json, "recommendation": json, "default": json])))
      XCTAssertEqual(decision.answer, expected)
      XCTAssertEqual(decision.recommendation, expected)
      XCTAssertEqual(decision.defaultAnswer, expected)
      // Encoding gives back the schema's shape.
      let encoded = try JSONEncoder.agentDesk().encode(expected)
      let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
      XCTAssertEqual(object, json as NSDictionary)
    }
  }

  func testEveryInputTypeDecodes() throws {
    for inputType in Decision.InputType.allCases {
      let decision = try JSONDecoder.agentDesk().decode(
        Decision.self, from: Fixtures.data(Fixtures.pendingDecision(["input_type": inputType.rawValue])))
      XCTAssertEqual(decision.inputType, inputType)
    }
    XCTAssertEqual(
      Set(Decision.InputType.allCases.map(\.rawValue)),
      ["approve_reject", "single_choice", "multiple_choice", "free_text", "single_choice_or_text"])
  }

  func testEveryNotificationActionDecodes() throws {
    let cases: [(Any, Decision.NotificationAction?)] = [
      ("push", .push), ("digest", .digest), ("mute", .mute), (NSNull(), nil),
    ]
    for (json, expected) in cases {
      let decision = try JSONDecoder.agentDesk().decode(
        Decision.self, from: Fixtures.data(Fixtures.pendingDecision(["notification_action": json])))
      XCTAssertEqual(decision.notificationAction, expected)
    }
  }

  func testUnknownKeysAreIgnored() throws {
    let decision = try JSONDecoder.agentDesk().decode(
      Decision.self,
      from: Fixtures.data(Fixtures.pendingDecision(["added_later": ["x": 1], "another": "y"])))
    XCTAssertEqual(decision.id, "dec_1")
    let page = try JSONDecoder.agentDesk().decode(
      AgentSessionPage.self,
      from: Data(
        Fixtures.json([
          "items": [Fixtures.agentSession(["extra": true])], "next_cursor": NSNull(), "total": 1,
        ]).utf8))
    XCTAssertEqual(page.items.count, 1)
  }

  func testInstantsDecodeFractionsAndOffsets() throws {
    let decision = try JSONDecoder.agentDesk().decode(
      Decision.self, from: Fixtures.data(Fixtures.decision()))
    let base = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-27T12:00:00Z"))
    XCTAssertEqual(decision.createdAt.timeIntervalSince(base), 0.123456, accuracy: 0.000_001)
    XCTAssertEqual(
      try XCTUnwrap(decision.deadline).timeIntervalSince(base), 30 * 60 + 0.25, accuracy: 0.000_001)
    // 12:10 at +02:00 is 10:10 UTC.
    XCTAssertEqual(
      try XCTUnwrap(decision.answeredAt).timeIntervalSince(base), -110 * 60, accuracy: 0.000_001)

    XCTAssertNotNil(Instant.parse("2026-10-27T12:00:00-05:30"))
    XCTAssertNotNil(Instant.parse("2026-10-27T12:00:00.1+00:00"))
    XCTAssertNil(Instant.parse("2026-10-27T12:00:00"))
    XCTAssertNil(Instant.parse("2026-10-27T12:00:00.Z"))
    XCTAssertNil(Instant.parse("2026-10-27 12:00:00Z"))
    XCTAssertThrowsError(
      try JSONDecoder.agentDesk().decode(
        Decision.self, from: Fixtures.data(Fixtures.pendingDecision(["created_at": "yesterday"]))))
  }
}
