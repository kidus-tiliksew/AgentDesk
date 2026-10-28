import AppKit
import SwiftUI

// Offscreen evidence for the popover, the menu bar label, and notifications.
// The harness compiles the shipped `DecisionRow`, `AnswerControls`,
// `AgentsView`, `Ink`, `MenuBarLabel`, `NotificationController`, and
// `NotificationPauseLine` sources and every `AgentDeskKit` source into one
// program, renders them from fixtures, and writes PNGs and `report.txt` to
// the directory named by its first argument. `run.sh` builds and runs it.

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let now = Instant.parse("2026-10-27T12:00:00Z")!
var report: [String] = []

@MainActor
func line(_ text: String) {
  report.append(text)
  print(text)
}

// MARK: Fixtures

func decision(_ fields: [String: Any]) -> Decision {
  var base: [String: Any] = [
    "id": "dec", "topic": "deploy", "title": "Approve?", "body": NSNull(),
    "input_type": "approve_reject", "options": NSNull(), "recommendation": NSNull(),
    "priority": "normal", "interactive": false, "notification_action": NSNull(),
    "deadline": NSNull(), "default": NSNull(), "state": "pending", "answer": NSNull(),
    "note": NSNull(), "answered_at": NSNull(), "answered_via": NSNull(), "chat_message": NSNull(),
    "relayed_by_agent_session_id": NSNull(), "applied_by_default": false, "parent_id": NSNull(),
    "follow_up_ids": [String](), "agent_session_id": NSNull(),
    "created_at": "2026-10-27T11:58:00Z",
  ]
  base.merge(fields) { $1 }
  let data = try! JSONSerialization.data(withJSONObject: base)
  return try! JSONDecoder.agentDesk().decode(Decision.self, from: data)
}

func session(_ fields: [String: Any]) -> AgentSession {
  var base: [String: Any] = [
    "id": "ags", "display_name": "Claude Code · web", "topic": "web", "state": "working",
    "line": "Running tests", "link": NSNull(), "status_at": "2026-10-27T11:59:00Z",
    "last_activity_at": "2026-10-27T11:59:30Z", "stale": false, "ended_at": NSNull(),
    "pending_decision_count": 0,
  ]
  base.merge(fields) { $1 }
  let data = try! JSONSerialization.data(withJSONObject: base)
  return try! JSONDecoder.agentDesk().decode(AgentSession.self, from: data)
}

let agents = [
  session([
    "id": "ags_1", "display_name": "Claude Code · api", "state": "working",
    "line": "Running the migration tests", "link": "https://example.com/a",
  ]),
  session([
    "id": "ags_2", "display_name": "Codex · web", "state": "blocked",
    "line": "Needs a decision on the release",
  ]),
  session([
    "id": "ags_3", "display_name": "Cursor · docs", "state": "waiting", "stale": true,
    "last_activity_at": "2026-10-27T11:47:00Z", "line": "Waiting for review",
  ]),
]

let decisions = DecisionOrder.sorted([
  decision([
    "id": "d3", "title": "Which name should the new package use?", "input_type": "free_text",
    "recommendation": ["kind": "text", "text": "agentdesk-core"], "agent_session_id": "ags_gone",
    "created_at": "2026-10-27T09:00:00Z",
  ]),
  decision([
    "id": "d2", "title": "Delete the stale preview databases?", "agent_session_id": "ags_1",
    "deadline": "2026-10-27T14:00:00Z", "created_at": "2026-10-27T10:30:00Z",
  ]),
  decision([
    "id": "d1", "title": "Ship the 2.4 release to production now that the staging soak passed?",
    "priority": "urgent", "deadline": "2026-10-27T12:04:00Z", "agent_session_id": "ags_2",
    "input_type": "single_choice",
    "options": [["id": "a", "label": "Ship now"], ["id": "b", "label": "Wait"]],
    "recommendation": ["kind": "option", "option_id": "a"],
  ]),
])
let seen: Set<String> = ["d2"]
let rows = decisions.map { DecisionRowModel(decision: $0, agents: agents, seen: seen, now: now) }

