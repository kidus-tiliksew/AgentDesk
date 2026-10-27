import AgentDeskKit
import AppKit
import SwiftUI

/// The popover: 340 pt wide and at most 560 pt tall (component-mac-app
/// §Popover). Signed out it holds sign-in; signed in it holds the header and
/// its menu, the pending decisions, and the agents line.
struct PopoverView: View {
  let state: AppState

  var body: some View {
    Group {
      if state.isSignedIn {
        SignedInView(state: state)
      } else {
        SignInView(state: state)
      }
    }
    .frame(width: 340)
    .frame(maxHeight: 560)
    // The root view's appear and disappear mark the popover open and closed;
    // the window's key changes back them up. Both calls are idempotent.
    .onAppear { state.popoverOpened() }
    .onDisappear { state.popoverClosed() }
    .background(
      PresentationObserver(
        opened: { state.popoverOpened() }, closed: { state.popoverClosed() }))
  }
}

struct SignedInView: View {
  let state: AppState
  @State private var agentsExpanded = false

  /// The list's share of the 560 pt popover beside the header and the
  /// agents line, and beside the agents list when it is expanded.
  private var listMaxHeight: CGFloat {
    agentsExpanded ? 470 - AgentsView.maxListHeight : 470
  }

  var body: some View {
    let rows = state.rows
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("AgentDesk")
            .font(.headline)
          Text("\(rows.count) waiting")
            .font(.callout)
            .foregroundStyle(Ink.secondary)
          Spacer()
          AccountMenu(state: state)
        }
        if let error = state.loginItemError {
          Text(error)
            .font(.callout)
            .foregroundStyle(Ink.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)

      Divider()
      if rows.isEmpty {
        EmptyDecisions()
      } else {
        DecisionList(rows: rows, maxHeight: listMaxHeight)
      }
      Divider()
      AgentsView(agents: state.snapshot.agents, now: state.now, expanded: $agentsExpanded)
    }
    .onAppear { state.refreshLoginItem() }
  }
}

/// The `•••` menu. This slice holds the menu bar style, Open at Login, Sign
/// Out, and Quit (req-mac-app AC-3.4, AC-8.1, AC-8.2).
struct AccountMenu: View {
  let state: AppState

  var body: some View {
    Menu {
      Picker(
        "Menu bar",
        selection: Binding(get: { state.menuBarStyle }, set: { state.setMenuBarStyle($0) })
      ) {
        Text("Dot").tag(MenuBarStyle.dot)
        Text("Count").tag(MenuBarStyle.count)
      }
      .pickerStyle(.inline)
      Divider()
      Toggle(
        "Open at Login",
        isOn: Binding(get: { state.openAtLogin }, set: { state.setOpenAtLogin($0) }))
      Divider()
      Button("Sign Out") { state.signOut() }
      Button("Quit AgentDesk") { state.quit() }
        .keyboardShortcut("q")
    } label: {
      Image(systemName: "ellipsis")
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .accessibilityLabel("More")
  }
}

/// Reports the popover window becoming key when it opens and resigning key
/// when it closes, for `MenuBarExtra` versions whose content keeps its
/// appearance across presentations.
private struct PresentationObserver: NSViewRepresentable {
  let opened: @MainActor () -> Void
  let closed: @MainActor () -> Void

  func makeNSView(context: Context) -> WindowView {
    let view = WindowView()
    view.opened = opened
    view.closed = closed
    return view
  }

  func updateNSView(_ view: WindowView, context: Context) {
    view.opened = opened
    view.closed = closed
  }

  final class WindowView: NSView {
    var opened: (@MainActor () -> Void)?
    var closed: (@MainActor () -> Void)?
    private var observers: [NSObjectProtocol] = []

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      for observer in observers {
        NotificationCenter.default.removeObserver(observer)
      }
      observers = []
      guard let window else { return }
      let center = NotificationCenter.default
      observers.append(
        center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) {
          [weak self] _ in
          MainActor.assumeIsolated { self?.opened?() }
        })
      observers.append(
        center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) {
          [weak self] _ in
          MainActor.assumeIsolated { self?.closed?() }
        })
    }
  }
}
