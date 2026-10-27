import AgentDeskKit
import AppKit
import SwiftUI

/// "N agents running · M blocked", which expands to the live sessions
/// (component-mac-app §Agents line; req-mac-app REQ-5).
struct AgentsView: View {
  let agents: [AgentSession]
  let now: Date
  @Binding var expanded: Bool
  @State private var listHeight: CGFloat = 0

  static let maxListHeight: CGFloat = 160

  var body: some View {
    let summary = AgentsSummary(agents: agents)
    let canExpand = summary.running > 0
    VStack(alignment: .leading, spacing: 0) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 0) {
          Text(summary.runningText)
            .foregroundStyle(Ink.secondary)
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
      .accessibilityLabel(
        summary.blocked > 0
          ? "\(summary.runningText), \(summary.blocked) blocked" : summary.runningText
      )
      .accessibilityValue(canExpand ? (expanded ? "Expanded" : "Collapsed") : "")

      if expanded, canExpand {
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(AgentSessionOrder.sorted(agents)) { session in
              AgentEntry(entry: AgentEntryModel(session: session, now: now))
            }
          }
          .padding(.bottom, 6)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(listHeight, 1), Self.maxListHeight))
      }
    }
  }
}

/// One live session: its dot, name, state, and status line. A session with a
/// link opens it in the default browser (req-mac-app AC-5.2, AC-5.3).
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
