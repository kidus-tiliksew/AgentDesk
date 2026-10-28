import Foundation
import XCTest

@testable import AgentDeskKit

/// The posted ids and this Mac's notification settings (component-mac-app
/// §Notifications; req-mac-app AC-6.1, AC-6.6, AC-8.1).
@MainActor
final class NotifiedStoreTests: XCTestCase {
  private func signedInAccount(_ server: StubServer, token: String) throws -> Account {
    let account = Account(
      configuration: server.configuration, credentials: MemoryCredentialStore(),
      session: server.makeSession(), userAgent: "AgentDeskMac/9.9.9")
    try account.signIn(token: token)
    return account
  }

  // MARK: NotifiedStore

  func testMarkedIdsSurviveARestart() {
    let defaults = makeDefaults()
    let store = NotifiedStore(defaults: defaults)
    XCTAssertTrue(store.ids.isEmpty)
    store.mark(["dec_1", "dec_2"])
    XCTAssertTrue(store.contains("dec_1"))
    XCTAssertEqual(NotifiedStore(defaults: defaults).ids, ["dec_1", "dec_2"])
  }

  func testPruningKeepsOnlyPendingIds() {
    let defaults = makeDefaults()
    let store = NotifiedStore(defaults: defaults)
    store.mark(["dec_1", "dec_2", "dec_3"])
    store.prune(toPending: ["dec_2", "dec_9"])
    XCTAssertEqual(store.ids, ["dec_2"])
    XCTAssertEqual(NotifiedStore(defaults: defaults).ids, ["dec_2"])
  }

  func testSignOutClearsTheStoreAndDeliveredNotifications() async throws {
    let defaults = makeDefaults()
    let server = StubServer { _ in .json(204, "") }
    let account = try signedInAccount(server, token: "adp_live")
    let center = FakeNotificationCenter()
    let notifier = Notifier(
      center: center, settings: NotificationSettings(defaults: defaults),
      store: NotifiedStore(defaults: defaults), readAgents: { [] })
    notifier.resetOnSignOut(of: account)
    notifier.store.mark(["dec_1"])

    _ = await account.signOut()
    XCTAssertTrue(notifier.store.ids.isEmpty)
    XCTAssertNil(defaults.object(forKey: NotifiedStore.key))
    XCTAssertEqual(center.removedAll, 1)
  }

  func testAnUnauthorizedAnswerClearsTheStore() async throws {
    let defaults = makeDefaults()
    let server = StubServer { _ in .error(401, "unauthenticated", "Revoked") }
    let account = try signedInAccount(server, token: "adp_revoked")
    let center = FakeNotificationCenter()
    let notifier = Notifier(
      center: center, settings: NotificationSettings(defaults: defaults),
      store: NotifiedStore(defaults: defaults), readAgents: { [] })
    notifier.resetOnSignOut(of: account)
    notifier.store.mark(["dec_1"])

    _ = try? await account.api.pendingDecisions()
    XCTAssertEqual(account.state, .signedOut)
    XCTAssertTrue(notifier.store.ids.isEmpty)
    XCTAssertEqual(center.removedAll, 1)
  }

  // MARK: NotificationSettings

  func testNotificationsStartOnAndUnpaused() {
    let settings = NotificationSettings(defaults: makeDefaults())
    let now = Fixtures.instant("2026-10-27T12:00:00Z")
    XCTAssertTrue(settings.isOn)
    XCTAssertNil(settings.pauseEnd(now: now))
    XCTAssertTrue(settings.allowsPosting(now: now))
  }

  func testAPauseLastsOneHourAndSurvivesARestart() {
    let defaults = makeDefaults()
    let settings = NotificationSettings(defaults: defaults)
    let now = Fixtures.instant("2026-10-27T12:00:00Z")
    settings.pause(now: now)
    let end = now.addingTimeInterval(3600)
    XCTAssertEqual(settings.pauseEnd(now: now), end)
    XCTAssertFalse(settings.allowsPosting(now: now))
    XCTAssertFalse(settings.allowsPosting(now: end.addingTimeInterval(-0.001)))

    let restarted = NotificationSettings(defaults: defaults)
    XCTAssertEqual(restarted.pauseEnd(now: now), end)
    XCTAssertNil(restarted.pauseEnd(now: end), "the pause ends at its end time")
    XCTAssertTrue(restarted.allowsPosting(now: end))
  }

  func testResumeEndsThePause() {
    let defaults = makeDefaults()
    let settings = NotificationSettings(defaults: defaults)
    let now = Fixtures.instant("2026-10-27T12:00:00Z")
    settings.pause(now: now)
    settings.resume()
    XCTAssertTrue(settings.allowsPosting(now: now))
    XCTAssertNil(NotificationSettings(defaults: defaults).pauseEnd(now: now))
  }

  func testOffSurvivesARestartAndAPauseEnding() {
    let defaults = makeDefaults()
    let settings = NotificationSettings(defaults: defaults)
    let now = Fixtures.instant("2026-10-27T12:00:00Z")
    settings.pause(now: now)
    settings.setOn(false)
    let restarted = NotificationSettings(defaults: defaults)
    XCTAssertFalse(restarted.isOn)
    XCTAssertFalse(restarted.allowsPosting(now: now.addingTimeInterval(7200)), "off outlasts the pause")
    restarted.setOn(true)
    XCTAssertTrue(restarted.allowsPosting(now: now.addingTimeInterval(7200)))
  }

  func testSettingsLeaveTheMenuBarItemAndListUnchanged() {
    // The dot, count, and rows read the decisions and seen ids alone, so a
    // pause or Off changes neither (AC-6.6).
    let defaults = makeDefaults()
    let settings = NotificationSettings(defaults: defaults)
    let now = Fixtures.instant("2026-10-27T12:00:00Z")
    let decisions = [Fixtures.pending("dec_1", ["notification_action": "push"])]
    let before = MenuBarSummary(decisions: decisions, seen: [], now: now)
    settings.pause(now: now)
    settings.setOn(false)
    XCTAssertEqual(MenuBarSummary(decisions: decisions, seen: [], now: now), before)
    XCTAssertTrue(before.dot)
    XCTAssertEqual(before.count, 1)
  }
}
