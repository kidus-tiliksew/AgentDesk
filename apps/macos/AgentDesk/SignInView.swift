import AgentDeskKit
import SwiftUI

/// The signed-out popover: a short code the user approves in the mobile app
/// (component-mac-app §Sign-in; req-mac-app REQ-2).
struct SignInView: View {
  let state: AppState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("AgentDesk")
        .font(.headline)

      content

      if let notice = state.notice {
        Text(notice)
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Divider()
      Button("Quit AgentDesk") { state.quit() }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .keyboardShortcut("q")
    }
    .padding(14)
  }

  @ViewBuilder
  private var content: some View {
    switch state.signInPhase {
    case .idle, .complete:
      Text("Sign in by approving this Mac in the AgentDesk app on your phone.")
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Button("Sign In") { state.startSignIn() }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)

    case .starting:
      ProgressView()
        .controlSize(.small)
        .accessibilityLabel("Getting a code")

    case .waiting(let code, let machineName):
      Text("Enter this code in the AgentDesk app on your phone.")
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Text(code)
        .font(.system(size: 28, weight: .semibold, design: .monospaced))
        .textSelection(.enabled)
        .accessibilityLabel(code.map(String.init).joined(separator: " "))
      Text("\(machineName) will connect as AgentDesk for Mac.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text("Waiting for approval")
          .font(.callout)
          .foregroundStyle(.secondary)
        Spacer()
        Button("Cancel") { state.cancelSignIn() }
      }

    case .failed(let failure):
      Text(failure.message)
        .fixedSize(horizontal: false, vertical: true)
      Button(failure.offersNewCode ? "New code" : "Try Again") { state.startSignIn() }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
    }
  }
}
