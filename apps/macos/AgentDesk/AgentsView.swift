import AgentDeskKit
import AppKit
import SwiftUI

/// "N active · M quiet · K blocked", which expands to the live sessions:
/// blocked, then active, then a control that reveals the quiet ones
/// (component-mac-app §Agents line; req-mac-app REQ-5).
struct AgentsView: View {
  let agents: [AgentSession]
  let now: Date
  @Binding var expanded: Bool
  @Binding var quietRevealed: Bool
  @State private var listHeight: CGFloat = 0

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
      .padding(.vertical, 9)
      .accessibilityLabel(summary.accessibilityLabel)
      .accessibilityValue(canExpand ? (expanded ? "Expanded" : "Collapsed") : "")

      if expanded, canExpand {
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(AgentSessionOrder.listed(agents)) { session in
              AgentEntry(entry: AgentEntryModel(session: session, now: now))
            }
            if summary.quiet > 0 {
              quietControl(summary)
              if quietRevealed {
                ForEach(AgentSessionOrder.quiet(agents)) { session in
                  AgentEntry(entry: AgentEntryModel(session: session, now: now))
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

/// One live session: its dot, name, state, and status line. A session with a
/// link opens it in the default browser until the agent panel replaces this
/// (req-mac-app AC-5.2).
struct AgentEntry: View {
  let entry: AgentEntryModel

  var body: some View {
    if let link = entry.link {
      Button {
        NSWorkspace.shared.open(link)
      } label: {
        content
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(entry.accessibilityLabel)
      .accessibilityHint("Opens the agent's page")
      .accessibilityAddTraits(.isLink)
    } else {
      content
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(entry.accessibilityLabel)
    }
  }

  private var content: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Circle()
        .fill(entry.isBlocked ? Ink.red : Ink.tertiary)
        .frame(width: 6, height: 6)
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
      VStack(alignment: .leading, spacing: 1) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(entry.displayName)
            .lineLimit(1)
          Text(entry.stateText)
            .foregroundStyle(Ink.tertiary)
            .lineLimit(1)
        }
        if let line = entry.line {
          Text(line)
            .lineLimit(1)
            .foregroundStyle(Ink.secondary)
        }
      }
      Spacer(minLength: 0)
    }
    .font(.callout)
    .padding(.horizontal, 14)
    .padding(.vertical, 4)
    .contentShape(Rectangle())
  }
}
