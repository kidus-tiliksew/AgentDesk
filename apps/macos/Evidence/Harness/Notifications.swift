import AppKit
import SwiftUI
import UserNotifications

// Notification evidence: the shipped `NotificationController` content and
// category, `Notifier` driven through a fixture center on a fixture clock,
// notification answers through `PendingAnswers`, click focus, and the pause
// line under the header. Nothing here touches `UNUserNotificationCenter`,
// which needs an app bundle and the user's permission.

/// A notification center in memory: it records posts and removals and can
/// hold or fail a post.
@MainActor
final class FixtureCenter: NotificationCenterAdapter {
  var status: NotificationAuthorization = .notDetermined
  var delivered: [String] = []
  var log: [String] = []
  var failNext = false
  var hold: CheckedContinuation<Void, Never>?
  var holdNext = false

  struct Refused: Error {}

  func authorization() async -> NotificationAuthorization { status }

  func requestAuthorization() async -> Bool {
    log.append("requestAuthorization (asked once; user grants)")
    if status == .notDetermined { status = .authorized }
    return status == .authorized
  }

  func add(_ request: NotificationRequest) async throws {
    if holdNext {
      holdNext = false
      log.append("add \(request.identifier) in flight")
      await withCheckedContinuation { hold = $0 }
    }
    if failNext {
      failNext = false
      log.append("add \(request.identifier) refused by the center")
      throw Refused()
    }
    delivered.append(request.identifier)
    log.append("add \(request.identifier): \"\(request.title)\" / \"\(request.body)\"")
  }

  func deliveredIdentifiers() async -> [String] { delivered }

  func removeDelivered(_ identifiers: [String]) {
    delivered.removeAll { identifiers.contains($0) }
    log.append("remove delivered \(identifiers)")
  }

  func removeAllDelivered() {
    delivered = []
    log.append("remove all delivered")
  }
}

/// An answer sender that records posts and answers from a script.
final class FixtureSender: AnswerSender, @unchecked Sendable {
  private let lock = NSLock()
  private var script: [Result<Decision, APIError>] = []
  private var reads: [Result<Decision, APIError>] = []
  private var recorded: [String] = []

  var posts: [String] { lock.withLock { recorded } }

  func answerPosts(_ results: Result<Decision, APIError>...) { lock.withLock { script += results } }
  func answerReads(_ results: Result<Decision, APIError>...) { lock.withLock { reads += results } }

  func answer(id: String, answer: Answer, note: String?) async throws(APIError) -> Decision {
    let result: Result<Decision, APIError>? = lock.withLock {
      recorded.append("\(id) \(answer)")
      return script.isEmpty ? nil : script.removeFirst()
    }
    guard let result else { return pendingFixture(id) }
    return try result.get()
  }

  func decision(id: String) async throws(APIError) -> Decision {
    let result: Result<Decision, APIError> = lock.withLock {
      reads.isEmpty ? .failure(.transport("unscripted")) : reads.removeFirst()
    }
    return try result.get()
  }
}

/// The pending fixture decision a successful post returns.
func pendingFixture(_ id: String) -> Decision {
  decision(["id": id])
}

/// A sync clock that never fires, so the outcome timer stays observable.
struct StillClock: SyncClock {
  func sleep(seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64.max / 2)
  }
}

/// Runs `body` on the main actor and spins the run loop until it ends.
@MainActor
func runAsync(_ body: @escaping @MainActor () async -> Void) {
  var done = false
  Task { @MainActor in
    await body()
    done = true
  }
  while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.005)) }
}

