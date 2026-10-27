import AgentDeskKit
import SwiftUI

/// The expanded row (component-mac-app §Rows; req-mac-app AC-4.6, AC-4.7):
/// the body as Markdown, the controls for the input type with the
/// recommendation preselected and labelled "Suggested", the deadline and
/// default, Add note, Open agent page, and Send. Every control binds to the
/// row's `AnswerDraft`, which builds the answer Send and ⌘↩ submit.
struct AnswerControls: View {
  let item: DecisionListItem
  @Binding var draft: AnswerDraft
  let actions: DecisionListActions

  private var decision: Decision { item.decision }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let body = decision.body, !body.isEmpty {
        MarkdownBody(text: body)
      }
      inputs
      if let sentence = item.defaultSentence {
        Text(sentence)
          .font(.callout)
          .foregroundStyle(Ink.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if draft.isNoteOpen {
        TextField("Note for the agent", text: $draft.note, axis: .vertical)
          .lineLimit(1...4)
          .textFieldStyle(.roundedBorder)
        if !draft.noteIsValid {
          Text("Notes can be up to \(AnswerDraft.noteLimit) characters.")
            .font(.callout)
            .foregroundStyle(Ink.secondary)
        }
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
  }

  private var footer: some View {
    HStack(spacing: 10) {
      if !draft.isNoteOpen {
        Button("Add note") { draft.isNoteOpen = true }
          .buttonStyle(.link)
      }
      if let link = item.agentLink {
        Button("Open agent page") { actions.openLink(link) }
          .buttonStyle(.link)
      }
      Spacer(minLength: 0)
      if decision.inputType != .approveReject {
        Text("⌘↩")
          .font(.callout)
          .foregroundStyle(Ink.tertiary)
          .accessibilityHidden(true)
        Button("Send") { actions.send(item.id) }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .disabled(!draft.canSend)
          .accessibilityHint("Command-Return")
      }
    }
    .font(.callout)
  }
}

/// The body as Markdown with `.inlineOnlyPreservingWhitespace`, scrolling
/// within 150 pt.
struct MarkdownBody: View {
  static let maxHeight: CGFloat = 150

  let text: String
  @State private var height: CGFloat = 0

  private var rendered: AttributedString {
    (try? AttributedString(
      markdown: text,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
  }

  var body: some View {
    ScrollView {
      Text(rendered)
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(height: min(max(height, 1), Self.maxHeight))
  }
}
