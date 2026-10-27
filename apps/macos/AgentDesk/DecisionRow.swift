import AgentDeskKit
import SwiftUI

/// One pending decision as a read-only row (component-mac-app §Rows;
/// req-mac-app AC-4.2 to AC-4.4). Answer controls come with a later task.
struct DecisionRow: View {
  let row: DecisionRowModel

  var body: some View {
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
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    // One element: VoiceOver reads the title, then the agent, time left, new
    // and urgent, and the suggestion (req-mac-app AC-7.2).
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.accessibilityLabel)
    .accessibilityValue(row.accessibilityValue)
  }
}

/// The pending decisions, scrolling once they outgrow `maxHeight`.
struct DecisionList: View {
  let rows: [DecisionRowModel]
  let maxHeight: CGFloat
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
          if index > 0 {
            Divider().padding(.horizontal, 14)
          }
          DecisionRow(row: row)
        }
      }
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(height: min(max(contentHeight, 1), maxHeight))
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
