import ExpoNotifications
@testable import Handoff
@preconcurrency import UserNotifications
import XCTest

// These tests run the pinned expo-notifications delegate loop and queue
// (`NotificationCenterManager.userNotificationCenter(_:didReceive:withCompletionHandler:)`
// and `addDelegate`). A fake emitter stands in for expo-notifications'
// `EmitterModule`: React Native creates that module when a host starts, it
// registers through `addDelegate`, and every response it receives reaches the
// JavaScript response listener and the launch response. Each test uses its
// own request id, because the manager is a process-wide singleton whose queue
// keeps earlier tests' responses.

/// Mirrors `EmitterModule.didReceive`: it takes every response it is offered.
final class FakeEmitter: NotificationDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var received: [UNNotificationResponse] = []

  func count(requestId: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return received.filter { $0.notification.request.identifier == requestId }.count
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    lock.lock()
    received.append(response)
    lock.unlock()
    completionHandler()
    return true
  }
}

/// Mirrors `ActionResponseDelegate.didReceive`: it requests a host start and
/// returns false.
final class RequestingDelegate: NotificationDelegate, @unchecked Sendable {
  let handoff: ColdPressHostStart

  init(handoff: ColdPressHostStart) {
    self.handoff = handoff
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    handoff.request(requestId: response.notification.request.identifier, actionId: response.actionIdentifier)
    return false
  }
}

/// The defect the review found: a delegate that starts the host, and so
/// registers the emitter, inside the delegate loop.
final class InlineStartDelegate: NotificationDelegate, @unchecked Sendable {
  let emitter: FakeEmitter

  init(emitter: FakeEmitter) {
    self.emitter = emitter
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    NotificationCenterManager.shared.addDelegate(emitter)
    return false
  }
}

/// A later delegate in the copied list that holds the delegate loop open until
/// the test releases it, so the press stays out of the queue meanwhile.
final class BlockingDelegate: NotificationDelegate, @unchecked Sendable {
  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    entered.signal()
    release.wait()
    return false
  }
}

/// The test's React host: starting it registers the emitter at once, the
/// earliest that a real host could.
@MainActor
final class FakeHost {
  let emitter = FakeEmitter()
  private(set) var running = false
  private(set) var starts = 0
  var onStart: (() -> Void)?

  func start() {
    starts += 1
    running = true
    NotificationCenterManager.shared.addDelegate(emitter)
    onStart?()
  }

  func hooks(isQueued: (@MainActor @Sendable (String, String) -> Bool)? = nil) -> ColdPressHostStart.Hooks {
    return ColdPressHostStart.Hooks(
      hostRunning: { [unowned self] in self.running },
      isQueued: isQueued ?? { requestId, actionId in
        isQueuedInNotificationCenter(requestId: requestId, actionId: actionId)
      },
      startHost: { [unowned self] in self.start() }
    )
  }
}

func makeResponse(requestId: String, actionId: String = "approve") -> UNNotificationResponse {
  let content = UNMutableNotificationContent()
  content.categoryIdentifier = "decision-approve-reject"
  let request = UNNotificationRequest(identifier: requestId, content: content, trigger: nil)
  // UserNotifications has no public initializers for these two types.
  let notification = (UNNotification.self as AnyObject)
    .perform(NSSelectorFromString("notificationWithRequest:date:"), with: request, with: Date())!
    .takeUnretainedValue() as! UNNotification
  return (UNNotificationResponse.self as AnyObject)
    .perform(NSSelectorFromString("responseWithNotification:actionIdentifier:"), with: notification, with: actionId)!
    .takeUnretainedValue() as! UNNotificationResponse
}

/// The manager ignores the center argument. The instance is allocated and
/// never initialized or released, because `current()` stops a test process.
let unusedCenter = (UNUserNotificationCenter.self as AnyObject)
  .perform(NSSelectorFromString("alloc"))!
  .takeUnretainedValue() as! UNUserNotificationCenter

func deliver(_ response: UNNotificationResponse) {
  NotificationCenterManager.shared.userNotificationCenter(
    unusedCenter,
    didReceive: response,
    withCompletionHandler: {}
  )
}

@MainActor
final class ColdPressHostStartTests: XCTestCase {
  private var added: [AnyObject] = []

  override func tearDown() {
    for delegate in added {
      NotificationCenterManager.shared.removeDelegate(delegate)
    }
    added = []
    super.tearDown()
  }

  private func add(_ delegate: NotificationDelegate) {
    NotificationCenterManager.shared.addDelegate(delegate)
    added.append(delegate)
  }

  private func waitForStart(_ host: FakeHost, timeout: TimeInterval = 3) {
    let started = expectation(description: "host started")
    host.onStart = { started.fulfill() }
    wait(for: [started], timeout: timeout)
  }

