import AppKit
import Network

/// The two system events that read at once: the Mac waking and the network
/// path becoming satisfied again (component-mac-app §Sync). They live in the
/// app target so `AgentDeskKit` imports neither AppKit nor Network. The app
/// state owns one for the app's lifetime.
@MainActor
final class SyncTriggers {
  private let onTrigger: @MainActor () -> Void
  private let monitor = NWPathMonitor()
  private var wakeObserver: NSObjectProtocol?
  /// Nil until the monitor reports its first path, which triggers nothing.
  private var wasSatisfied: Bool?

  init(onTrigger: @escaping @MainActor () -> Void) {
    self.onTrigger = onTrigger
    wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.onTrigger() }
    }
    monitor.pathUpdateHandler = { [weak self] path in
      let satisfied = path.status == .satisfied
      Task { @MainActor in self?.pathChanged(satisfied: satisfied) }
    }
    monitor.start(queue: DispatchQueue(label: "sh.kidus.agentdesk.mac.network-path"))
  }

  private func pathChanged(satisfied: Bool) {
    defer { wasSatisfied = satisfied }
    if satisfied, wasSatisfied == false {
      onTrigger()
    }
  }
}
