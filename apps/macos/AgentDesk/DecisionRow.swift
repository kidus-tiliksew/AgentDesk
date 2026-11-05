import AgentDeskKit
import AppKit
import SwiftUI

/// One listed decision.
struct DecisionListItem: Identifiable {
  let row: DecisionRowModel
  let decision: Decision
  /// "Couldn't send. Try again." under a row whose answer failed.
  let failure: String?

  var id: String { row.id }
}

/// What the list's rows do. The app routes each action to `AppState`; the
/// evidence harness renders the same views without one.
struct DecisionListActions {
  /// Opens the row in the detail panel, or closes the panel when it shows it.
  var toggle: (String) -> Void = { _ in }
  var answer: (String, Answer) -> Void = { _, _ in }
}

/// One pending decision (component-mac-app §Rows; req-mac-app AC-4.2 to
/// AC-4.6). Clicking its text opens it in the detail panel, and it never
/// expands; approve-or-reject rows carry Reject and Approve.
struct DecisionRow: View {
  let item: DecisionListItem
  let isSelected: Bool
  /// The detail panel shows this row's decision.
  let isShown: Bool
  let actions: DecisionListActions

  private var row: DecisionRowModel { item.row }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      summary
      if item.decision.inputType == .approveReject {
        ApproveRejectButtons(recommendation: item.decision.recommendation) {
          actions.answer(item.id, $0)
        }
      }
      if let failure = item.failure {
        Text(failure)
          .font(.callout)
          .foregroundStyle(Ink.secondary)
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
        .frame(maxWidth: .infinity, alignment: .leading)
        // In the row's leading margin, so titles keep one left edge and the
        // dot takes nothing from the two lines (req-mac-app AC-4.4).
        .background(alignment: .topLeading) {
          if row.isNew {
            Circle()
              .fill(Color.primary)
              .frame(width: 6, height: 6)
              .offset(x: -10, y: 5)
          }
        }
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        // Beside the agent, so it uses neither title line, and the agent's
        // name truncates before it or the time left does (AC-4.3).
        if let marker = row.urgentMarker {
          Text(marker)
            .fontWeight(.medium)
            .foregroundStyle(Ink.red)
            .layoutPriority(2)
        }
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
    .accessibilityHint(isShown ? "Closes the detail panel" : "Opens the detail panel")
    .accessibilityAction { actions.toggle(item.id) }
  }
}

/// Reject and Approve in one neutral style. The recommended one has the
/// hint "Suggested by the agent" (req-mac-app AC-4.5).
struct ApproveRejectButtons: View {
  let recommendation: Answer?
  let answer: (Answer) -> Void

  var body: some View {
    HStack(spacing: 8) {
      Spacer(minLength: 0)
      button("Reject", .reject)
      button("Approve", .approve)
    }
  }

  private func button(_ title: String, _ value: Answer) -> some View {
    Button(title) {
      answer(value)
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
    .accessibilityHint(recommendation == value ? "Suggested by the agent" : "")
  }
}

/// The pending decisions, scrolling once they outgrow `maxHeight`, with a
/// scroller that stays visible (req-mac-app AC-4.13). `scrollRequest` moves
/// the list: the top on opening, or a row the keys or a notification asked
/// for (component-mac-app §List scrolling). Hairlines hide around the
/// hovered, selected, or shown row.
struct DecisionList: View {
  let items: [DecisionListItem]
  let selectedID: String?
  let shownID: String?
  let maxHeight: CGFloat
  var scrollRequest = ListScrollRequest()
  var rowScrollAnimation: Animation? = .easeOut(duration: 0.15)
  var actions = DecisionListActions()
  @State private var contentHeight: CGFloat = 0
  @State private var hoveredID: String?

  private func isHighlighted(_ id: String) -> Bool {
    id == hoveredID || id == selectedID || id == shownID
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
              item: item, isSelected: item.id == selectedID, isShown: item.id == shownID,
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
        .background(PersistentScroller())
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      }
      .scrollIndicators(.visible)
      .scrollBounceBehavior(.basedOnSize)
      .frame(height: min(max(contentHeight, 1), maxHeight))
      .onChange(of: scrollRequest) { _, request in
        switch request.target {
        case .top:
          guard let first = items.first else { return }
          proxy.scrollTo(first.id, anchor: .top)
        case .row(let id):
          withAnimation(rowScrollAnimation) { proxy.scrollTo(id) }
        }
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
