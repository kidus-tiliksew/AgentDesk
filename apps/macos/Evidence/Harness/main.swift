import AppKit
import SwiftUI

// Offscreen evidence for the popover, the menu bar label, and notifications.
// The harness compiles the shipped `DecisionRow`, `AnswerControls`,
// `DecisionDetailView`, `AgentDetailView`, `DetailPanelWindow`,
// `PopoverKeyObserver`, `AgentsView`,
// `ScrollSupport`, `Ink`, `MenuBarLabel`, `NotificationController`, and
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

let agentsFixture = [
  session([
    "id": "ags_1", "display_name": "Claude Code · api", "topic": "api", "state": "working",
    "line": "Running the migration tests", "link": "https://example.com/a",
  ]),
  session([
    "id": "ags_2", "display_name": "Codex · web", "topic": "web", "state": "blocked",
    "line": "Needs a decision on the release",
  ]),
  session([
    "id": "ags_3", "display_name": "Cursor · docs", "topic": "docs", "state": "waiting", "stale": true,
    "last_activity_at": "2026-10-27T11:47:00Z", "line": "Waiting for review",
  ]),
]

let agents = agentsFixture

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

// Live sessions in every group: blocked (one of them stale), active, and
// quiet for minutes, hours, and days, with default, nested, and custom names.
let groupedAgents = [
  session([
    "id": "g_a1", "display_name": "Claude Code · api/migrations", "topic": "api/migrations", "state": "working",
    "line": "Running the migration tests", "last_activity_at": "2026-10-27T11:59:30Z",
  ]),
  session([
    "id": "g_q1", "display_name": "Codex · billing", "topic": "billing", "state": "working", "stale": true,
    "line": "Reading the invoice tests", "last_activity_at": "2026-10-25T09:00:00Z",
  ]),
  session([
    "id": "g_b1", "display_name": "Codex · web", "topic": "web", "state": "blocked",
    "line": "Needs a decision on the release", "last_activity_at": "2026-10-27T11:58:00Z",
  ]),
  session([
    "id": "g_q2", "display_name": "Cursor · docs", "topic": "docs", "state": "waiting", "stale": true,
    "line": "Waiting for review", "last_activity_at": "2026-10-27T11:16:00Z",
  ]),
  session([
    "id": "g_a2", "display_name": "Release captain", "topic": "web", "state": "waiting",
    "line": "Waiting on the build", "last_activity_at": "2026-10-27T11:59:00Z",
  ]),
  session([
    "id": "g_b2", "display_name": "Claude Code · infra", "topic": "infra", "state": "blocked", "stale": true,
    "line": "Blocked on a credential", "last_activity_at": "2026-10-27T10:00:00Z",
  ]),
  session([
    "id": "g_q3", "display_name": "OpenCode · search", "topic": "search", "state": "working", "stale": true,
    "line": "Reindexing", "last_activity_at": "2026-10-27T08:30:00Z",
  ]),
]

// Every state an entry draws, with default, nested, custom, and long names,
// more than the agents list's 160 pt holds (component-mac-app §Agents line).
let stateAgents = [
  session([
    "id": "s_work", "display_name": "Claude Code · api/migrations", "topic": "api/migrations",
    "state": "working", "line": "Running the migration tests",
  ]),
  session([
    "id": "s_wait", "display_name": "Release captain", "topic": "web", "state": "waiting",
    "line": "Waiting on the build",
  ]),
  session([
    "id": "s_block", "display_name": "Codex · web", "topic": "web", "state": "blocked",
    "line": "Needs a decision on the release",
  ]),
  session([
    "id": "s_blockstale", "display_name": "Claude Code · infra/secrets", "topic": "infra/secrets",
    "state": "blocked", "stale": true, "line": "Blocked on a credential",
    "last_activity_at": "2026-10-27T10:00:00Z",
  ]),
  session([
    "id": "s_done", "display_name": "Cursor · docs", "topic": "docs", "state": "done",
    "line": "Published the guide",
  ]),
  session([
    "id": "s_none", "display_name": "OpenCode · search", "topic": "search", "state": NSNull(),
    "line": NSNull(),
  ]),
  session([
    "id": "s_longcustom",
    "display_name": "Nightly dependency upgrade and regression triage across every service",
    "topic": "web", "state": "working", "line": "Reading the changelogs",
  ]),
  session([
    "id": "s_longtopic",
    "display_name": "Claude Code · platform/a-final-topic-segment-long-enough-to-truncate-at-its-tail",
    "topic": "platform/a-final-topic-segment-long-enough-to-truncate-at-its-tail",
    "state": "waiting", "line": "Waiting on the review",
  ]),
  session([
    "id": "s_quiet1", "display_name": "Codex · billing", "topic": "billing", "state": "working",
    "stale": true, "line": "Reading the invoice tests", "last_activity_at": "2026-10-27T11:16:00Z",
  ]),
  session([
    "id": "s_quiet2", "display_name": "Cursor · reviews", "topic": "reviews", "state": "waiting",
    "stale": true, "line": "Waiting for review", "last_activity_at": "2026-10-27T08:30:00Z",
  ]),
  session([
    "id": "s_quiet3", "display_name": "Claude Code · release", "topic": "release", "state": "done",
    "stale": true, "line": "Tagged the build", "last_activity_at": "2026-10-25T09:00:00Z",
  ]),
]

