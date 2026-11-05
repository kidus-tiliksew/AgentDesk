import AgentDeskKit
import AppKit
import SwiftUI

/// The one window beside the popover (req-mac-app REQ-11; DEC-23(1), (2)). A
/// borderless panel takes key focus through this override, and it stays out of
/// the Dock, the Windows menu, and window switching (AC-1.1).
final class DetailPanelWindow: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  init() {
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: DetailPanelPlacement.width, height: 120),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    isReleasedWhenClosed = false
    isExcludedFromWindowsMenu = true
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true
    collectionBehavior = [.transient, .ignoresCycle, .moveToActiveSpace]
    setAccessibilityTitle("Decision detail")
  }
}

/// Owns the panel and its SwiftUI content and keeps it placed beside the
/// popover's content view (component-mac-app §Detail panel).
@MainActor
final class DetailPanelController<Root: View> {
  let window = DetailPanelWindow()
  private static var cornerRadius: CGFloat { 10 }

  private let host: NSHostingController<Root>
  private let root: (CGFloat) -> Root
  private var maxHeight = CGFloat(DetailPanelPlacement.maxHeight)
  private var anchor: NSView?
  private var observers: [NSObjectProtocol] = []
  private var heightObservation: NSKeyValueObservation?

  /// `root` builds the content for the height the screen leaves.
  init(root: @escaping (CGFloat) -> Root) {
    self.root = root
    host = NSHostingController(rootView: root(maxHeight))
    host.sizingOptions = [.preferredContentSize]
    let material = NSVisualEffectView()
    material.material = .popover
    material.blendingMode = .behindWindow
    material.state = .active
    material.maskImage = Self.roundedMask(radius: Self.cornerRadius)
    window.contentView = material
    host.view.frame = material.bounds
    host.view.autoresizingMask = [.width, .height]
    material.addSubview(host.view)
  }

  var isVisible: Bool { window.isVisible }

  /// Shows the panel beside `anchor`, the popover's content view, at its
  /// window's level, and gives it key focus with no control focused, so the
  /// arrow keys and Return keep moving the list until the user tabs in.
  func present(beside anchor: NSView) {
    guard let anchorWindow = anchor.window else { return }
    let isNewAnchor = self.anchor !== anchor || !window.isVisible
    self.anchor = anchor
    window.level = anchorWindow.level
    if isNewAnchor { observePlacement(of: anchorWindow) }
    place()
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(nil)
  }

  func hide() {
    stopObserving()
    anchor = nil
    window.orderOut(nil)
  }

  /// Moves the panel to where the placement policy says it belongs.
  func place() {
    guard let anchor, let anchorWindow = anchor.window else { return }
    let inWindow = anchor.convert(anchor.bounds, to: nil)
    let popover = Self.rect(anchorWindow.convertToScreen(inWindow))
    guard let visible = (anchorWindow.screen ?? NSScreen.main)?.visibleFrame else { return }
    let screen = Self.rect(visible)
    let available = CGFloat(DetailPanelPlacement.availableHeight(popover: popover, screen: screen))
    if available != maxHeight {
      maxHeight = available
      host.rootView = root(available)
    }
    host.view.layoutSubtreeIfNeeded()
    let frame = DetailPanelPlacement.frame(
      popover: popover, screen: screen, contentHeight: Double(host.preferredContentSize.height))
    window.setFrame(
      NSRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height), display: true)
    window.invalidateShadow()
  }

  private func observePlacement(of anchorWindow: NSWindow) {
    stopObserving()
    let center = NotificationCenter.default
    let names: [(Notification.Name, AnyObject?)] = [
      (NSWindow.didMoveNotification, anchorWindow),
      (NSWindow.didResizeNotification, anchorWindow),
      (NSApplication.didChangeScreenParametersNotification, nil),
    ]
    observers = names.map { name, object in
      center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.place() }
      }
    }
    heightObservation = host.observe(\.preferredContentSize) { [weak self] _, _ in
      // After the layout pass that changed it, not inside it.
      Task { @MainActor in self?.place() }
    }
  }

  private func stopObserving() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    heightObservation = nil
  }

  private static func rect(_ rect: NSRect) -> PanelRect {
    PanelRect(
      x: Double(rect.minX), y: Double(rect.minY), width: Double(rect.width), height: Double(rect.height))
  }

  /// A stretchable rounded mask for the material, as the popover's own corners.
  private static func roundedMask(radius: CGFloat) -> NSImage {
    let edge = radius * 2 + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
  }
}

