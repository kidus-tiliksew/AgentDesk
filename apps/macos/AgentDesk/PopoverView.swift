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
        opened: { state.popoverOpened() }, closed: { state.popoverClosed() },
        key: { key, editingText in state.isSignedIn && state.handle(key, editingText: editingText) }))
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

  private var actions: DecisionListActions {
    DecisionListActions(
      toggle: { state.toggle($0) },
      answer: { state.answer($0, $1) },
      send: { state.send($0) },
      draft: { item in
        Binding(
          get: { state.drafts[item.id] ?? AnswerDraft(decision: item.decision) },
          set: { state.drafts[item.id] = $0 })
      })
  }

  var body: some View {
    let items = state.listItems
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("AgentDesk")
            .font(.headline)
          Text("\(items.count) waiting")
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
      AnswerStrips(outcome: state.answerOutcome, undoText: state.undoText) { state.undo() }
      if items.isEmpty {
        EmptyDecisions()
      } else {
        DecisionList(
          items: items, selectedID: state.selectedID, expandedID: state.expandedID,
          maxHeight: listMaxHeight, actions: actions)
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
/// appearance across presentations. It also passes the popover's keys to
/// `key`, which returns false to leave a key to the focused control or the
/// window (component-mac-app §Keyboard and accessibility).
private struct PresentationObserver: NSViewRepresentable {
  let opened: @MainActor () -> Void
  let closed: @MainActor () -> Void
  let key: @MainActor (PopoverKey, _ editingText: Bool) -> Bool

  func makeNSView(context: Context) -> WindowView {
    let view = WindowView()
    view.opened = opened
    view.closed = closed
    view.key = key
    return view
  }

  func updateNSView(_ view: WindowView, context: Context) {
    view.opened = opened
    view.closed = closed
    view.key = key
  }

  final class WindowView: NSView {
    var opened: (@MainActor () -> Void)?
    var closed: (@MainActor () -> Void)?
    var key: (@MainActor (PopoverKey, Bool) -> Bool)?
    private var observers: [NSObjectProtocol] = []
    private var keyMonitor: Any?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      for observer in observers {
        NotificationCenter.default.removeObserver(observer)
      }
      observers = []
      if let keyMonitor {
        NSEvent.removeMonitor(keyMonitor)
        self.keyMonitor = nil
      }
      guard let window else { return }
      // A local monitor sees each key before the focused control, so the
      // list's keys work whichever control has focus; text fields keep their
      // arrows and Return.
      keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
        guard let key = Self.popoverKey(event) else { return event }
        let windowNumber = event.windowNumber
        let consumed = MainActor.assumeIsolated {
          guard let self, let window = self.window, window.windowNumber == windowNumber else {
            return false
          }
          return self.key?(key, window.firstResponder is NSText) == true
        }
        return consumed ? nil : event
      }
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

    /// ↑, ↓, ↩ and Enter, ⌘↩, and Escape. Any other modifier leaves the key
    /// alone.
    static func popoverKey(_ event: NSEvent) -> PopoverKey? {
      let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
      switch (event.keyCode, modifiers) {
      case (126, []): return .up
      case (125, []): return .down
      case (36, []), (76, []): return .returnKey
      case (36, .command), (76, .command): return .commandReturn
      case (53, []): return .escape
      default: return nil
      }
    }
  }
}