// The live review's shape: 18 sessions, most of them quiet.
let manyAgents: [AgentSession] = (1...18).map { index in
  var fields: [String: Any] = ["id": "m\(index)", "state": "working"]
  if index % 5 == 0 {
    fields["display_name"] = "Agent \(index) · active"
    fields["line"] = "Working on item \(index)"
  } else {
    fields["display_name"] = "Agent \(index) · quiet"
    fields["line"] = "Last status of item \(index)"
    fields["stale"] = true
    // 25 minutes apart, so the list reaches hours.
    fields["last_activity_at"] = String(
      format: "2026-10-27T%02d:%02d:00Z", (12 * 60 - index * 25) / 60, (12 * 60 - index * 25) % 60)
  }
  return session(fields)
}

// Each marker a row can carry, with titles that fill the two lines.
let markerDecisions = DecisionOrder.sorted([
  decision([
    "id": "k1", "title": "Roll back the payments deploy now that the error rate has passed the alert threshold?",
    "priority": "urgent", "deadline": "2026-10-27T15:00:00Z", "agent_session_id": "ags_2",
    "recommendation": ["kind": "reject"],
  ]),
  decision([
    "id": "k2", "title": "Rotate the signing key today?", "priority": "urgent",
    "agent_session_id": "ags_1", "recommendation": ["kind": "approve"],
  ]),
  decision([
    "id": "k3", "title": "Run the vacuum on the events table during the maintenance window tonight or wait?",
    "deadline": "2026-10-27T12:03:00Z", "agent_session_id": "ags_1",
    "input_type": "single_choice",
    "options": [["id": "t", "label": "Tonight"], ["id": "w", "label": "Wait"]],
    "recommendation": ["kind": "option", "option_id": "t"],
  ]),
  decision([
    "id": "k4", "title": "Delete the stale preview databases?", "deadline": "2026-10-27T14:00:00Z",
    "agent_session_id": "ags_1", "recommendation": ["kind": "approve"],
  ]),
  decision([
    "id": "k5", "title": "Which name should the new package use?", "input_type": "free_text",
    "agent_session_id": "ags_3", "recommendation": ["kind": "text", "text": "agentdesk-core"],
  ]),
])
/// k2 and k4 are seen; the others are new.
let markerSeen: Set<String> = ["k2", "k4"]

// Enough rows, all with two-line titles, to overflow the list.
let overflowDecisions = DecisionOrder.sorted(
  [
    decision([
      "id": "o0", "title": "Ship the 2.4 release to production now that the staging soak passed without errors?",
      "priority": "urgent", "deadline": "2026-10-27T12:04:00Z", "agent_session_id": "ags_2",
    ])
  ]
    + (1...17).map { index in
      decision([
        "id": "o\(index)",
        "title": "Decision \(index): apply the proposed change to the staging environment and report back?",
        "agent_session_id": "ags_1", "created_at": "2026-10-27T1\(index % 2):0\(index % 6):00Z",
      ])
    })

let rows = decisions.map { DecisionRowModel(decision: $0, agents: agents, seen: seen, now: now) }

/// Each decision as the list item `AppState.listItems` builds.
@MainActor
func items(
  _ list: [Decision], failures: [String: String] = [:], seen: Set<String> = seen
) -> [DecisionListItem] {
  list.map { decision in
    DecisionListItem(
      row: DecisionRowModel(decision: decision, agents: agents, seen: seen, now: now),
      decision: decision,
      failure: failures[decision.id])
  }
}

// One decision per input type, each with a Markdown body, to render in the
// detail panel (component-mac-app §Detail panel).
let panelDecisions: [(String, Decision)] = [
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

/// The signed-in popover's body, built from the shipped list, row,
/// empty-state, and agents views with the height budget `SignedInView` uses.
/// The header and menu need the app's `AppState`, so the header here is a
/// static copy of its text.
struct PopoverFixture: View {
  let items: [DecisionListItem]
  @State var expanded: Bool
  var agents: [AgentSession] = agentsFixture
  @State var quietRevealed = false
  var selectedID: String? = nil
  var shownID: String? = nil
  var undoText: String? = nil
  var outcome: String? = nil
  var shownAgentID: String? = nil
  @State private var headerHeight: CGFloat = 0
  @State private var stripsHeight: CGFloat = 0
  @State private var agentsHeight: CGFloat = 0

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
      .measuredHeight($headerHeight)
      Divider()
      AnswerStrips(outcome: outcome, undoText: undoText)
        .measuredHeight($stripsHeight)
      if items.isEmpty {
        EmptyDecisions()
      } else {
        DecisionList(
          items: items, selectedID: selectedID, shownID: shownID,
          maxHeight: CGFloat(
            PopoverLayout.listMaxHeight(chromeHeight: Double(headerHeight + stripsHeight + agentsHeight + 2))))
      }
      Divider()
      AgentsView(
        agents: agents, now: now, expanded: $expanded, quietRevealed: $quietRevealed, shownID: shownAgentID
      )
      .measuredHeight($agentsHeight)
    }
    .frame(width: 340)
    .frame(maxHeight: CGFloat(PopoverLayout.maxHeight), alignment: .top)
  }
}