/// Each decision as the list item `AppState.listItems` builds.
@MainActor
func items(_ list: [Decision], failures: [String: String] = [:]) -> [DecisionListItem] {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "UTC")!
  return list.map { decision in
    DecisionListItem(
      row: DecisionRowModel(decision: decision, agents: agents, seen: seen, now: now),
      decision: decision,
      agentLink: DecisionPresentation.agentLink(for: decision, agents: agents),
      defaultSentence: DecisionPresentation.defaultSentence(
        for: decision, now: now, calendar: calendar, locale: Locale(identifier: "en_US")),
      failure: failures[decision.id])
  }
}

// One decision per input type, each with a Markdown body, to render
// expanded (component-mac-app §Rows).
let expandable: [(String, Decision)] = [
  (
    "approve-reject",
    decision([
      "id": "e1", "title": "Delete the stale preview databases?", "agent_session_id": "ags_1",
      "body": "Seven previews have had **no traffic** for 30 days.\nThe newest is `pr-412`.",
      "recommendation": ["kind": "approve"], "deadline": "2026-10-27T14:00:00Z",
      "default": ["kind": "reject"],
    ])
  ),
  (
    "single-choice",
    decision([
      "id": "e2", "title": "Ship the 2.4 release now?", "input_type": "single_choice",
      "agent_session_id": "ags_2", "body": "Staging soaked for *24 hours* without errors.",
      "options": [["id": "a", "label": "Ship now"], ["id": "b", "label": "Wait for Monday"]],
      "recommendation": ["kind": "option", "option_id": "a"],
    ])
  ),
  (
    "multiple-choice",
    decision([
      "id": "e3", "title": "Which regions get the canary?", "input_type": "multiple_choice",
      "agent_session_id": "ags_1", "body": "Pick one or more.",
      "options": [
        ["id": "eu", "label": "Europe"], ["id": "us", "label": "United States"],
        ["id": "ap", "label": "Asia Pacific"],
      ],
      "recommendation": ["kind": "options", "option_ids": ["eu", "us"]],
    ])
  ),
  (
    "free-text",
    decision([
      "id": "e4", "title": "Which name should the new package use?", "input_type": "free_text",
      "agent_session_id": "ags_1", "body": "It replaces `agentdesk-utils`.",
      "recommendation": ["kind": "text", "text": "agentdesk-core"],
    ])
  ),
  (
    "single-choice-or-text",
    decision([
      "id": "e5", "title": "When should the migration run?", "input_type": "single_choice_or_text",
      "agent_session_id": "ags_1", "body": "It locks the `events` table for about a minute.",
      "options": [["id": "now", "label": "Now"], ["id": "night", "label": "Tonight at 02:00"]],
      "recommendation": ["kind": "option", "option_id": "night"],
      "deadline": "2026-10-27T13:00:00Z", "default": ["kind": "option", "option_id": "night"],
    ])
  ),
]

// MARK: Views

/// The signed-in popover's body below the header, built from the shipped
/// list, row, empty-state, and agents views. The header and menu need the
/// app's `AppState`, so the header here is a static copy of its text.
struct PopoverFixture: View {
  let items: [DecisionListItem]
  @State var expanded: Bool
  var selectedID: String? = nil
  var expandedID: String? = nil
  var undoText: String? = nil
  var outcome: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("AgentDesk").font(.headline)
        Text("\(items.count) waiting").font(.callout).foregroundStyle(Ink.secondary)
        Spacer()
        Image(systemName: "ellipsis")
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      Divider()
      AnswerStrips(outcome: outcome, undoText: undoText)
      if items.isEmpty {
        EmptyDecisions()
      } else {
        DecisionList(
          items: items, selectedID: selectedID, expandedID: expandedID,
          maxHeight: expanded ? 470 - AgentsView.maxListHeight : 470)
      }
      Divider()
      AgentsView(agents: agents, now: now, expanded: $expanded)
    }
    .frame(width: 340)
  }
}

