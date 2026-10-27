import AgentDeskKit
import AppKit
import SwiftUI

/// One listed decision with what its expanded row shows.
struct DecisionListItem: Identifiable {
  let row: DecisionRowModel
  let decision: Decision
  /// The asking session's page, when it is live and has a web link.
  let agentLink: URL?
  /// "If nobody answers by <time>, the agent goes with <default>."
  let defaultSentence: String?
  /// "Couldn't send. Try again." under a row whose answer failed.
  let failure: String?

  var id: String { row.id }
}

/// What the list's rows do. The app routes each action to `AppState`; the
/// evidence harness renders the same views without one.
struct DecisionListActions {
  var toggle: (String) -> Void = { _ in }
  var answer: (String, Answer) -> Void = { _, _ in }
  var send: (String) -> Void = { _ in }
  var openLink: (URL) -> Void = { NSWorkspace.shared.open($0) }
  /// The expanded row's draft.
  var draft: (DecisionListItem) -> Binding<AnswerDraft> = { .constant(AnswerDraft(decision: $0.decision)) }
}

/// One pending decision (component-mac-app §Rows; req-mac-app AC-4.2 to
/// AC-4.7). Clicking its text expands it in place; approve-or-reject rows
/// carry Reject and Approve.
struct DecisionRow: View {
  let item: DecisionListItem
  let isSelected: Bool
  let isExpanded: Bool
  let actions: DecisionListActions

  private var row: DecisionRowModel { item.row }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      summary
      if item.decision.inputType == .approveReject {
        ApproveRejectButtons(item: item, actions: actions)
      }
      if let failure = item.failure {
        Text(failure)
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      }
      if isExpanded {
        AnswerControls(item: item, draft: actions.draft(item), actions: actions)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var summary: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(row.title)
        .font(.system(size: 13, weight: row.isNew ? .semibold : .medium))
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("\(row.agentName) · \(row.age)")
          .lineLimit(1)
          .truncationMode(.middle)
          .foregroundStyle(Ink.secondary)
        Spacer(minLength: 0)
        if let timeLeft = row.timeLeft {
          Text(timeLeft)
            .foregroundStyle(row.timeLeftIsRed ? Ink.red : Ink.secondary)
            .layoutPriority(1)
        }
      }
      .font(.callout)
      if let suggestion = row.suggestion {
        Text(suggestion)
          .font(.callout)
          .foregroundStyle(Ink.tertiary)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .onTapGesture { actions.toggle(item.id) }
    // One element: VoiceOver reads the title, then the agent, time left, new
    // and urgent, and the suggestion. The answer buttons stay separate
    // elements (req-mac-app AC-7.2).
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.accessibilityLabel)
    .accessibilityValue(row.accessibilityValue)
    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    .accessibilityHint(isExpanded ? "Collapses the decision" : "Expands the decision")
    .accessibilityAction { actions.toggle(item.id) }
  }
}

/// Reject and Approve. The recommended one has accent-colored text and the
/// hint "Suggested by the agent" (req-mac-app AC-4.5).
struct ApproveRejectButtons: View {
  let item: DecisionListItem
  let actions: DecisionListActions

  var body: some View {
    HStack(spacing: 8) {
      Spacer(minLength: 0)
      button("Reject", .reject)
      button("Approve", .approve)
    }
  }

  private func button(_ title: String, _ answer: Answer) -> some View {
    let suggested = item.decision.recommendation == answer
    return Button {
      actions.answer(item.id, answer)
    } label: {
      Text(title)
        .foregroundStyle(suggested ? Color.accentColor : Color.primary)
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
    .accessibilityHint(suggested ? "Suggested by the agent" : "")
  }
}

/// The pending decisions, scrolling once they outgrow `maxHeight`. Hairlines
/// hide around the hovered, selected, or expanded row.
struct DecisionList: View {
  let items: [DecisionListItem]
  let selectedID: String?
  let expandedID: String?
  let maxHeight: CGFloat
  var actions = DecisionListActions()
  @State private var contentHeight: CGFloat = 0
  @State private var hoveredID: String?

  private func isHighlighted(_ id: String) -> Bool {
    id == hoveredID || id == selectedID || id == expandedID
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 0) {
          ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            if index > 0 {
              Divider()
                .padding(.horizontal, 14)
                .opacity(isHighlighted(items[index - 1].id) || isHighlighted(item.id) ? 0 : 1)
            }
            DecisionRow(
              item: item, isSelected: item.id == selectedID, isExpanded: item.id == expandedID,
              actions: actions
            )
            .background(
              RoundedRectangle(cornerRadius: 6)
                .fill(Color.primary.opacity(isHighlighted(item.id) ? 0.06 : 0))
                .padding(.horizontal, 6)
            )
            .onHover { inside in
              if inside {
                hoveredID = item.id
              } else if hoveredID == item.id {
                hoveredID = nil
              }
            }
            .id(item.id)
          }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(height: min(max(contentHeight, 1), maxHeight))
      .onChange(of: selectedID) { _, id in
        guard let id else { return }
        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(id) }
      }
    }
  }
}

/// The strips above the list: a conflict's recorded outcome, and the held
/// answer with Undo (req-mac-app AC-4.8, AC-4.9).
struct AnswerStrips: View {
  let outcome: String?
  let undoText: String?
  var undo: () -> Void = {}

  var body: some View {
    if outcome != nil || undoText != nil {
      VStack(alignment: .leading, spacing: 0) {
        if let outcome {
          Text(outcome)
            .font(.callout)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        if let undoText {
          HStack(spacing: 8) {
            Text(undoText)
              .font(.callout)
              .lineLimit(1)
              .truncationMode(.tail)
            Spacer(minLength: 0)
            Button("Undo", action: undo)
              .buttonStyle(.borderless)
              .controlSize(.small)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 6)
        }
        Divider()
      }
      .background(Color.primary.opacity(0.04))
    }
  }
}

/// The list when nothing is pending (req-mac-app AC-4.11).
struct EmptyDecisions: View {
  var body: some View {
    VStack(spacing: 4) {
      Text("Nothing waiting on you")
        .font(.system(size: 13, weight: .medium))
      Text("New questions will show up here.")
        .font(.callout)
        .foregroundStyle(Ink.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
    .accessibilityElement(children: .combine)
  }
}