  /// Pumps the main queue so scheduled checks can run.
  private func pump(seconds: TimeInterval) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }

  /// Control: with the pinned manager, an emitter that registers inside the
  /// delegate loop misses the press on both paths, and the press stays queued.
  func testEmitterRegisteredInsideDelegateLoopMissesThePress() {
    let requestId = "inline-start"
    let emitter = FakeEmitter()
    add(InlineStartDelegate(emitter: emitter))
    added.append(emitter)

    deliver(makeResponse(requestId: requestId))

    XCTAssertEqual(emitter.count(requestId: requestId), 0)
    XCTAssertTrue(isQueuedInNotificationCenter(requestId: requestId, actionId: "approve"))
  }

  /// A cold press delivered on the main thread: the host starts after the
  /// delegate loop queues the press, and the emitter receives it once.
  func testHostStartsAfterTheQueueAndTheEmitterReceivesThePressOnce() {
    let requestId = "main-thread-press"
    let host = FakeHost()
    add(RequestingDelegate(handoff: ColdPressHostStart(hooks: host.hooks())))
    added.append(host.emitter)

    deliver(makeResponse(requestId: requestId))
    XCTAssertEqual(host.starts, 0, "the host must not start inside the delegate loop")

    waitForStart(host)
    XCTAssertEqual(host.starts, 1)
    XCTAssertEqual(host.emitter.count(requestId: requestId), 1)
  }

  /// A cold press delivered off the main thread, with the delegate loop held
  /// open after the request: the host waits until the press is queued.
  func testOffMainDeliveryWaitsUntilThePressIsQueued() {
    let requestId = "off-main-press"
    let host = FakeHost()
    let blocker = BlockingDelegate()
    add(RequestingDelegate(handoff: ColdPressHostStart(hooks: host.hooks())))
    add(blocker)
    added.append(host.emitter)

    let response = makeResponse(requestId: requestId)
    let delivered = expectation(description: "delivery returned")
    DispatchQueue.global().async {
      deliver(response)
      delivered.fulfill()
    }
    XCTAssertEqual(blocker.entered.wait(timeout: .now() + 3), .success)

    pump(seconds: 0.3)
    XCTAssertEqual(host.starts, 0, "the host must wait while the press is not queued")

    blocker.release.signal()
    waitForStart(host)
    wait(for: [delivered], timeout: 3)
    XCTAssertEqual(host.starts, 1)
    XCTAssertEqual(host.emitter.count(requestId: requestId), 1)
  }

  /// A press while the host runs: the emitter is in the copied list and takes
  /// the press in the loop, and no second start happens.
  func testRunningHostTakesThePressWithoutAStart() {
    let requestId = "warm-press"
    let host = FakeHost()
    host.start()
    added.append(host.emitter)
    add(RequestingDelegate(handoff: ColdPressHostStart(hooks: host.hooks())))

    deliver(makeResponse(requestId: requestId))
    pump(seconds: 0.2)

    XCTAssertEqual(host.starts, 1)
    XCTAssertEqual(host.emitter.count(requestId: requestId), 1)
    XCTAssertFalse(isQueuedInNotificationCenter(requestId: requestId, actionId: "approve"))
  }

  /// Two presses before the host starts: one start, and the emitter receives
  /// each press once.
  func testTwoPressesStartOneHost() {
    let host = FakeHost()
    add(RequestingDelegate(handoff: ColdPressHostStart(hooks: host.hooks())))
    added.append(host.emitter)

    deliver(makeResponse(requestId: "first-press"))
    deliver(makeResponse(requestId: "second-press", actionId: "reject"))

    waitForStart(host)
    pump(seconds: 0.2)
    XCTAssertEqual(host.starts, 1)
    XCTAssertEqual(host.emitter.count(requestId: "first-press"), 1)
    XCTAssertEqual(host.emitter.count(requestId: "second-press"), 1)
  }

  /// The probe leaves the queue as it was.
  func testProbeKeepsTheQueue() {
    let requestId = "probe-press"
    deliver(makeResponse(requestId: requestId))

    XCTAssertTrue(isQueuedInNotificationCenter(requestId: requestId, actionId: "approve"))
    XCTAssertTrue(isQueuedInNotificationCenter(requestId: requestId, actionId: "approve"))
    XCTAssertFalse(isQueuedInNotificationCenter(requestId: requestId, actionId: "reject"))
  }

  /// A press that never reaches the queue still starts the host after the
  /// bounded wait.
  func testHostStartsAfterTheBoundedWait() {
    let host = FakeHost()
    let handoff = ColdPressHostStart(hooks: host.hooks(isQueued: { _, _ in false }))
    added.append(host.emitter)

    handoff.request(requestId: "never-queued", actionId: "approve")
    pump(seconds: 0.2)
    XCTAssertEqual(host.starts, 0)

    waitForStart(host, timeout: Double(ColdPressHostStart.attempts) * ColdPressHostStart.retryDelay + 3)
    XCTAssertEqual(host.starts, 1)
  }
}