let swatchNames = [
  "title (.primary)", "Ink.secondary", "Ink.tertiary", "Ink.red", "system .secondary",
  "system .tertiary", "system red",
]

/// 40 pt swatches, so stroke cores reach the drawn color and antialiasing
/// does not lower the measurement.
struct Swatches: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Title WWWW").font(.system(size: 40, weight: .semibold))
      Text("Ink.secondary WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(Ink.secondary)
      Text("Ink.tertiary WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(Ink.tertiary)
      Text("Ink.red WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(Ink.red)
      Text("system secondary WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(.secondary)
      Text("system tertiary WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(.tertiary)
      Text("system red WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(.red)
    }
    .padding(14)
    .frame(width: 900, alignment: .leading)
  }
}

// MARK: Rendering

enum Background {
  /// `NSVisualEffectView` with the popover material, blending within the
  /// window, as the closest offscreen stand-in for the `NSPopover` window.
  case vibrant
  /// A flat fill of the popover gray, without vibrancy.
  case plain
}

@MainActor
func host<V: View>(_ view: V, appearance: NSAppearance.Name, background: Background) -> (
  NSWindow, NSView
) {
  let hosting = NSHostingView(rootView: view)
  let size = hosting.fittingSize
  let container: NSView
  switch background {
  case .vibrant:
    let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
    effect.material = .popover
    effect.blendingMode = .withinWindow
    effect.state = .active
    container = effect
  case .plain:
    container = NSView(frame: NSRect(origin: .zero, size: size))
    container.wantsLayer = true
    let dark = appearance == .darkAqua
    container.layer?.backgroundColor = NSColor(white: dark ? 0x2E / 255.0 : 0xF3 / 255.0, alpha: 1).cgColor
  }
  hosting.frame = container.bounds
  container.addSubview(hosting)
  let window = NSWindow(
    contentRect: container.frame, styleMask: [.borderless], backing: .buffered, defer: false)
  window.appearance = NSAppearance(named: appearance)
  window.contentView = container
  // The list and agents views measure their content after the first layout
  // and then size their scroll views, as the popover resizes to fit. Lay out until the fitting size stops changing.
  var fitted = size
  for _ in 0..<10 {
    container.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    let next = hosting.fittingSize
    if next == fitted { break }
    fitted = next
    window.setContentSize(next)
    container.frame = NSRect(origin: .zero, size: next)
    hosting.frame = container.bounds
  }
  return (window, container)
}

@MainActor
func snapshot(_ view: NSView) -> NSBitmapImageRep {
  view.layoutSubtreeIfNeeded()
  view.display()
  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
  view.cacheDisplay(in: view.bounds, to: rep)
  return rep
}

func save(_ rep: NSBitmapImageRep, _ name: String) {
  try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}

// MARK: Contrast (WCAG 2.x relative luminance)

func luminance(_ color: NSColor) -> Double {
  let c = color.usingColorSpace(.sRGB)!
  func linear(_ v: CGFloat) -> Double {
    let v = Double(v)
    return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(c.redComponent) + 0.7152 * linear(c.greenComponent) + 0.0722
    * linear(c.blueComponent)
}

func contrast(_ a: NSColor, _ b: NSColor) -> Double {
  let (x, y) = (luminance(a), luminance(b))
  return (max(x, y) + 0.05) / (min(x, y) + 0.05)
}

func hex(_ color: NSColor) -> String {
  let c = color.usingColorSpace(.sRGB)!
  return String(
    format: "#%02X%02X%02X", Int((c.redComponent * 255).rounded()),
    Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
}

/// For each swatch line: the background pixel and the pixel with the
/// highest contrast against it, which is the text's drawn color.
func measure(_ rep: NSBitmapImageRep) -> [(ratio: Double, text: NSColor, background: NSColor)] {
  let background = rep.colorAt(x: 2, y: 2)!
  var bands: [(Int, Int)] = []
  var inBand = false
  var start = 0
  for y in 0..<rep.pixelsHigh {
    var ink = false
    for x in 14..<(rep.pixelsWide - 4) where contrast(rep.colorAt(x: x, y: y)!, background) > 1.3 {
      ink = true
      break
    }
    if ink, !inBand {
      inBand = true
      start = y
    }
    if !ink, inBand {
      inBand = false
      bands.append((start, y))
    }
  }
  return bands.map { band in
    var best = background
    var bestRatio = 1.0
    for y in band.0..<band.1 {
      for x in 14..<(rep.pixelsWide - 4) {
        let color = rep.colorAt(x: x, y: y)!
        let ratio = contrast(color, background)
        if ratio > bestRatio {
          bestRatio = ratio
          best = color
        }
      }
    }
    return (bestRatio, best, background)
  }
}

// MARK: Run

MainActor.assumeIsolated {
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.prohibited)
  var failures: [String] = []

  line("# AgentDesk Mac evidence harness")
  line("fixture clock: 2026-10-27T12:00:00Z")
  line("")

  // Popover layouts.
  line("## Popover layouts")
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    let listed = items(decisions)
    let held = decisions.first { $0.id == "d2" }!
    var scenes: [(String, PopoverFixture)] = [
      ("popover-agents-expanded", PopoverFixture(items: listed, expanded: true)),
      ("popover-agents-collapsed", PopoverFixture(items: listed, expanded: false)),
      ("popover-empty", PopoverFixture(items: [], expanded: false)),
      // The held answer's row has left the list; the strip offers Undo.
      (
        "popover-undo",
        PopoverFixture(
          items: items(decisions.filter { $0.id != "d2" }), expanded: false,
          undoText: DecisionPresentation.undoText(.approve, decision: held))
      ),
      // A 409: the recorded outcome replaces the attempted answer.
      (
        "popover-conflict",
        PopoverFixture(
          items: items(decisions.filter { $0.id != "d2" }), expanded: false,
          outcome: DecisionPresentation.recordedOutcome(
            decision([
              "id": "d2", "state": "answered", "answer": ["kind": "reject"], "answered_via": "chat",
              "chat_message": "not yet",
            ])))
      ),
      // A transport failure: the row is back with the retry message.
      (
        "popover-send-failed",
        PopoverFixture(
          items: items(decisions, failures: ["d2": PendingAnswers.failureMessage]), expanded: false,
          selectedID: "d2")
      ),
    ]
    for (type, expandedDecision) in expandable {
      scenes.append(
        (
          "popover-expanded-\(type)",
          PopoverFixture(
            items: items([expandedDecision] + decisions), expanded: false,
            selectedID: expandedDecision.id, expandedID: expandedDecision.id)
        ))
    }
    for (name, view) in scenes {
      let (window, container) = host(view, appearance: appearance, background: .vibrant)
      let rep = snapshot(container)
      save(rep, "\(name)-\(mode).png")
      line("\(name)-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
      if container.bounds.width != 340 || container.bounds.height > 560 {
        failures.append("\(name)-\(mode) exceeds 340 x 560 pt")
      }
      _ = window
    }
  }
  line("")

  // Row text and the accessibility value each row exposes.
  line("## Rows (DecisionRowModel, as DecisionRow draws and labels them)")
  for row in rows {
    line(
      "- \(row.id): title weight \(row.isNew ? "semibold" : "medium"); time left \(row.timeLeft ?? "none")\(row.timeLeftIsRed ? " (red)" : "")")
    line("  accessibility label: \(row.accessibilityLabel)")
    line("  accessibility value: \(row.accessibilityValue)")
  }
  line("")

  // The expanded rows' drafts: the same AnswerDraft the controls bind to
  // builds the answer Send and ⌘↩ submit.
  line("## Expanded rows (AnswerDraft as the controls start, untouched)")
  for (type, expandedDecision) in expandable {
    let draft = AnswerDraft(decision: expandedDecision)
    let item = items([expandedDecision])[0]
    let answer = draft.submission.map { DecisionPresentation.answerText($0.answer, options: expandedDecision.options) }
    line("- \(type): Send and ⌘↩ submit \(answer ?? "nothing")")
    line("  default sentence: \(item.defaultSentence ?? "none")")
    line("  agent page: \(item.agentLink?.absoluteString ?? "none")")
    let suggested = draft.options.filter { draft.isSuggested($0.id) }.map(\.label)
    if !suggested.isEmpty { line("  labelled Suggested: \(suggested.joined(separator: ", "))") }
    if let text = draft.suggestedText { line("  text placeholder: \(text)") }
    if expandedDecision.inputType == .approveReject {
      line(
        "  buttons: Reject\(draft.isSuggested(.reject) ? " (accent, hint \"Suggested by the agent\")" : ""), Approve\(draft.isSuggested(.approve) ? " (accent, hint \"Suggested by the agent\")" : "")")
    }
  }
  line("")
  line("## Strips")
  line("undo: \(DecisionPresentation.undoText(.approve, decision: decisions.first { $0.id == "d2" }!)) [Undo]")
  line(
    "conflict: \(DecisionPresentation.recordedOutcome(decision(["state": "answered", "answer": ["kind": "reject"], "answered_via": "chat", "chat_message": "not yet"])) ?? "")")
  line("conflict, outcome unread: \(PendingAnswers.unreadOutcome)")
  line("send failed, under the row: \(PendingAnswers.failureMessage)")
  line("")
  let summary = AgentsSummary(agents: agents)
  line("agents line: \(summary.runningText)\(summary.blockedText ?? "")")
  for session in AgentSessionOrder.sorted(agents) {
    let entry = AgentEntryModel(session: session, now: now)
    line("  entry: \(entry.accessibilityLabel)\(entry.link.map { " -> opens \($0.absoluteString)" } ?? "")")
  }
  line("")

  // Contrast, rendered.
  line("## Contrast, rendered (40 pt swatches; strongest text pixel against the background)")
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    for background in [Background.vibrant, .plain] {
      let (window, container) = host(Swatches(), appearance: appearance, background: background)
      let rep = snapshot(container)
      let label = "\(mode)-\(background == .vibrant ? "vibrant" : "plain")"
      save(rep, "contrast-\(label).png")
      line("### \(label)")
      for (name, measured) in zip(swatchNames, measure(rep)) {
        line(
          String(
            format: "%-18@ %5.2f:1  text %@ on %@", name as NSString, measured.ratio,
            hex(measured.text) as NSString, hex(measured.background) as NSString))
        if name.hasPrefix("Ink") || name.hasPrefix("title"), measured.ratio < 4.5 {
          failures.append("\(name) \(label) is \(measured.ratio):1")
        }
      }
      _ = window
    }
  }
  line("")

  // Contrast, computed for every shipped Ink value, including Increase
  // Contrast, against the rendered popover backgrounds and pure white and
  // black.
  line("## Contrast, computed from the shipped Ink values")
  let light = [NSColor(white: 0xF3 / 255.0, alpha: 1), .white]
  let dark = [NSColor(white: 0x2E / 255.0, alpha: 1), NSColor(white: 0x3C / 255.0, alpha: 1), .black]
  for (name, shades) in [
    ("secondary", Ink.secondaryShades), ("tertiary", Ink.tertiaryShades), ("red", Ink.redShades),
  ] {
    for (variant, color, backgrounds) in [
      ("light", shades.light, light), ("dark", shades.dark, dark),
      ("light Increase Contrast", shades.lightHigh, light),
      ("dark Increase Contrast", shades.darkHigh, dark),
    ] {
      let worst = backgrounds.map { contrast(color, $0) }.min()!
      line(String(format: "Ink.%@ %@ %@: worst %.2f:1", name, variant, hex(color), worst))
      if worst < 4.5 { failures.append("Ink.\(name) \(variant) is \(worst):1") }
    }
  }
  let highContrast = NSAppearance(named: .accessibilityHighContrastAqua)
  line(
    "NSAppearance(named: .accessibilityHighContrastAqua) offscreen: \(highContrast?.name.rawValue ?? "nil"); Increase Contrast is not rendered offscreen, so its values are computed only")
  line("")

  // Menu bar label: every image is a template; AppKit tints it.
  line("## Menu bar label images")
  let cases: [(String, NSImage)] = [
    ("glyph", PromptGlyph.image(dotOpacity: 0, description: "AgentDesk, 0 waiting")),
    ("dot-frame-3of7", PromptGlyph.image(dotOpacity: 3.0 / 7, description: "AgentDesk, 1 waiting, new")),
    ("dot", PromptGlyph.image(dotOpacity: 1, description: "AgentDesk, 3 waiting, new, urgent")),
    ("count-3", PromptGlyph.image(count: 3, description: "AgentDesk, 3 waiting")),
    ("count-12", PromptGlyph.image(count: 12, description: "AgentDesk, 12 waiting")),
  ]
  for (name, image) in cases {
    line(
      "\(name): template=\(image.isTemplate) size=\(Int(image.size.width))x\(Int(image.size.height)) pt description=\"\(image.accessibilityDescription ?? "")\"")
    if !image.isTemplate { failures.append("\(name) is not a template image") }
    for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
      let scale: CGFloat = 4
      let view = NSImageView(
        frame: NSRect(x: 8, y: 8, width: image.size.width * scale, height: image.size.height * scale))
      view.image = image
      view.imageScaling = .scaleProportionallyUpOrDown
      view.contentTintColor = .labelColor
      let box = NSView(frame: NSRect(x: 0, y: 0, width: view.frame.width + 16, height: view.frame.height + 16))
      box.wantsLayer = true
      box.layer?.backgroundColor = NSColor(white: mode == "light" ? 0.93 : 0.16, alpha: 1).cgColor
      box.addSubview(view)
      let window = NSWindow(contentRect: box.frame, styleMask: [.borderless], backing: .buffered, defer: false)
      window.appearance = NSAppearance(named: appearance)
      window.contentView = box
      save(snapshot(box), "label-\(name)-\(mode).png")
    }
  }
  line("")

  // Dot timeline: the same DotPresence and frames AppState drives.
  line("## Dot timeline (DotPresence decides; fade frames are PromptGlyph images)")
  let seenBefore: Set<String> = ["d1", "d2", "d3"]
  let calm = decisions.filter { $0.id == "d2" }
  let arrived = calm + [decision(["id": "d9", "title": "New question", "created_at": "2026-10-27T11:59:00Z"])]
  @MainActor func step(_ presence: inout DotPresence, _ label: String, _ list: [Decision], _ seenIDs: Set<String>, reduceMotion: Bool) {
    let show = Attention.dot(list, seen: seenIDs, now: now)
    let change = presence.update(show: show, reduceMotion: reduceMotion)
    let frames: String
    switch change {
    case .fadeIn: frames = (1...7).map { String(format: "%.2f", Double($0) / 7) }.joined(separator: " ")
    case .appear: frames = "1.00 at once"
    case .hide: frames = "0.00 at once"
    case .none: frames = "no redraw"
    }
    line("\(label): dot=\(show) change=\(change) opacity: \(frames)")
  }
  var motion = DotPresence()
  step(&motion, "read 1, only seen calm decisions", calm, seenBefore, reduceMotion: false)
  step(&motion, "read 2, a new decision arrives", arrived, seenBefore, reduceMotion: false)
  step(&motion, "read 3, same decisions refreshed", arrived, seenBefore, reduceMotion: false)
  step(&motion, "read 4, same decisions refreshed", arrived, seenBefore, reduceMotion: false)
  step(&motion, "popover closes, new decision marked seen", arrived, seenBefore.union(["d9"]), reduceMotion: false)
  var reduced = DotPresence()
  step(&reduced, "Reduce Motion, a new decision arrives", arrived, seenBefore, reduceMotion: true)
  step(&reduced, "Reduce Motion, refreshed", arrived, seenBefore, reduceMotion: true)
  let strip = NSImage(size: NSSize(width: 18 * 8 + 4 * 7, height: 18), flipped: false) { _ in
    for frame in 0...7 {
      PromptGlyph.image(dotOpacity: Double(frame) / 7, description: "").draw(
        in: NSRect(x: CGFloat(frame) * 22, y: 0, width: 18, height: 18))
    }
    return true
  }
  let stripView = NSImageView(frame: NSRect(x: 8, y: 8, width: strip.size.width * 4, height: 72))
  stripView.image = strip
  stripView.imageScaling = .scaleProportionallyUpOrDown
  let stripBox = NSView(frame: NSRect(x: 0, y: 0, width: stripView.frame.width + 16, height: 88))
  stripBox.wantsLayer = true
  stripBox.layer?.backgroundColor = NSColor(white: 0.93, alpha: 1).cgColor
  stripBox.addSubview(stripView)
  let stripWindow = NSWindow(contentRect: stripBox.frame, styleMask: [.borderless], backing: .buffered, defer: false)
  stripWindow.contentView = stripBox
  save(snapshot(stripBox), "label-dot-fade-frames.png")
  line("label-dot-fade-frames.png: opacity 0/7 to 7/7 over 0.35 s")
  line("")

  // The pause line under the header.
  line("## Paused header (NotificationPauseLine)")
  let pauseEnd = Instant.parse("2026-10-27T13:00:00Z")!
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    let (window, container) = host(
      PausedHeaderFixture(end: pauseEnd, now: now), appearance: appearance, background: .vibrant)
    save(snapshot(container), "popover-paused-header-\(mode).png")
    line("popover-paused-header-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
    _ = window
  }
  line("text: \(NotificationPauseLine.text(end: pauseEnd, now: now)) (Ink.secondary, measured above)")
  line("text on another day: \(NotificationPauseLine.text(end: pauseEnd.addingTimeInterval(86_400), now: now))")
  line("")

  notificationEvidence(&failures)

  line("## Not available in this harness")
  line("AXIsProcessTrusted=\(AXIsProcessTrusted()): live VoiceOver output and the live NSPopover open and close are not captured; row accessibility strings above come from DecisionRowModel, which DecisionRow applies as its summary element's label and value, with Reject, Approve, and the expanded controls as separate elements.")
  line("Keys are not captured: the popover's key monitor needs the live popover window as key window. PopoverKeysTests covers the key-to-action mapping; Escape with no row expanded closes the popover.")
  line("Live notifications are not captured: UNUserNotificationCenter needs the app bundle and the user's permission. The permission prompt, a delivered banner, a click opening the popover, the Reject and Approve buttons, and removal from Notification Center are checked on a Mac before each release; the content, category, and Notifier timeline above use the shipped code with a fixture center.")
  line("")

  if failures.isEmpty {
    line("RESULT: PASS")
  } else {
    line("RESULT: FAIL")
    for failure in failures { line("  \(failure)") }
  }
  try! report.joined(separator: "\n").appending("\n").write(
    to: out.appendingPathComponent("report.txt"), atomically: true, encoding: .utf8)
  exit(failures.isEmpty ? 0 : 1)
}
