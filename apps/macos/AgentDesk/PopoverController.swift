import AgentDeskKit
import AppKit
import Observation
import SwiftUI

/// The menu bar item and its popover: one `NSStatusItem` and a transient
/// `NSPopover` hosting `PopoverView` (component-mac-app §Menu bar item,
/// §Popover). The app owns the presentation, so a notification click can
/// open the popover on macOS 14, which `MenuBarExtra` offers no call for
/// (req-mac-app AC-6.4). The popover's show and close events mark it open
/// and closed for `AppState`.
@MainActor
final class PopoverController: NSObject, NSPopoverDelegate {
  private let state: AppState
  private let statusItem: NSStatusItem
  private let popover = NSPopover()

  init(state: AppState) {
    self.state = state
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()
    let host = NSHostingController(rootView: PopoverView(state: state))
    // The popover follows the view's size: 340 pt wide, at most 560 pt tall.
    host.sizingOptions = [.preferredContentSize]
    popover.contentViewController = host
    popover.behavior = .transient
    popover.delegate = self
    if let button = statusItem.button {
      button.target = self
      button.action = #selector(togglePopover(_:))
      button.imagePosition = .imageOnly
    }
    state.presenter = PopoverPresenter(
      show: { [weak self] in self?.show() }, close: { [weak self] in self?.close() })
    updateLabel()
  }

  /// Redraws the label whenever a value it reads changes.
  private func updateLabel() {
    withObservationTracking {
      let image = MenuBarLabel.image(for: state)
      statusItem.button?.image = image
      statusItem.button?.setAccessibilityLabel(state.labelDescription)
    } onChange: { [weak self] in
      Task { @MainActor in self?.updateLabel() }
    }
  }

  @objc private func togglePopover(_ sender: Any?) {
    if popover.isShown {
      close()
    } else {
      show()
    }
  }

  /// Opens the popover under the menu bar item and gives it key focus
  /// (req-mac-app AC-7.1).
  func show() {
    guard let button = statusItem.button else { return }
    NSApp.activate()
    if !popover.isShown {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }
    popover.contentViewController?.view.window?.makeKey()
  }

  func close() {
    guard popover.isShown else { return }
    popover.performClose(nil)
  }

  // MARK: NSPopoverDelegate

  func popoverWillShow(_ notification: Notification) {
    state.popoverOpened()
  }

  func popoverDidClose(_ notification: Notification) {
    state.popoverClosed()
  }
}

/// How `AppState` asks for the popover to open or close.
struct PopoverPresenter {
  let show: @MainActor () -> Void
  let close: @MainActor () -> Void
}
