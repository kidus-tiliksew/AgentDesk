import AgentDeskKit
import SwiftUI

/// "N active · M quiet · K blocked", which expands to the live sessions:
/// blocked, then active, then a control that reveals the quiet ones
/// (component-mac-app §Agents line; req-mac-app REQ-5).
struct AgentsView: View {
  let agents: [AgentSession]
  let now: Date
  @Binding var expanded: Bool
  @Binding var quietRevealed: Bool
  /// The session the detail panel shows.
  var shownID: String?
  /// Shows the session in the panel, or closes the panel when it shows it
  /// (req-mac-app AC-5.3, AC-11.7).
  var open: (String) -> Void = { _ in }
  @State private var listHeight: CGFloat = 0
  @State private var hoveredID: String?

  static let maxListHeight: CGFloat = 160

  var body: some View {
    let summary = AgentsSummary(agents: agents)
    let canExpand = summary.total > 0
    VStack(alignment: .leading, spacing: 0) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 0) {
          Text(summary.activeText)
            .foregroundStyle(Ink.secondary)
          if let quiet = summary.quietText {
            Text(quiet)
              .foregroundStyle(Ink.secondary)
          }
          if let blocked = summary.blockedText {
            Text(blocked)
              .foregroundStyle(Ink.red)
          }
          Spacer(minLength: 8)
          if canExpand {
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(Ink.tertiary)
          }
        }
        .font(.callout)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!canExpand)
      .padding(.horizontal, 14)
      .padding(.top, 12)
      .padding(.bottom, 7)
      .accessibilityLabel(summary.accessibilityLabel)
      .accessibilityValue(canExpand ? (expanded ? "Expanded" : "Collapsed") : "")

      if expanded, canExpand {
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(AgentSessionOrder.listed(agents)) { session in
              entry(session)
            }
            if summary.quiet > 0 {
              quietControl(summary)
              if quietRevealed {
                ForEach(AgentSessionOrder.quiet(agents)) { session in
                  entry(session)
                }
              }
            }
          }
          .padding(.bottom, 6)
          .background(PersistentScroller())
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
        }
        .scrollIndicators(.visible)
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(listHeight, 1), Self.maxListHeight))
      }
    }
  }

  private func entry(_ session: AgentSession) -> some View {
    AgentEntry(
      entry: AgentEntryModel(session: session, now: now),
      isHighlighted: session.id == hoveredID || session.id == shownID,
      isShown: session.id == shownID,
      open: { open(session.id) }
    )
    .onHover { inside in
      if inside {
        hoveredID = session.id
      } else if hoveredID == session.id {
        hoveredID = nil
      }
    }
  }

  /// "Show N quiet", or "Hide quiet" while the quiet sessions show.
  private func quietControl(_ summary: AgentsSummary) -> some View {
    Button {
      quietRevealed.toggle()
    } label: {
      HStack(spacing: 4) {
        Text(quietRevealed ? AgentsSummary.hideQuietText : summary.showQuietText)
        Image(systemName: quietRevealed ? "chevron.up" : "chevron.down")
          .font(.system(size: 8, weight: .semibold))
        Spacer(minLength: 0)
      }
      .font(.callout)
      .foregroundStyle(Ink.secondary)
      .padding(.horizontal, 14)
      .padding(.vertical, 5)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityValue(quietRevealed ? "Expanded" : "Collapsed")
  }
}

/// One live session on one line: its dot, short name, and state. The status
/// line is not drawn; the label keeps it, with the full display name, for
/// VoiceOver. Clicking the entry shows the session in the detail panel, with or
/// without a link, and opens no browser (req-mac-app AC-5.2, AC-5.3, AC-5.4).
struct AgentEntry: View {
  let entry: AgentEntryModel
  var isHighlighted = false
  var isShown = false
  var open: () -> Void = {}

  var body: some View {
    Button(action: open) {
      content
    }
    .buttonStyle(.plain)
    .background(
      RoundedRectangle(cornerRadius: 6)
        .fill(Color.primary.opacity(isHighlighted ? 0.06 : 0))
        .padding(.horizontal, 6)
    )
    .accessibilityLabel(entry.accessibilityLabel)
    .accessibilityHint(isShown ? "Closes the detail panel" : "Shows this session in the detail panel")
    .accessibilityAddTraits(isShown ? .isSelected : [])
  }

  private var content: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Circle()
        .fill(dotColor)
        .frame(width: 6, height: 6)
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
      Text(entry.shortName)
        .font(.system(size: 13))
        .foregroundStyle(.primary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 8)
      // The name gives way first; the state never truncates.
      Text(entry.stateText)
        .font(.callout)
        .foregroundStyle(Ink.tertiary)
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 7)
    .contentShape(Rectangle())
  }

  /// AC-5.5: a dot's color; the name and the state take none of them.
  private var dotColor: Color {
    switch entry.dot {
    case .green: Ink.green
    case .amber: Ink.amber
    case .red: Ink.red
    case .neutral: Ink.tertiary
    }
  }
}