/// The contrast floor each ink is gated at: 3:1 for the non-text dot inks, whose
/// state also reads as text, and 4.5:1 for text (component-mac-app §Keyboard
/// and accessibility).
let dotInkFloor = 3.0
let textInkFloor = 4.5
let dotInkSwatches: Set<String> = ["Ink.green", "Ink.amber", "Ink.indigo"]

let swatchNames = [
  "title (.primary)", "Ink.secondary", "Ink.tertiary", "Ink.red", "Ink.green", "Ink.amber", "Ink.indigo",
  "system .secondary", "system .tertiary", "system red",
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
      // The app fills only 6 pt dots with these. Text here only reaches a
      // stroke core wide enough to measure the drawn color.
      Text("Ink.green WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(Ink.green)
      Text("Ink.amber WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(Ink.amber)
      Text("Ink.indigo WWWW").font(.system(size: 40, weight: .heavy)).foregroundStyle(Ink.indigo)
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

// MARK: Row and entry layout

/// Hosts one view on the flat background and returns its size and pixels.
@MainActor
func flatRender<V: View>(_ view: V, _ appearance: NSAppearance.Name) -> (size: CGSize, rep: NSBitmapImageRep) {
  let (window, container) = host(view, appearance: appearance, background: .plain)
  let rep = snapshot(container)
  _ = window
  return (container.bounds.size, rep)
}

/// The bounding box, in points, of the saturated pixels, which are the only
/// pixels a dot color draws: gray text and gray backgrounds have none. Also
/// the strongest such pixel, for its hue.
@MainActor
func coloredBox(_ rendered: (size: CGSize, rep: NSBitmapImageRep)) -> (box: CGRect, color: NSColor)? {
  let rep = rendered.rep
  let scale = CGFloat(rep.pixelsWide) / rendered.size.width
  var (minX, minY, maxX, maxY) = (Int.max, Int.max, -1, -1)
  var strongest: (spread: CGFloat, color: NSColor)?
  for y in 0..<rep.pixelsHigh {
    for x in 0..<rep.pixelsWide {
      guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
      let parts = [color.redComponent, color.greenComponent, color.blueComponent]
      let spread = parts.max()! - parts.min()!
      guard spread > 0.15 else { continue }
      (minX, minY, maxX, maxY) = (min(minX, x), min(minY, y), max(maxX, x), max(maxY, y))
      if spread > (strongest?.spread ?? 0) { strongest = (spread, color) }
    }
  }
  guard let strongest else { return nil }
  return (
    CGRect(
      x: CGFloat(minX) / scale, y: CGFloat(minY) / scale, width: CGFloat(maxX - minX + 1) / scale,
      height: CGFloat(maxY - minY + 1) / scale), strongest.color
  )
}

/// The leftmost column at or after `from` points holding text ink, in points.
@MainActor
func firstInk(_ rendered: (size: CGSize, rep: NSBitmapImageRep), from: CGFloat) -> CGFloat? {
  let rep = rendered.rep
  let scale = CGFloat(rep.pixelsWide) / rendered.size.width
  let background = rep.colorAt(x: 0, y: 0)!
  for x in Int(from * scale)..<rep.pixelsWide {
    for y in 0..<rep.pixelsHigh where contrast(rep.colorAt(x: x, y: y)!, background) > 1.5 {
      return CGFloat(x) / scale
    }
  }
  return nil
}

/// Whether two renders of one size have the same pixels from `from` points to
/// the right edge, and whether that region holds ink.
@MainActor
func sameRightRegion(
  _ a: (size: CGSize, rep: NSBitmapImageRep), _ b: (size: CGSize, rep: NSBitmapImageRep), from: CGFloat
) -> (same: Bool, ink: Bool) {
  let scale = CGFloat(a.rep.pixelsWide) / a.size.width
  let background = a.rep.colorAt(x: 0, y: 0)!
  var ink = false
  for y in 0..<min(a.rep.pixelsHigh, b.rep.pixelsHigh) {
    for x in Int(from * scale)..<a.rep.pixelsWide {
      let (p, q) = (a.rep.colorAt(x: x, y: y)!, b.rep.colorAt(x: x, y: y)!)
      if hex(p) != hex(q) { return (false, ink) }
      if contrast(p, background) > 1.5 { ink = true }
    }
  }
  return (true, ink)
}

/// Measures the shipped row and entry against component-mac-app §Rows and
/// §Agents line: padding, spacing, dots, one line, and what color touches.
@MainActor
func layoutEvidence(_ failures: inout [String]) {
  line("## Row and entry layout (rendered from the shipped DecisionRow and AgentEntry on a flat fill)")
  func expect(_ name: String, _ passed: Bool) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("layout: \(name)") }
  }
  func near(_ a: CGFloat, _ b: CGFloat, _ tolerance: CGFloat = 1) -> Bool { abs(a - b) <= tolerance }

  let rowDecision = decision([
    "id": "l1", "title": "Which name should the new package use?", "input_type": "free_text",
    "agent_session_id": "ags_1",
  ])
  func rowView(seen: Set<String>) -> some View {
    DecisionRow(
      item: items([rowDecision], seen: seen)[0], isSelected: false, isShown: false,
      actions: DecisionListActions()
    )
    .frame(width: 340)
  }
  func textHeight(_ font: Font) -> CGFloat {
    NSHostingView(rootView: Text("Agy").font(font).lineLimit(1)).fittingSize.height
  }
  let titleHeight = textHeight(.system(size: 13, weight: .medium))
  let calloutHeight = textHeight(.callout)
  let nameHeight = textHeight(.system(size: 13))

  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    let new = flatRender(rowView(seen: []), appearance)
    let old = flatRender(rowView(seen: ["l1"]), appearance)
    line(String(format: "%@ row: %.1f pt tall; title line %.1f pt, secondary line %.1f pt", mode, new.size.height, titleHeight, calloutHeight))
    expect("\(mode) row: 13 pt above and below and 4 pt between the lines", near(new.size.height, titleHeight + calloutHeight + 30))
    expect("\(mode) row: the seen row has the same height", new.size.height == old.size.height)
    expect("\(mode) row: a seen row draws no color", coloredBox(old) == nil)
    if let dot = coloredBox(new) {
      line(String(format: "%@ new row dot: x %.1f, y %.1f, %.1f x %.1f pt, color %@", mode, dot.box.minX, dot.box.minY, dot.box.width, dot.box.height, hex(dot.color)))
      expect("\(mode) row: the only color is a 6 pt dot", near(dot.box.width, 6) && near(dot.box.height, 6))
      expect("\(mode) row: the dot sits in the leading margin", dot.box.maxX < 14)
      expect("\(mode) row: the dot is level with the title's first line", dot.box.minY >= 13 && dot.box.maxY <= 13 + titleHeight)
      expect("\(mode) row: the dot is indigo", dot.color.blueComponent > dot.color.redComponent && dot.color.blueComponent > dot.color.greenComponent)
    } else {
      expect("\(mode) row: a new row draws its dot", false)
    }
    if let newLeft = firstInk(new, from: 12), let oldLeft = firstInk(old, from: 12) {
      line(String(format: "%@ title left edge: new %.1f pt, seen %.1f pt", mode, newLeft, oldLeft))
      expect("\(mode) row: new and seen titles keep one left edge at 14 pt", near(newLeft, oldLeft) && near(oldLeft, 14, 1.5))
    } else {
      expect("\(mode) row: the title draws", false)
    }

    // One entry per dot color, then the neutral ones.
    for (id, expected) in [
      ("s_work", "green"), ("s_wait", "amber"), ("s_block", "red"), ("s_blockstale", "red"),
      ("s_done", "neutral"), ("s_none", "neutral"), ("s_quiet1", "neutral"), ("s_quiet2", "neutral"),
      ("s_quiet3", "neutral"),
    ] {
      let session = stateAgents.first { $0.id == id }!
      let entry = AgentEntryModel(session: session, now: now)
      let rendered = flatRender(AgentEntry(entry: entry).frame(width: 340), appearance)
      let colored = coloredBox(rendered)
      var hue = "neutral"
      if let color = colored?.color {
        let (r, g, b) = (color.redComponent, color.greenComponent, color.blueComponent)
        if g > r && g > b { hue = "green" } else if r > b && g - b > 0.2 { hue = "amber" } else if r > g && r > b { hue = "red" } else { hue = "other" }
      }
      line(String(format: "%@ %@: %@ | %@ | dot %@ | %.1f pt tall | colored box %@", mode, id, entry.shortName, entry.stateText, hue, rendered.size.height, colored.map { String(format: "x %.1f, %.1f x %.1f pt", $0.box.minX, $0.box.width, $0.box.height) } ?? "none"))
      expect("\(mode) \(id): the dot is \(expected)", hue == expected)
      expect("\(mode) \(id): 7 pt above and below one line", near(rendered.size.height, nameHeight + 14))
      if let box = colored?.box {
        expect("\(mode) \(id): color reaches only the 6 pt dot at the leading padding", near(box.width, 6) && near(box.height, 6) && near(box.minX, 14))
      }
    }

    // A long name beside the same state as a short one.
    let short = AgentEntryModel(session: stateAgents.first { $0.id == "s_wait" }!, now: now)
    let long = AgentEntryModel(session: stateAgents.first { $0.id == "s_longtopic" }!, now: now)
    let shortRender = flatRender(AgentEntry(entry: short).frame(width: 340), appearance)
    let longRender = flatRender(AgentEntry(entry: long).frame(width: 340), appearance)
    let stateWidth = NSHostingView(rootView: Text(short.stateText).font(.callout).lineLimit(1)).fittingSize.width
    let region = sameRightRegion(shortRender, longRender, from: 340 - 14 - stateWidth - 1)
    expect("\(mode) entry: a long name keeps one line", shortRender.size.height == longRender.size.height)
    expect("\(mode) entry: a long name leaves the right-aligned state whole", region.same && region.ink)

    let lineHeight = flatRender(
      AgentsView(agents: stateAgents, now: now, expanded: .constant(false), quietRevealed: .constant(false))
        .frame(width: 340), appearance
    ).size.height
    line(String(format: "%@ agents line: %.1f pt tall; text %.1f pt", mode, lineHeight, calloutHeight))
    expect("\(mode) agents line: 12 pt above and 7 pt below", near(lineHeight, calloutHeight + 19))
  }
  line("")
}

