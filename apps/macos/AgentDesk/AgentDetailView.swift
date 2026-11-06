import AgentDeskKit
import SwiftUI

/// What the detail panel shows for an agent session. `AppState` builds it from
/// `AgentDetail`; the evidence harness builds it from fixtures.
struct AgentDetailPresentation: Equatable {
  enum Content: Equatable {
    /// Before the first read answers, with the list's record when it holds one.
    case loading(AgentDetailModel?)
    case loaded(AgentDetailModel)
    /// The first reads failed, with the list's record when it holds one.
    case failed(AgentDetailModel?)
    case gone
  }

  var content: Content
  /// The last read failed, so the session shown may be behind.
  var refreshFailed = false

  init(content: Content, refreshFailed: Bool = false) {
    self.content = content
    self.refreshFailed = refreshFailed
  }

  init(content: AgentDetail.Content, refreshFailed: Bool, decisions: [Decision], now: Date) {
    func model(_ session: AgentSession, _ history: [StatusHistoryEntry]?) -> AgentDetailModel {
      AgentDetailModel(session: session, history: history, decisions: decisions, now: now)
    }
    switch content {
    case .loading(let seed): self.content = .loading(seed.map { model($0, nil) })
    case .loaded(let session, let history): self.content = .loaded(model(session, history))
    case .failed(let seed): self.content = .failed(seed.map { model($0, nil) })
    case .gone: self.content = .gone
    }
    self.refreshFailed = refreshFailed
  }

  var model: AgentDetailModel? {
    switch content {
    case .loading(let model), .failed(let model): model
    case .loaded(let model): model
    case .gone: nil
    }
  }
}

/// What the agent panel's controls do. Only `openLink` reaches a browser
/// (req-mac-app AC-11.4).
struct AgentDetailActions {
  /// Shows a pending decision in the panel (req-mac-app AC-11.5).
  var openDecision: (String) -> Void = { _ in }
  var close: () -> Void = {}
  var retry: () -> Void = {}
  var openLink: () -> Void = {}
}

