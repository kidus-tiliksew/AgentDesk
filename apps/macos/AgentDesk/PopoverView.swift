import SwiftUI

/// The popover: 340 pt wide and at most 560 pt tall (component-mac-app
/// §Popover). Signed out it holds sign-in; signed in it holds the header and
/// its menu, and this slice leaves the rest empty.
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
  }
}

struct SignedInView: View {
  let state: AppState

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("AgentDesk")
          .font(.headline)
        Spacer()
        AccountMenu(state: state)
      }
      if let error = state.loginItemError {
        Text(error)
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .onAppear { state.refreshLoginItem() }
  }
}

/// The `•••` menu. This slice holds Open at Login, Sign Out, and Quit
/// (req-mac-app AC-8.1, AC-8.2).
struct AccountMenu: View {
  let state: AppState

  var body: some View {
    Menu {
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