// MARK: Run

MainActor.assumeIsolated {
  _ = NSApplication.shared
  ActivationWatch.shared.start()
  // `run.sh` runs this process a second time with only full keyboard access
  // overridden, for the panel's Tab stops and accessibility tree.
  if CommandLine.arguments.contains("--access") {
    exit(accessEvidence())
  }
  NSApp.setActivationPolicy(.prohibited)
  var failures: [String] = []
  // The panel's height check alone, for a run on source without the fix.
  if CommandLine.arguments.contains("--panel-height") {
    panelHeightEvidence(&failures)
    print(failures.isEmpty ? "RESULT: PASS" : "RESULT: FAIL")
    for failure in failures { print("  \(failure)") }
    exit(failures.isEmpty ? 0 : 1)
  }

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
    // Every row marker, and the list and agents lists overflowing.
    scenes.append(
      ("popover-markers", PopoverFixture(items: items(markerDecisions, seen: markerSeen), expanded: false)))
    scenes.append(("popover-overflow", PopoverFixture(items: items(overflowDecisions, seen: []), expanded: false)))
    scenes.append(
      (
        "popover-overflow-undo",
        PopoverFixture(
          items: items(overflowDecisions, seen: []), expanded: false,
          undoText: DecisionPresentation.undoText(.approve, decision: held))
      ))
    scenes.append(
      (
        "popover-agents-line",
        PopoverFixture(items: items(decisions), expanded: false, agents: groupedAgents)
      ))
    scenes.append(
      (
        "popover-agents-quiet-hidden",
        PopoverFixture(items: items(decisions), expanded: true, agents: groupedAgents)
      ))
    scenes.append(
      (
        "popover-agents-quiet-revealed",
        PopoverFixture(items: items(decisions), expanded: true, agents: groupedAgents, quietRevealed: true)
      ))
    // Every state, with default, nested, custom, and long names, from the
    // list's top and from its end.
    scenes.append(
      (
        "popover-agents-states",
        PopoverFixture(items: items(decisions), expanded: true, agents: stateAgents, quietRevealed: true)
      ))
    scenes.append(
      (
        "popover-agents-states-end",
        PopoverFixture(items: items(decisions), expanded: true, agents: stateAgents, quietRevealed: true)
      ))
    scenes.append(
      (
        "popover-agents-overflow",
        PopoverFixture(items: items(overflowDecisions, seen: []), expanded: true, agents: manyAgents, quietRevealed: true)
      ))
    for (name, view) in scenes {
      let (window, container) = host(view, appearance: appearance, background: .vibrant)
      // The agents list holds 160 pt, so the revealed quiet sessions show once
      // it is scrolled to its end.
      if name == "popover-agents-quiet-revealed" || name == "popover-agents-states-end",
        let list = scrollViews(in: container).last
      {
        list.documentView?.scroll(NSPoint(x: 0, y: list.documentView?.bounds.height ?? 0))
        list.reflectScrolledClipView(list.contentView)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
      }
      let rep = snapshot(container)
      save(rep, "\(name)-\(mode).png")
      line("\(name)-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
      if container.bounds.width != 340 || container.bounds.height > 560 {
        failures.append("\(name)-\(mode) exceeds 340 x 560 pt")
      }
      _ = window
    }
    // Every entry at once, without the list's 160 pt limit.
    let (entriesWindow, entriesContainer) = host(
      VStack(spacing: 0) {
        ForEach(AgentSessionOrder.listed(stateAgents) + AgentSessionOrder.quiet(stateAgents)) {
          AgentEntry(entry: AgentEntryModel(session: $0, now: now))
        }
      }
      .frame(width: 340),
      appearance: appearance, background: .vibrant)
    save(snapshot(entriesContainer), "agents-entries-\(mode).png")
    line("agents-entries-\(mode).png: \(Int(entriesContainer.bounds.width))x\(Int(entriesContainer.bounds.height)) pt")
    _ = entriesWindow
  }
  line("")

  layoutEvidence(&failures)

  // Row text and the accessibility value each row exposes.
  line("## Rows (DecisionRowModel, as DecisionRow draws and labels them)")
  @MainActor func describe(_ row: DecisionRowModel) {
    line(
      "- \(row.id): \(row.isNew ? "leading 6 pt Ink.indigo dot, title semibold" : "no dot, title medium"); agent \(row.agentName); marker \(row.urgentMarker.map { "\($0) (red)" } ?? "none"); time left \(row.timeLeft ?? "none")\(row.timeLeftIsRed ? " (red)" : ""); \(row.suggestion ?? "no drawn suggestion")")
    line("  accessibility label: \(row.accessibilityLabel)")
    line("  accessibility value: \(row.accessibilityValue)")
  }
  for row in rows { describe(row) }
  line("")
  line("## Row markers (popover-markers)")
  let markerRows = markerDecisions.map {
    DecisionRowModel(decision: $0, agents: agents, seen: markerSeen, now: now)
  }
  for row in markerRows { describe(row) }
  // Checks the markers against the fixture, so a regression fails the run.
  func markerRow(_ id: String) -> DecisionRowModel { markerRows.first { $0.id == id }! }
  let markerChecks: [(String, Bool)] = [
    ("new urgent row with a distant deadline has the marker and a red time", markerRow("k1").urgentMarker == "Urgent" && markerRow("k1").timeLeftIsRed && markerRow("k1").isNew),
    ("reject recommendation reads as a suggestion", markerRow("k1").suggestion == "Suggests Reject"),
    ("seen urgent row keeps the marker, has no dot, and has no time to color", markerRow("k2").urgentMarker == "Urgent" && !markerRow("k2").isNew && markerRow("k2").timeLeft == nil),
    ("approve recommendation reads as a suggestion", markerRow("k2").suggestion == "Suggests Approve"),
    ("due-soon row has a red time and no marker", markerRow("k3").timeLeftIsRed && markerRow("k3").urgentMarker == nil),
    ("seen row due later has neither red nor a marker", !markerRow("k4").timeLeftIsRed && markerRow("k4").urgentMarker == nil && !markerRow("k4").isNew),
    ("new row without a deadline has the dot only", markerRow("k5").isNew && markerRow("k5").urgentMarker == nil && !markerRow("k5").timeLeftIsRed),
    ("VoiceOver reads new, urgent, and the suggestion", markerRow("k1").accessibilityValue.contains("new, urgent, suggests Reject")),
    ("a single-choice row draws no suggestion, and VoiceOver reads it", markerRow("k3").suggestion == nil && markerRow("k3").accessibilityValue.contains("suggests Tonight")),
    ("a free-text row draws no suggestion, and VoiceOver reads it", markerRow("k5").suggestion == nil && markerRow("k5").accessibilityValue.contains("suggests agentdesk-core")),
    ("a row draws the short name, and VoiceOver reads the full one", markerRow("k4").agentName == "api" && markerRow("k4").accessibilityValue.hasPrefix("Claude Code · api")),
  ]
  for (name, passed) in markerChecks {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("row marker: \(name)") }
  }
  line("")

  panelEvidence(&failures)
  agentPanelEvidence(&failures)
  pairedWindowEvidence(&failures)
  agentPairedWindowEvidence(&failures)
  panelHeightEvidence(&failures)
  linkedRecoveryEvidence(&failures)

  line("## Strips")
  line("undo: \(DecisionPresentation.undoText(.approve, decision: decisions.first { $0.id == "d2" }!)) [Undo]")
  line(
    "conflict: \(DecisionPresentation.recordedOutcome(decision(["state": "answered", "answer": ["kind": "reject"], "answered_via": "chat", "chat_message": "not yet"])) ?? "")")
  line("conflict, outcome unread: \(PendingAnswers.unreadOutcome)")
  line("send failed, under the row: \(PendingAnswers.failureMessage)")
  line("")
  line("## Agents line and list (popover-agents-*)")
  let summary = AgentsSummary(agents: groupedAgents)
  line("agents line: \(summary.text)")
  line("accessibility: \(summary.accessibilityLabel)")
  line("no sessions: \(AgentsSummary(agents: []).text)")
  for session in AgentSessionOrder.listed(groupedAgents) {
    let entry = AgentEntryModel(session: session, now: now)
    line("  entry: draws \(entry.dot) dot, \(entry.shortName), \(entry.stateText); reads \(entry.accessibilityLabel)")
  }
  line("  control: \(summary.showQuietText), then \(AgentsSummary.hideQuietText)")
  for session in AgentSessionOrder.quiet(groupedAgents) {
    let entry = AgentEntryModel(session: session, now: now)
    line("  revealed: draws \(entry.dot) dot, \(entry.shortName), \(entry.stateText); reads \(entry.accessibilityLabel)")
  }
  line("every state (popover-agents-states, agents-entries):")
  for session in AgentSessionOrder.listed(stateAgents) + AgentSessionOrder.quiet(stateAgents) {
    let entry = AgentEntryModel(session: session, now: now)
    line("  \(session.id): draws \(entry.dot) dot, \(entry.shortName), \(entry.stateText); reads \(entry.accessibilityLabel)")
  }
  let manySummary = AgentsSummary(agents: manyAgents)
  line("18 sessions: \(manySummary.text); listed first: \(AgentSessionOrder.listed(manyAgents).prefix(3).map(\.displayName).joined(separator: ", "))")
  func quietTexts(_ sessions: [AgentSession]) -> [String] {
    AgentSessionOrder.quiet(sessions).map { AgentEntryModel(session: $0, now: now).stateText }
  }
  func stateEntry(_ id: String) -> AgentEntryModel {
    AgentEntryModel(session: stateAgents.first { $0.id == id }!, now: now)
  }
  let agentChecks: [(String, Bool)] = [
    ("working and not stale is green", stateEntry("s_work").dot == .green),
    ("waiting and not stale is amber", stateEntry("s_wait").dot == .amber),
    ("blocked is red, stale or not", stateEntry("s_block").dot == .red && stateEntry("s_blockstale").dot == .red),
    ("done, no state, and quiet are neutral", ["s_done", "s_none", "s_quiet1", "s_quiet2", "s_quiet3"].allSatisfy { stateEntry($0).dot == .neutral }),
    ("a default name draws the topic's last segment", stateEntry("s_work").shortName == "migrations" && stateEntry("s_block").shortName == "web"),
    ("a custom name draws in full", stateEntry("s_wait").shortName == "Release captain"),
    ("VoiceOver reads the full name and the status line", stateEntry("s_work").accessibilityLabel == "Claude Code · api/migrations, working, Running the migration tests"),
    ("line reads active, quiet, and blocked", summary.text == "2 active · 3 quiet · 2 blocked"),
    ("each session is in one group", summary.total == groupedAgents.count),
    ("list shows blocked then active in API order", AgentSessionOrder.listed(groupedAgents).map(\.id) == ["g_b1", "g_b2", "g_a1", "g_a2"]),
    ("quiet is most recent first in minutes, hours, and days", quietTexts(groupedAgents) == ["quiet 44m", "quiet 3h", "quiet 2d"]),
    ("a stale blocked session reads blocked", AgentEntryModel(session: groupedAgents[5], now: now).stateText == "blocked"),
    ("a zero group is left out except active", AgentsSummary(agents: []).text == "0 active"),
  ]
  for (name, passed) in agentChecks {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("agents: \(name)") }
  }
  line("")

  scrollEvidence(&failures)

  // The menu bar style: count until the user chooses another.
  line("## Menu bar style")
  let styleDefaults = UserDefaults(suiteName: "agentdesk-evidence-\(UUID().uuidString)")!
  let unsetStyle = MenuBarStyle(defaults: styleDefaults)
  MenuBarStyle.dot.save(to: styleDefaults)
  let storedDot = MenuBarStyle(defaults: styleDefaults)
  line("unset: \(unsetStyle.rawValue); stored dot: \(storedDot.rawValue)")
  if unsetStyle != .count || storedDot != .dot { failures.append("menu bar style default") }
  let labelState = AppState(
    summary: MenuBarSummary(decisions: decisions, seen: seen, now: now))
  let labelImage = MenuBarLabel.image(for: labelState)
  line("default label with 3 waiting: \(labelImage.accessibilityDescription ?? ""), width \(Int(labelImage.size.width)) pt, template=\(labelImage.isTemplate)")
  if !labelImage.isTemplate || labelImage.size.width <= PromptGlyph.size.width {
    failures.append("the default label does not draw the count")
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
        let gated = name.hasPrefix("Ink") || name.hasPrefix("title")
        let floor = dotInkSwatches.contains(name) ? dotInkFloor : textInkFloor
        line(
          String(
            format: "%-18@ %5.2f:1  text %@ on %@%@", name as NSString, measured.ratio,
            hex(measured.text) as NSString, hex(measured.background) as NSString,
            (gated ? String(format: "  (floor %.1f:1)", floor) : "  (not gated)") as NSString))
        if gated, measured.ratio < floor {
          failures.append("\(name) \(label) is \(measured.ratio):1, below \(floor):1")
        }
      }
      _ = window
    }
  }
  line("")

  // Contrast, computed for every shipped Ink value, including Increase
  // Contrast, against the rendered popover backgrounds and pure white and
  // black.
  line("## Contrast, computed from the shipped Ink values (floor 4.5:1 for text inks, 3.0:1 for dot inks)")
  let light = [NSColor(white: 0xF3 / 255.0, alpha: 1), .white]
  let dark = [NSColor(white: 0x2E / 255.0, alpha: 1), NSColor(white: 0x3C / 255.0, alpha: 1), .black]
  for (name, shades, floor) in [
    ("secondary", Ink.secondaryShades, textInkFloor), ("tertiary", Ink.tertiaryShades, textInkFloor),
    ("red", Ink.redShades, textInkFloor), ("green", Ink.greenShades, dotInkFloor),
    ("amber", Ink.amberShades, dotInkFloor), ("indigo", Ink.indigoShades, dotInkFloor),
  ] {
    for (variant, color, backgrounds) in [
      ("light", shades.light, light), ("dark", shades.dark, dark),
      ("light Increase Contrast", shades.lightHigh, light),
      ("dark Increase Contrast", shades.darkHigh, dark),
    ] {
      let worst = backgrounds.map { contrast(color, $0) }.min()!
      let each = backgrounds.map { String(format: "%@ %.2f", hex($0), contrast(color, $0)) }.joined(separator: ", ")
      line(String(format: "Ink.%@ %@ %@: worst %.2f:1 (%@)", name, variant, hex(color), worst, each))
      if worst < floor { failures.append("Ink.\(name) \(variant) is \(worst):1, below \(floor):1") }
    }
  }
  let highContrast = NSAppearance(named: .accessibilityHighContrastAqua)
  line(
    "NSAppearance(named: .accessibilityHighContrastAqua) offscreen: \(highContrast?.name.rawValue ?? "nil"); Increase Contrast is not rendered offscreen, so its values are computed only")
  line("")

  // Known solid fills read back through the same calls as the rendered
  // contrast. This gates nothing: it records how far the measured figures sit
  // from the colors drawn, a known limit whose cause is not established.
  line("## Known fills read back through the harness's bitmap path (reported, not gated)")
  for (name, color) in [
    ("#F3F3F3", NSColor(srgbRed: 0xF3 / 255.0, green: 0xF3 / 255.0, blue: 0xF3 / 255.0, alpha: 1)),
    ("#2E2E2E", NSColor(srgbRed: 0x2E / 255.0, green: 0x2E / 255.0, blue: 0x2E / 255.0, alpha: 1)),
    (hex(Ink.greenShades.light), Ink.greenShades.light), (hex(Ink.amberShades.light), Ink.amberShades.light),
    (hex(Ink.indigoShades.light), Ink.indigoShades.light), (hex(Ink.greenShades.dark), Ink.greenShades.dark),
    (hex(Ink.amberShades.dark), Ink.amberShades.dark), (hex(Ink.indigoShades.dark), Ink.indigoShades.dark),
  ] {
    let fill = NSView(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
    fill.wantsLayer = true
    fill.layer?.backgroundColor = color.cgColor
    let window = NSWindow(contentRect: fill.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = fill
    line("fill \(name) reads back as \(hex(snapshot(fill).colorAt(x: 5, y: 5)!))")
    _ = window
  }
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
  line("NOT EXERCISED, assigned to the operator's pre-release checks: the real status item position and panel side, physical clicks and keys in both windows, a real click on the desktop or in another app, real deactivation, live Tab and Shift-Tab with Keyboard navigation on, and VoiceOver speech and focus. Everything below in this report is non-live.")
  line("The installed app's own menu bar item, popover, and panel are not exercised: the harness never launches a build, and it shows only fully transparent windows while its app stays inactive. The paired-window section above drives a real NSPopover with the shipped panel, lifetime, and key observer through events posted to this process, with no pointer or keyboard involved; PopoverController, AppState, and physical input are not part of it. The scroll section above drives the shipped list in a retained hosting controller moved between offscreen windows, and calls the requests AppState makes on those events.")
  line("The scroller under a live change of the Show scroll bars setting is not captured; the scroll section above posts the change notification instead.")
  line("AXIsProcessTrusted=\(AXIsProcessTrusted()): live VoiceOver output and the live NSPopover open and close are not captured; row accessibility strings above come from DecisionRowModel, which DecisionRow applies as its summary element's label and value, with Reject and Approve as separate elements. The panel's controls above are read from its AppKit views, and access.txt reads its accessibility tree through the Accessibility API; VoiceOver's speech is not captured.")
  line("Keys from a physical keyboard are not captured. The paired-window section above posts key events to the shipped observers, and PopoverKeysTests covers the key-to-action mapping; Escape with no panel open closes the popover.")
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
