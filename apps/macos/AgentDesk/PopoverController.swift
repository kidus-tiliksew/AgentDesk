import AgentDeskKit
import AppKit
import Observation
import SwiftUI

/// The menu bar item, its popover, and the detail panel beside it: one
/// `NSStatusItem`, an `NSPopover` hosting `PopoverView`, and one
/// `DetailPanelWindow` (component-mac-app §Menu bar item, §Popover, §Detail
/// panel). The app owns the presentation, so a notification click can open the
/// popover on macOS 14, which `MenuBarExtra` offers no call for (req-mac-app
/// AC-6.4), and it owns the popover's lifetime, since a transient popover
/// would close on a click in the panel (AC-11.8). The popover's show and close
/// events mark it open and closed for `AppState`. The hosting controller lives
/// as long as the process, so the list keeps its scroll offset between
/// openings until `AppState` asks for the top (component-mac-app §List
/// scrolling).
@MainActor
final class PopoverController: NSObject, NSPopoverDelegate {
  private let state: AppState
  private let statusItem: NSStatusItem
  private let popover = NSPopover()
  private let detail: DetailPanelController<DetailPanelRoot>
  private var lifetime: PairedWindowLifetime?
  /// What the panel shows, as `AppState` last reported it.
  private var panelTarget: DetailPanelTarget?

  init(state: AppState) {
    self.state = state
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    detail = DetailPanelController { DetailPanelRoot(state: state, maxHeight: $0) }
    super.init()
    let host = NSHostingController(rootView: PopoverView(state: state))
    // The popover follows the view's size: 340 pt wide, at most 560 pt tall.
    host.sizingOptions = [.preferredContentSize]
    popover.contentViewController = host
    // `PairedWindowLifetime` closes it, because `.transient` closes on a click
    // in the panel (req-mac-app AC-11.8).
    popover.behavior = .applicationDefined
    popover.delegate = self
    if let button = statusItem.button {
      button.target = self
      button.action = #selector(togglePopover(_:))
      button.imagePosition = .imageOnly
    }
    lifetime = PairedWindowLifetime(
      isOwned: { [weak self] window in
        guard let self else { return false }
        return window === self.popoverWindow || window === self.detail.window
      },
      isStatusItem: { [weak self] window in window === self?.statusItem.button?.window },
      close: { [weak self] in self?.close() })
    state.presenter = PopoverPresenter(
      show: { [weak self] in self?.show() }, close: { [weak self] in self?.close() },
      panelChanged: { [weak self] in self?.panelChanged($0) })
    updateLabel()
  }

  private var popoverWindow: NSWindow? { popover.contentViewController?.view.window }

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
    popoverWindow?.makeKey()
  }

  func close() {
    guard popover.isShown else { return }
    popover.performClose(nil)
  }

  /// Follows `AppState`'s target: opening, replacing, or closing the one
  /// panel. Closing gives key focus back to the popover (AC-11.11).
  private func panelChanged(_ target: DetailPanelTarget?) {
    guard target != panelTarget else { return }
    panelTarget = target
    guard let target else {
      detail.hide()
      if popover.isShown { popoverWindow?.makeKey() }
      return
    }
    detail.window.setAccessibilityTitle(target.agentID == nil ? "Decision detail" : "Agent detail")
    guard popover.isShown, let anchor = popover.contentViewController?.view else { return }
    detail.present(beside: anchor)
  }

  // MARK: NSPopoverDelegate

  func popoverWillShow(_ notification: Notification) {
    lifetime?.start()
    state.popoverOpened()
  }

  func popoverDidShow(_ notification: Notification) {
    state.popoverShown()
  }

  /// Both windows leave together; closing only the panel never reaches here,
  /// so it neither flushes an answer nor marks the popover closed.
  func popoverWillClose(_ notification: Notification) {
    state.closeDetail()
  }

  func popoverDidClose(_ notification: Notification) {
    lifetime?.stop()
    state.popoverClosed()
  }
}

/// How `AppState` asks for the popover and the panel to open or close.
struct PopoverPresenter {
  let show: @MainActor () -> Void
  let close: @MainActor () -> Void
  /// The panel's target changed; nil closes it.
  let panelChanged: @MainActor (DetailPanelTarget?) -> Void
}
