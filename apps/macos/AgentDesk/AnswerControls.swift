import AgentDeskKit
import SwiftUI

/// The detail panel's answer controls (component-mac-app §Detail panel;
/// req-mac-app AC-4.7, AC-11.2): the controls for the input type with the
/// recommendation preselected and labelled "Suggested", the note field, and
/// Reject and Approve or Send. Every control binds to the decision's
/// `AnswerDraft`, which builds the answer Send and ⌘↩ submit.
struct AnswerControls: View {
  let decision: Decision
  @Binding var draft: AnswerDraft
  let answer: (Answer) -> Void
  let send: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      inputs
      TextField("Note for the agent (optional)", text: $draft.note, axis: .vertical)
        .lineLimit(1...4)
        .textFieldStyle(.roundedBorder)
        .accessibilityLabel("Note for the agent")
      if !draft.noteIsValid {
        Text("Notes can be up to \(AnswerDraft.noteLimit) characters.")
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      }
      footer
    }
  }

  @ViewBuilder
  private var inputs: some View {
    switch decision.inputType {
    case .approveReject:
      EmptyView()
    case .singleChoice:
      radios
    case .multipleChoice:
      VStack(alignment: .leading, spacing: 4) {
        ForEach(draft.options) { option in
          Toggle(isOn: checked(option.id)) { optionLabel(option) }
            .toggleStyle(.checkbox)
        }
      }
    case .freeText:
      textField(placeholder: draft.suggestedText ?? "Your answer")
    case .singleChoiceOrText:
      radios
      textField(placeholder: draft.suggestedText ?? "Or type another answer")
    }
  }

  private var radios: some View {
    Picker("Answer", selection: $draft.selectedOption) {
      ForEach(draft.options) { option in
        optionLabel(option).tag(Optional(option.id))
      }
    }
    .pickerStyle(.radioGroup)
    .labelsHidden()
  }

  private func optionLabel(_ option: Option) -> Text {
    guard draft.isSuggested(option.id) else { return Text(option.label) }
    return Text(option.label) + Text("  Suggested").foregroundStyle(Ink.tertiary)
  }

  private func checked(_ id: String) -> Binding<Bool> {
    Binding(
      get: { draft.selectedOptions.contains(id) },
      set: { on in
        if on { draft.selectedOptions.insert(id) } else { draft.selectedOptions.remove(id) }
      })
  }

  private func textField(placeholder: String) -> some View {
    TextField(placeholder, text: $draft.text, axis: .vertical)
      .lineLimit(1...4)
      .textFieldStyle(.roundedBorder)
      .accessibilityLabel("Your answer")
  }

  @ViewBuilder
  private var footer: some View {
    if decision.inputType == .approveReject {
      ApproveRejectButtons(recommendation: decision.recommendation, answer: answer)
    } else {
      HStack(spacing: 10) {
        Spacer(minLength: 0)
        Text("⌘↩")
          .font(.callout)
          .foregroundStyle(Ink.tertiary)
          .accessibilityHidden(true)
        Button("Send", action: send)
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .disabled(!draft.canSend)
          .accessibilityHint("Command-Return")
      }
    }
  }
}

/// The body as Markdown with `.inlineOnlyPreservingWhitespace`. The panel's
/// own scroll view scrolls it (req-mac-app AC-11.9).
struct MarkdownBody: View {
  let text: String

  private var rendered: AttributedString {
    (try? AttributedString(
      markdown: text,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
  }

  var body: some View {
    Text(rendered)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
  }
}