/// The detail panel's content for one agent session (component-mac-app §Detail
/// panel; req-mac-app AC-11.3), with what the mobile agent screen shows: a fixed
/// header over a scrolling body with the state, the time since the last update,
/// the status line, the name and topic, the stale marker, the pending count, the
/// session's pending decisions, and its history newest first. Nothing here sends
/// anything to the agent (req-agent-status REQ-5).
struct AgentDetailView: View {
  let presentation: AgentDetailPresentation
  var maxHeight = CGFloat(DetailPanelPlacement.maxHeight)
  var actions = AgentDetailActions()
  @State private var headerHeight: CGFloat = 0
  @State private var contentHeight: CGFloat = 0
  @State private var hoveredDecisionID: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .measuredHeight($headerHeight)
      Divider()
      ScrollView {
        scrolled
          .padding(14)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(PersistentScroller())
          .measuredHeight($contentHeight)
      }
      .scrollIndicators(.visible)
      .scrollBounceBehavior(.basedOnSize)
      // A different session starts at its own top.
      .id(presentation.model?.id)
      .frame(height: min(max(contentHeight, 1), max(maxHeight - headerHeight - 1, 1)))
    }
    .frame(width: CGFloat(DetailPanelPlacement.width))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Agent detail")
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if let model = presentation.model {
        Text(verbatim: model.displayName)
          .lineLimit(1)
          .truncationMode(.middle)
          .foregroundStyle(Ink.secondary)
      }
      Spacer(minLength: 0)
      Button(action: actions.close) {
        Image(systemName: "xmark")
          .imageScale(.small)
      }
      .buttonStyle(.borderless)
      .foregroundStyle(Ink.secondary)
      .accessibilityLabel("Close detail")
      .accessibilityHint("Escape")
    }
    .font(.callout)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
  }

  @ViewBuilder
  private var scrolled: some View {
    switch presentation.content {
    case .loading(let model):
      VStack(alignment: .leading, spacing: 12) {
        if let model { status(model) }
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Loading this agent…").foregroundStyle(Ink.secondary)
        }
        .accessibilityElement(children: .combine)
      }
    case .failed(let model):
      VStack(alignment: .leading, spacing: 12) {
        if let model { status(model) }
        VStack(alignment: .leading, spacing: 8) {
          Text("Couldn't load this agent.").foregroundStyle(Ink.secondary)
          Button("Try Again", action: actions.retry)
            .controlSize(.small)
        }
      }
    case .gone:
      Text("This agent session is gone.").foregroundStyle(Ink.secondary)
    case .loaded(let model):
      VStack(alignment: .leading, spacing: 14) {
        status(model)
        if presentation.refreshFailed {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Couldn't refresh this agent. It may be out of date.")
              .font(.callout)
              .foregroundStyle(Ink.secondary)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Try Again", action: actions.retry)
              .controlSize(.small)
          }
        }
        Divider()
        waiting(model)
        Divider()
        history(model)
      }
    }
  }

  /// The current status, from the first read or the list's record.
  private func status(_ model: AgentDetailModel) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Circle()
          .fill(model.isBlocked ? Ink.red : Ink.tertiary)
          .frame(width: 6, height: 6)
          .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
          .accessibilityHidden(true)
        Text(verbatim: model.state)
          .fontWeight(.medium)
          .foregroundStyle(model.isBlocked ? Ink.red : Color.primary)
        if let stale = model.staleMarker {
          Text(verbatim: stale)
            .fontWeight(.medium)
            .foregroundStyle(Ink.secondary)
        }
        Spacer(minLength: 0)
        Text(verbatim: model.updateAge)
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(model.statusAccessibilityLabel)
      .accessibilityAddTraits(.isStaticText)
      if let line = model.line {
        // Plain text, so a URL in the line is never a link (AC-11.4).
        Text(verbatim: line)
          .font(.system(size: 15, weight: .semibold))
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
      }
      VStack(alignment: .leading, spacing: 4) {
        Fact(label: "Agent") { Text(verbatim: model.displayName) }
        Fact(label: "Topic") { Text(verbatim: model.topic) }
        Fact(label: "Pending") { Text(verbatim: model.pendingCountText) }
      }
      .font(.callout)
      if let link = model.link {
        VStack(alignment: .leading, spacing: 4) {
          Button("Open link", action: actions.openLink)
            .controlSize(.small)
            .accessibilityHint("Opens \(link.absoluteString) in the default browser")
          Text(verbatim: link.absoluteString)
            .font(.callout)
            .foregroundStyle(Ink.secondary)
            .textSelection(.enabled)
            .lineLimit(2)
            .truncationMode(.middle)
        }
      }
    }
  }

  private func waiting(_ model: AgentDetailModel) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Waiting on you")
        .fontWeight(.medium)
        .accessibilityAddTraits(.isHeader)
      if model.pending.isEmpty {
        Text("No pending decisions.")
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      } else {
        ForEach(model.pending) { decision in
          Button {
            actions.openDecision(decision.id)
          } label: {
            VStack(alignment: .leading, spacing: 1) {
              Text(verbatim: decision.title)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
              meta(decision)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .background(
            RoundedRectangle(cornerRadius: 6)
              .fill(Color.primary.opacity(hoveredDecisionID == decision.id ? 0.06 : 0))
          )
          .padding(.horizontal, -6)
          .onHover { inside in
            if inside {
              hoveredDecisionID = decision.id
            } else if hoveredDecisionID == decision.id {
              hoveredDecisionID = nil
            }
          }
          .accessibilityLabel(decision.title)
          .accessibilityValue(decision.accessibilityValue)
          .accessibilityHint("Shows this decision in the panel")
        }
      }
    }
  }

  private func meta(_ decision: AgentDetailModel.PendingDecision) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      if let marker = decision.urgentMarker {
        Text(verbatim: marker)
          .fontWeight(.medium)
          .foregroundStyle(Ink.red)
      }
      if let timeLeft = decision.timeLeft {
        Text(verbatim: timeLeft)
          .foregroundStyle(decision.timeLeftIsRed ? Ink.red : Ink.secondary)
        Text(verbatim: "·")
          .foregroundStyle(Ink.secondary)
      }
      Text(verbatim: decision.age)
        .foregroundStyle(Ink.secondary)
    }
    .font(.callout)
  }

  private func history(_ model: AgentDetailModel) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("History")
        .fontWeight(.medium)
        .accessibilityAddTraits(.isHeader)
      if let history = model.history, !history.isEmpty {
        ForEach(history) { entry in
          VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(verbatim: entry.state)
                .fontWeight(.medium)
              Text(verbatim: entry.age)
                .foregroundStyle(Ink.secondary)
            }
            .font(.callout)
            // Plain selectable text: no part of a history entry opens a
            // browser (AC-11.4).
            Text(verbatim: entry.line)
              .font(.callout)
              .textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
            if let link = entry.link {
              Text(verbatim: link)
                .font(.callout)
                .foregroundStyle(Ink.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      } else {
        Text("No earlier statuses.")
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      }
    }
  }
}
