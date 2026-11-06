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
    // Content that still exceeds the limit is cut at the bottom, never above
    // the first row.
    .frame(maxHeight: CGFloat(PopoverLayout.maxHeight), alignment: .top)
    // `PopoverController` marks the popover open and closed from its show
    // and close events.
    .background(
      PopoverKeyObserver { key, editingText in state.handleWindowKey(key, editingText: editingText) })
  }
}

/// The detail panel's content from `AppState`, a decision or an agent session
/// (component-mac-app §Detail panel), with the same keys as the popover.
struct DetailPanelRoot: View {
  let state: AppState
  let maxHeight: CGFloat

  var body: some View {
    Group {
      if let presentation = state.agentPresentation {
        AgentDetailView(
          presentation: presentation, maxHeight: maxHeight,
          actions: AgentDetailActions(
            openDecision: { state.showLinked($0) },
            close: { state.closeDetail() },
            retry: { state.retryDetail() },
            openLink: { state.openAgentLink() }))
      } else if let presentation = state.detailPresentation {
        DecisionDetailView(
          presentation: presentation, maxHeight: maxHeight,
          actions: DecisionDetailActions(
            open: { state.showLinked($0) },
            close: { state.closeDetail() },
            retry: { state.retryDetail() },
            answer: { state.answer($0, $1) },
            send: { state.send($0) },
            draft: { decision in
              Binding(
                get: { state.drafts[decision.id] ?? .forPanel(decision) },
                set: { state.drafts[decision.id] = $0 })
            }))
      }
    }
    .background(
      PopoverKeyObserver(controlsKeepArrows: true) { key, editingText in
        state.handleWindowKey(key, editingText: editingText)
      })
  }
}

struct SignedInView: View {
  let state: AppState
  @State private var agentsExpanded = false
  @State private var quietRevealed = false
  @State private var headerHeight: CGFloat = 0
  @State private var stripsHeight: CGFloat = 0
  @State private var agentsHeight: CGFloat = 0

  /// What remains of the 560 pt popover beside everything else it shows, so
  /// a strip, the pause line, or the agents list shortens the list.
  private var listMaxHeight: CGFloat {
    // Two 1 pt hairlines separate the list from the header and the agents.
    CGFloat(PopoverLayout.listMaxHeight(chromeHeight: Double(headerHeight + stripsHeight + agentsHeight + 2)))
  }

  private var actions: DecisionListActions {
    DecisionListActions(toggle: { state.toggle($0) }, answer: { state.answer($0, $1) })
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
        if let end = state.notificationPauseEnd {
          NotificationPauseLine(end: end, now: state.now)
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
      .measuredHeight($headerHeight)

      Divider()
      AnswerStrips(outcome: state.answerOutcome, undoText: state.undoText) { state.undo() }
        .measuredHeight($stripsHeight)
      if items.isEmpty {
        EmptyDecisions()
      } else {
        DecisionList(
          items: items, selectedID: state.selectedID, shownID: state.shownID,
          maxHeight: listMaxHeight, scrollRequest: state.listScroll, actions: actions)
      }
      Divider()
      AgentsView(
        agents: state.snapshot.agents, now: state.now, expanded: $agentsExpanded,
        quietRevealed: $quietRevealed, shownID: state.shownAgentID,
        open: { state.toggleAgent($0) }
      )
      .measuredHeight($agentsHeight)
    }
    .onAppear { state.refreshLoginItem() }
  }
}

/// The `•••` menu: pausing and resuming notifications, Notifications On and
/// Off, the menu bar style, Open at Login, Sign Out, and Quit (req-mac-app
/// AC-3.4, AC-6.6, AC-8.1, AC-8.2).
struct AccountMenu: View {
  let state: AppState

  var body: some View {
    Menu {
      if state.notificationPauseEnd != nil {
        Button("Resume Notifications") { state.resumeNotifications() }
      } else {
        Button("Pause Notifications for 1 Hour") { state.pauseNotifications() }
          .disabled(!state.notificationsOn)
      }
      Picker(
        "Notifications",
        selection: Binding(get: { state.notificationsOn }, set: { state.setNotificationsOn($0) })
      ) {
        Text("On").tag(true)
        Text("Off").tag(false)
      }
      .pickerStyle(.inline)
      Divider()
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