/// Closes the popover and the panel together while they show, in place of a
/// transient popover, which would close on a click in the panel (req-mac-app
/// AC-11.8; DEC-23(2)). A click in either window keeps both. A click anywhere
/// else, a Space change, or the app's deactivation closes both. Losing key
/// status alone closes nothing, since focus moves between the two windows. The
/// click itself is never swallowed.
@MainActor
final class PairedWindowLifetime {
  /// Whether a click in this window belongs to the pair.
  private let isOwned: (NSWindow) -> Bool
  /// Whether this window holds the menu bar item, whose action closes the pair.
  private let isStatusItem: (NSWindow) -> Bool
  private let close: () -> Void
  private var localMonitor: Any?
  private var globalMonitor: Any?
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []
  private var menuIsTracking = false
  /// Moves on every stop, so a click the global monitor queued before a stop
  /// never closes a later pair.
  private var generation = 0
  /// Whether clicks in other apps close the pair. The evidence harness turns
  /// this off, so whatever the Mac's user clicks during a run changes nothing.
  private let watchesOtherApps: Bool

  init(
    isOwned: @escaping (NSWindow) -> Bool, isStatusItem: @escaping (NSWindow) -> Bool,
    watchesOtherApps: Bool = true, close: @escaping () -> Void
  ) {
    self.isOwned = isOwned
    self.isStatusItem = isStatusItem
    self.watchesOtherApps = watchesOtherApps
    self.close = close
  }

  var isRunning: Bool { localMonitor != nil }

  func start() {
    guard !isRunning else { return }
    let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    localMonitor = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
      let windowNumber = event.windowNumber
      MainActor.assumeIsolated { self?.clicked(windowNumber: windowNumber) }
      return event
    }
    // A click in another app never reaches the local monitor, and it does not
    // deactivate this app when it lands on the desktop or the menu bar.
    if watchesOtherApps {
      let generation = self.generation
      globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.generation == generation else { return }
          self.apply(.elsewhere)
        }
      }
    }
    observe(.default, NSApplication.didResignActiveNotification) { $0.close() }
    observe(NSWorkspace.shared.notificationCenter, NSWorkspace.activeSpaceDidChangeNotification) {
      $0.close()
    }
    observe(.default, NSMenu.didBeginTrackingNotification) { $0.menuIsTracking = true }
    observe(.default, NSMenu.didEndTrackingNotification) { $0.menuIsTracking = false }
  }

  func stop() {
    generation += 1
    if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
    localMonitor = nil
    globalMonitor = nil
    for (center, observer) in observers { center.removeObserver(observer) }
    observers = []
    menuIsTracking = false
  }

  private func observe(
    _ center: NotificationCenter, _ name: Notification.Name,
    _ action: @escaping @MainActor (PairedWindowLifetime) -> Void
  ) {
    let observer = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        action(self)
      }
    }
    observers.append((center, observer))
  }

  private func clicked(windowNumber: Int) {
    guard let window = NSApp.window(withWindowNumber: windowNumber) else {
      apply(.elsewhere)
      return
    }
    if isStatusItem(window) {
      apply(.statusItem)
    } else if ownsWithParents(window) {
      apply(.ownedWindow)
    } else {
      apply(.elsewhere)
    }
  }

  /// Text field menus and the like are children of the pair's windows.
  private func ownsWithParents(_ window: NSWindow) -> Bool {
    var current: NSWindow? = window
    while let next = current {
      if isOwned(next) { return true }
      current = next.parent
    }
    return false
  }

  private func apply(_ click: PopoverDismissal.Click) {
    if PopoverDismissal.closes(click, menuIsTracking: menuIsTracking) { close() }
  }
}
