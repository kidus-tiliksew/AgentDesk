import Foundation

/// Decides from each complete successful decisions read which notifications
/// to post, which decisions to mark notified without a post, and which
/// delivered notifications to remove (component-mac-app §Notifications;
/// req-mac-app REQ-6; DEC-19(5)).
///
/// A pending decision is posted when all five conditions hold:
///
/// 1. Its `notification_action` is `push` (AC-6.1).
/// 2. Its id is not in `NotifiedStore`, and no post for it is in flight.
/// 3. Its `created_at` is at most 10 minutes before now (AC-6.7).
/// 4. It is not interactive, or 120 seconds have passed since `created_at`
///    (AC-6.2; req-notification-rules REQ-8).
/// 5. The popover is closed, notifications are on, and no pause is running
///    (AC-6.6).
///
/// The planner reads only `created_at` and the clock it is given, so
/// starting, signing in, and every later read apply the same age rule.
public enum NotificationPlanner {
  /// The hold before an interactive decision is posted, so an agent whose
  /// user is at the chat gets the answer there first.
  public static let interactiveHold: TimeInterval = 120
  /// The oldest decision a read may post for.
  public static let maxAge: TimeInterval = 600

  /// What the app is doing when a read lands.
  public struct Context: Equatable, Sendable {
    public var now: Date
    public var isPopoverOpen: Bool
    /// Notifications are on and no pause is running.
    public var allowsPosting: Bool
    /// Ids in `NotifiedStore`.
    public var notified: Set<String>
    /// Ids whose post is in flight.
    public var posting: Set<String>
    /// Identifiers of the notifications in Notification Center.
    public var delivered: Set<String>

    public init(
      now: Date, isPopoverOpen: Bool, allowsPosting: Bool, notified: Set<String> = [],
      posting: Set<String> = [], delivered: Set<String> = []
    ) {
      self.now = now
      self.isPopoverOpen = isPopoverOpen
      self.allowsPosting = allowsPosting
      self.notified = notified
      self.posting = posting
      self.delivered = delivered
    }
  }

  public struct Plan: Equatable, Sendable {
    /// Decisions to post, in the read's order.
    public var post: [Decision]
    /// Decisions the open popover lists, added to `NotifiedStore` without a
    /// post because the user sees their rows.
    public var markNotified: [String]
    /// Delivered notifications whose decision the read no longer lists as
    /// pending: settled, cancelled, or expired (AC-6.5).
    public var remove: [String]

    public init(post: [Decision] = [], markNotified: [String] = [], remove: [String] = []) {
      self.post = post
      self.markNotified = markNotified
      self.remove = remove
    }
  }

  public static func plan(pending decisions: [Decision], context: Context) -> Plan {
    let pending = decisions.filter { $0.state == .pending }
    let pendingIDs = Set(pending.map(\.id))
    var plan = Plan()
    plan.remove = context.delivered.subtracting(pendingIDs).sorted()
    if context.isPopoverOpen {
      plan.markNotified = pending.map(\.id).filter { !context.notified.contains($0) }
      return plan
    }
    guard context.allowsPosting else { return plan }
    plan.post = pending.filter {
      isRouted($0) && !context.notified.contains($0.id) && !context.posting.contains($0.id)
        && isTimely($0, now: context.now)
    }
    return plan
  }

  /// Condition 1: the user's rules routed the decision's creation to push.
  /// Digest, mute, and a decision routing has not reached never post.
  public static func isRouted(_ decision: Decision) -> Bool {
    decision.notificationAction == .push
  }

  /// Conditions 3 and 4: young enough to post, and past the interactive
  /// hold when the decision is interactive.
  public static func isTimely(_ decision: Decision, now: Date) -> Bool {
    let age = now.timeIntervalSince(decision.createdAt)
    guard age <= maxAge else { return false }
    return !decision.interactive || age >= interactiveHold
  }
}

/// One notification as the app target hands it to `UNUserNotificationCenter`.
/// It names the decision by id and holds no credential (DEC-19(3)).
public struct NotificationRequest: Equatable, Sendable {
  public static let approveRejectCategory = "decision.approve_reject"
  public static let rejectAction = "reject"
  public static let approveAction = "approve"

  /// The decision id, so a click, an action, and removal find the decision.
  public var identifier: String
  public var title: String
  /// The agent's display name, and the time left when the decision has a
  /// deadline.
  public var body: String
  /// `decision.approve_reject` for approve-or-reject decisions.
  public var categoryIdentifier: String?
  public var playsDefaultSound: Bool

  public init(
    identifier: String, title: String, body: String, categoryIdentifier: String?,
    playsDefaultSound: Bool = true
  ) {
    self.identifier = identifier
    self.title = title
    self.body = body
    self.categoryIdentifier = categoryIdentifier
    self.playsDefaultSound = playsDefaultSound
  }

  /// The notification for a decision: its title, the agent's display name,
  /// and the time left when it has a deadline, with the default sound
  /// (req-mac-app AC-6.1, AC-6.3).
  public init(decision: Decision, agentName: String, now: Date) {
    var body = [agentName]
    if let deadline = decision.deadline {
      body.append(DecisionPresentation.timeLeft(until: deadline, now: now))
    }
    self.init(
      identifier: decision.id, title: decision.title, body: body.joined(separator: " · "),
      categoryIdentifier: decision.inputType == .approveReject ? Self.approveRejectCategory : nil)
  }

  /// The answer a notification action gives, or nil for an unknown action
  /// or a decision that is not approve-or-reject.
  public static func answer(forAction action: String, decision: Decision) -> Answer? {
    guard decision.inputType == .approveReject else { return nil }
    switch action {
    case approveAction: return .approve
    case rejectAction: return .reject
    default: return nil
    }
  }
}

/// The decision a notification click asked the popover to expand
/// (req-mac-app AC-6.4). The target waits for the first decisions read that
/// lands after the click, so a click during a refresh still expands its row,
/// and a target that read no longer lists expands nothing.
public struct NotificationFocus: Equatable, Sendable {
  public enum Resolution: Equatable, Sendable {
    /// Select and expand this decision.
    case expand(String)
    /// The target is not listed; expand nothing.
    case drop
    /// Keep waiting for a read.
    case wait
  }

  public private(set) var target: String?
  private var requestedAt: Date?

  public init() {}

  /// A click on the notification for `id` at `now`. A decision the list
  /// already shows expands at once.
  public mutating func request(_ id: String, at now: Date, listed: [String]) -> Resolution {
    if listed.contains(id) {
      clear()
      return .expand(id)
    }
    target = id
    requestedAt = now
    return .wait
  }

  /// A decisions read finished at `fetchedAt` listing `listed`. A read that
  /// finished before the click leaves the target waiting.
  public mutating func resolve(fetchedAt: Date?, listed: [String]) -> Resolution {
    guard let target, let requestedAt else { return .wait }
    guard let fetchedAt, fetchedAt >= requestedAt else { return .wait }
    clear()
    return listed.contains(target) ? .expand(target) : .drop
  }

  /// Sign-out and the popover closing end the target.
  public mutating func clear() {
    target = nil
    requestedAt = nil
  }
}