/// Spins the run loop briefly so queued main-actor work runs.
@MainActor
func spin(_ seconds: TimeInterval = 0.05) {
  RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

@MainActor
func notificationEvidence(_ failures: inout [String]) {
  line("## Notifications")
  let created = Instant.parse("2026-10-27T12:00:00Z")!
  func pushed(_ id: String, _ fields: [String: Any] = [:]) -> Decision {
    var base: [String: Any] = [
      "id": id, "notification_action": "push", "agent_session_id": "ags_1", "created_at": "2026-10-27T12:00:00Z",
    ]
    base.merge(fields) { $1 }
    return decision(base)
  }
  let live = [session(["id": "ags_1", "display_name": "Claude Code · api"])]

  // Content and category, from the shipped adapter.
  line("### Content (NotificationController.content(for:))")
  let approveReject = pushed(
    "dec_ship", ["title": "Ship the release?", "deadline": "2026-10-27T12:30:00Z"])
  let choice = pushed(
    "dec_pick",
    [
      "title": "Which region first?", "input_type": "single_choice",
      "options": [["id": "eu", "label": "EU"], ["id": "us", "label": "US"]],
    ])
  for item in [approveReject, choice] {
    let request = NotificationRequest(decision: item, agentName: "Claude Code · api", now: created.addingTimeInterval(30))
    let content = NotificationController.content(for: request)
    line(
      "- identifier \(request.identifier): title \"\(content.title)\", body \"\(content.body)\", sound \(content.sound == .default ? "default" : "none"), category \"\(content.categoryIdentifier)\", userInfo keys \(content.userInfo.count)")
    if content.sound != .default { failures.append("\(request.identifier) has no default sound") }
    if !content.userInfo.isEmpty { failures.append("\(request.identifier) carries user info") }
  }
  for category in NotificationController.categories {
    let actions = category.actions.map {
      "\($0.identifier) \"\($0.title)\"\($0.options.contains(.foreground) ? " (opens the app)" : "")"
    }
    line("category \(category.identifier): actions \(actions.joined(separator: ", "))")
    if category.actions.contains(where: { $0.options.contains(.foreground) }) {
      failures.append("a notification action opens the app")
    }
  }
  line("")

  // Notifier on a fixture clock: authorization, the five conditions, a post
  // in flight, a refused post, removal, and sign-out.
  line("### Notifier timeline (fixture center and clock)")
  let center = FixtureCenter()
  let defaults = UserDefaults(suiteName: "agentdesk-evidence-\(UUID().uuidString)")!
  var clock = created
  let notifier = Notifier(
    center: center, settings: NotificationSettings(defaults: defaults),
    store: NotifiedStore(defaults: defaults), readAgents: { live }, now: { clock })
  func step(_ label: String, _ pending: [Decision], open: Bool = false, at seconds: TimeInterval) {
    clock = created.addingTimeInterval(seconds)
    notifier.isPopoverOpen = open
    center.log = []
    runAsync {
      notifier.didRead(pending: pending, agents: [])
      await notifier.settle()
    }
    line("- t+\(Int(seconds))s \(label): \(center.log.isEmpty ? "nothing" : center.log.joined(separator: "; "))")
  }
  center.log = []
  notifier.requestAuthorization()
  spin()
  line("- sign-in: \(center.log.joined(separator: "; "))")
  let interactive = pushed("dec_chat", ["title": "Use the staging database?", "interactive": true])
  step("a pushed approve-or-reject decision arrives", [approveReject], at: 30)
  step("the next read lists it again", [approveReject], at: 45)
  step("a digest and a muted decision arrive", [
    approveReject, pushed("dec_digest", ["notification_action": "digest"]),
    pushed("dec_mute", ["notification_action": "mute"]),
  ], at: 60)
  step("an interactive decision at 1m 59s", [approveReject, interactive], at: 119)
  step("the interactive decision at 2m", [approveReject, interactive], at: 120)
  step("a decision created 11 minutes ago, read at start", [pushed("dec_old", ["created_at": "2026-10-27T11:50:00Z"])] + [approveReject, interactive], at: 150)
  step("the popover is open when dec_open arrives", [approveReject, interactive, pushed("dec_open")], open: true, at: 165)
  step("the popover closed again", [approveReject, interactive, pushed("dec_open")], at: 180)
  notifier.settings.pause(now: created.addingTimeInterval(180))
  step("paused when dec_paused arrives", [approveReject, interactive, pushed("dec_paused")], at: 195)
  notifier.settings.resume()
  notifier.settings.setOn(false)
  step("off", [approveReject, interactive, pushed("dec_paused")], at: 210)
  notifier.settings.setOn(true)
  step("on again", [approveReject, interactive, pushed("dec_paused")], at: 225)

  // A post in flight while two more reads land: posted once.
  center.holdNext = true
  clock = created.addingTimeInterval(240)
  center.log = []
  notifier.didRead(pending: [approveReject, interactive, pushed("dec_slow")], agents: [])
  spin()
  notifier.didRead(pending: [approveReject, interactive, pushed("dec_slow")], agents: [])
  notifier.didRead(pending: [approveReject, interactive, pushed("dec_slow")], agents: [])
  center.hold?.resume()
  runAsync { await notifier.settle() }
  line("- t+240s dec_slow's post is in flight while two more reads land: \(center.log.joined(separator: "; "))")
  if center.log.filter({ $0.hasPrefix("add dec_slow:") }).count != 1 {
    failures.append("a post in flight was repeated")
  }
  center.failNext = true
  step("dec_retry's post is refused", [approveReject, interactive, pushed("dec_retry")], at: 255)
  step("the next read retries it", [approveReject, interactive, pushed("dec_retry")], at: 270)
  step("dec_ship answered, dec_chat cancelled, the rest expired", [], at: 285)
  if !center.delivered.isEmpty { failures.append("delivered notifications remain: \(center.delivered)") }
  center.holdNext = true
  clock = created.addingTimeInterval(300)
  center.log = []
  notifier.didRead(pending: [pushed("dec_late", ["created_at": "2026-10-27T12:04:30Z"])], agents: [])
  spin()
  notifier.reset()
  center.hold?.resume()
  runAsync { await notifier.settle() }
  line("- t+300s sign-out while dec_late's post is in flight: \(center.log.joined(separator: "; ")); delivered now \(center.delivered)")
  if !center.delivered.isEmpty { failures.append("a post outlived sign-out") }
  line("")

  // Reject and Approve answer at once.
  line("### Notification answers (PendingAnswers.sendNow)")
  let sender = FixtureSender()
  let answers = PendingAnswers(sender: sender, clock: StillClock())
  answers.isPresented = false
  answers.answer(choice, AnswerDraft.Submission(answer: .option(id: "eu")))
  let first = answers.sendNow(approveReject, AnswerDraft.Submission(answer: .approve))
  let repeated = answers.sendNow(approveReject, AnswerDraft.Submission(answer: .approve))
  runAsync { _ = await answers.flushAndWait() }
  line("- Approve on dec_ship: accepted \(first); a repeated action accepted \(repeated); posts \(sender.posts)")
  line("  the popover's held answer for dec_pick was sent only by the quit flush that ends this step, never by the notification action")
  let conflicted = pushed("dec_taken")
  sender.answerPosts(.failure(.response(status: 409, code: "conflict", message: "", field: nil)))
  sender.answerReads(
    .success(decision(["id": "dec_taken", "state": "answered", "answer": ["kind": "reject"], "answered_via": "app"])))
  answers.sendNow(conflicted, AnswerDraft.Submission(answer: .approve))
  runAsync { _ = await answers.flushAndWait() }
  line("- Approve on dec_taken answers 409 while the popover is closed: outcome kept for the next opening: \"\(answers.outcome ?? "none")\"")
  if answers.outcome == nil { failures.append("a closed-popover conflict lost its outcome") }
  line("")

  // Click focus.
  line("### Notification click (NotificationFocus)")
  var focus = NotificationFocus()
  line("- click on a listed decision: \(focus.request("dec_ship", at: created, listed: ["dec_ship"]))")
  line("- click during a refresh: \(focus.request("dec_new", at: created.addingTimeInterval(10), listed: ["dec_ship"]))")
  line("  the read in flight finished before the click: \(focus.resolve(fetchedAt: created.addingTimeInterval(9), listed: ["dec_ship"]))")
  line("  the read after the click: \(focus.resolve(fetchedAt: created.addingTimeInterval(11), listed: ["dec_ship", "dec_new"]))")
  _ = focus.request("dec_gone", at: created.addingTimeInterval(20), listed: ["dec_ship"])
  line("- click on a settled decision, after the next read: \(focus.resolve(fetchedAt: created.addingTimeInterval(21), listed: ["dec_ship"]))")
  line("")
}

/// The signed-in header with the pause line, as `SignedInView` draws it.
struct PausedHeaderFixture: View {
  let end: Date
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("AgentDesk").font(.headline)
        Text("2 waiting").font(.callout).foregroundStyle(Ink.secondary)
        Spacer()
        Image(systemName: "ellipsis")
      }
      NotificationPauseLine(end: end, now: now)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(width: 340)
  }
}
