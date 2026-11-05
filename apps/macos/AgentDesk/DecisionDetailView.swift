import AgentDeskKit
import SwiftUI

/// What the detail panel shows. `AppState` builds it from `DecisionDetail`;
/// the evidence harness builds it from fixtures.
struct DetailPanelPresentation: Equatable {
  enum Content: Equatable {
    case loading
    case loaded(DecisionDetailModel, Decision)
    case unavailable
    case failed
  }

  var content: Content
  /// "Couldn't send. Try again." after a failed send of this decision.
  var failure: String?
  /// False while this Mac's answer to the decision is held or sending.
  var isAnswerable = true
  /// The last read failed, so the record shown may be behind.
  var refreshFailed = false
}

/// What the panel's controls do.
struct DecisionDetailActions {
  /// Shows a parent or follow-up in the panel (req-mac-app AC-11.5).
  var open: (String) -> Void = { _ in }
  var close: () -> Void = {}
  var retry: () -> Void = {}
  var answer: (String, Answer) -> Void = { _, _ in }
  var send: (String) -> Void = { _ in }
  var draft: (Decision) -> Binding<AnswerDraft> = { .constant(.forPanel($0)) }
}

/// The detail panel's content (component-mac-app §Detail panel; req-mac-app
/// REQ-11): a fixed header with the agent, the age, and a close control, over
/// a scrolling body with the title, Markdown body, facts, links, and either
/// the answer controls or the recorded outcome.
struct DecisionDetailView: View {
  let presentation: DetailPanelPresentation
  var maxHeight = CGFloat(DetailPanelPlacement.maxHeight)
  var actions = DecisionDetailActions()
  @State private var headerHeight: CGFloat = 0
  @State private var contentHeight: CGFloat = 0

  private var model: DecisionDetailModel? {
    if case .loaded(let model, _) = presentation.content { return model }
    return nil
  }

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
      // A different decision starts at its own top.
      .id(model?.id)
      .frame(height: min(max(contentHeight, 1), max(maxHeight - headerHeight - 1, 1)))
    }
    .frame(width: CGFloat(DetailPanelPlacement.width))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Decision detail")
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if let model {
        if let marker = model.urgentMarker {
          Text(marker)
            .fontWeight(.medium)
            .foregroundStyle(Ink.red)
            .layoutPriority(2)
        }
        Text("\(model.agentName) · \(model.age)")
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
    case .loading:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Loading the decision…").foregroundStyle(Ink.secondary)
      }
      .accessibilityElement(children: .combine)
    case .unavailable:
      Text("This decision isn't available.").foregroundStyle(Ink.secondary)
    case .failed:
      VStack(alignment: .leading, spacing: 8) {
        Text("Couldn't load this decision.").foregroundStyle(Ink.secondary)
        Button("Try Again", action: actions.retry)
          .controlSize(.small)
      }
    case .loaded(let model, let decision):
      loaded(model, decision)
    }
  }

  private func loaded(_ model: DecisionDetailModel, _ decision: Decision) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(model.title)
        .font(.system(size: 15, weight: .semibold))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      if presentation.refreshFailed {
        Text("Couldn't refresh this decision. It may be out of date.")
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      }
      if let outcome = model.outcome {
        OutcomeView(outcome: outcome)
      }
      if let body = model.body {
        MarkdownBody(text: body)
      }
      facts(model)
      links(model)
      if model.isPending {
        Divider()
        controls(model, decision)
      }
    }
  }

  private func facts(_ model: DecisionDetailModel) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let recommendation = model.recommendation {
        Fact(label: "Recommendation") { Text(recommendation) }
      }
      if let deadline = model.deadline {
        Fact(label: "Deadline") {
          HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(deadline)
            if let timeLeft = model.timeLeft {
              Text("·").foregroundStyle(Ink.secondary)
              Text(timeLeft).foregroundStyle(model.timeLeftIsRed ? Ink.red : Color.primary)
            }
          }
        }
      }
      if let fallback = model.defaultAnswer {
        Fact(label: "Default") { Text(fallback) }
      }
      Fact(label: "Topic") { Text(model.topic) }
    }
    .font(.callout)
  }

  @ViewBuilder
  private func links(_ model: DecisionDetailModel) -> some View {
    if model.parent != nil || !model.followUps.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        if let parent = model.parent {
          link(parent)
        }
        if !model.followUps.isEmpty {
          Text("Follow-ups")
            .foregroundStyle(Ink.secondary)
            .accessibilityAddTraits(.isHeader)
          ForEach(model.followUps) { link($0) }
        }
      }
      .font(.callout)
    }
  }

  private func link(_ link: DecisionDetailModel.Link) -> some View {
    Button(link.text) { actions.open(link.id) }
      .buttonStyle(.link)
      .multilineTextAlignment(.leading)
      .accessibilityHint("Shows this decision in the panel")
  }

  @ViewBuilder
  private func controls(_ model: DecisionDetailModel, _ decision: Decision) -> some View {
    if presentation.isAnswerable {
      VStack(alignment: .leading, spacing: 8) {
        AnswerControls(
          decision: decision, draft: actions.draft(decision),
          answer: { actions.answer(decision.id, $0) }, send: { actions.send(decision.id) })
        if let failure = presentation.failure {
          Text(failure)
            .font(.callout)
            .foregroundStyle(Ink.secondary)
        }
      }
    } else {
      Text("Your answer to this decision is on its way.")
        .font(.callout)
        .foregroundStyle(Ink.secondary)
    }
  }
}

/// One labelled fact, read by VoiceOver as one element (req-mac-app AC-11.11).
private struct Fact<Value: View>: View {
  let label: String
  @ViewBuilder let value: () -> Value

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(label)
        .foregroundStyle(Ink.secondary)
        .frame(width: 100, alignment: .leading)
      value()
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A settled decision's recorded outcome, with no controls (req-mac-app
/// AC-11.6). A chat message and a note read as plain text, word for word.
private struct OutcomeView: View {
  let outcome: DecisionOutcome

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(outcome.summary)
        .fontWeight(.medium)
        .fixedSize(horizontal: false, vertical: true)
      if let time = outcome.time {
        Text(time)
          .font(.callout)
          .foregroundStyle(Ink.secondary)
      }
      if let message = outcome.chatMessage {
        labelled("Your message in chat", message)
      }
      if let note = outcome.note {
        labelled("Note", note)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.06)))
    .accessibilityElement(children: .combine)
  }

  private func labelled(_ label: String, _ text: String) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(label)
        .font(.callout)
        .foregroundStyle(Ink.secondary)
      Text(verbatim: text)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, 4)
  }
}
