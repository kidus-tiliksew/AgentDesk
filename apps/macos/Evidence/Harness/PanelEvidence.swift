import AppKit
import Observation
import SwiftUI

/// Counts every time this process becomes the active app, so a harness run that
/// takes focus from the Mac user's work fails.
@MainActor
final class ActivationWatch {
  static let shared = ActivationWatch()
  private(set) var count = 0
  private var observer: NSObjectProtocol?

  func start() {
    observer = NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { _ in
      MainActor.assumeIsolated { ActivationWatch.shared.count += 1 }
    }
  }
}

// The detail panel (component-mac-app §Detail panel; req-mac-app REQ-11).
// `panelEvidence` renders the shipped `DecisionDetailView` offscreen from
// fixtures. `pairedWindowEvidence` drives a real `NSPopover` beside the shipped
// `DetailPanelController` and `PairedWindowLifetime`, with the shipped
// `PopoverKeyObserver` in both windows, through events posted to this process.
// Those windows are fully transparent and the app stays inactive, so the
// section neither shows anything nor takes focus from the user's work.

private func utcCalendar() -> Calendar {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "UTC")!
  return calendar
}

private func panelModel(_ decision: Decision, titles: [String: String] = [:]) -> DecisionDetailModel {
  DecisionDetailModel(
    decision: decision, agents: agentsFixture, titles: titles, now: now, calendar: utcCalendar(),
    locale: Locale(identifier: "en_US"))
}

func presentation(
  _ decision: Decision, titles: [String: String] = [:], failure: String? = nil, isAnswerable: Bool = true,
  refreshFailed: Bool = false
) -> DetailPanelPresentation {
  DetailPanelPresentation(
    content: .loaded(panelModel(decision, titles: titles), decision), failure: failure,
    isAnswerable: isAnswerable, refreshFailed: refreshFailed)
}

/// The panel at its height limit, as `DetailPanelController` hosts it.
private struct PanelFixture: View {
  let presentation: DetailPanelPresentation
  var maxHeight = CGFloat(DetailPanelPlacement.maxHeight)
  var actions = DecisionDetailActions()

  var body: some View {
    DecisionDetailView(presentation: presentation, maxHeight: maxHeight, actions: actions)
  }
}

/// The popover and the panel side by side, as they sit on screen.
private struct PairFixture: View {
  let presentation: DetailPanelPresentation

  var body: some View {
    HStack(alignment: .top, spacing: CGFloat(DetailPanelPlacement.gap)) {
      PopoverFixture(
        items: items(decisions), expanded: false, selectedID: "d1", shownID: "d1")
      DecisionDetailView(presentation: presentation)
    }
  }
}

/// Hosting layouts settle over a few passes, since the view measures itself.
@MainActor
private func settled<V: View>(_ view: V, appearance: NSAppearance.Name) -> (NSWindow, NSView, NSHostingView<V>) {
  let hosting = NSHostingView(rootView: view)
  hosting.frame = NSRect(x: 0, y: 0, width: 800, height: 700)
  let effect = NSVisualEffectView(frame: hosting.frame)
  effect.material = .popover
  effect.blendingMode = .withinWindow
  effect.state = .active
  effect.addSubview(hosting)
  let window = NSWindow(contentRect: effect.frame, styleMask: [.borderless], backing: .buffered, defer: false)
  window.appearance = NSAppearance(named: appearance)
  window.contentView = effect
  for _ in 0..<6 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    hosting.layoutSubtreeIfNeeded()
    let size = hosting.fittingSize
    if size.height > 0, size != hosting.frame.size {
      effect.setFrameSize(size)
      hosting.frame = NSRect(origin: .zero, size: size)
      window.setContentSize(size)
    }
  }
  return (window, effect, hosting)
}

// MARK: AppKit controls

/// The AppKit controls in a hosted view: `button` for the close control, links,
/// radio buttons, and checkboxes, which SwiftUI builds on `NSButton` with no
/// title of their own, and `text field` with its placeholder. SwiftUI draws
/// bordered buttons itself, so the renders show Reject, Approve, Send, and Try
/// Again. SwiftUI builds its accessibility tree only for a running assistive
/// client, so this is what a process can read about the controls without one.
@MainActor
private func controlTitles(in view: NSView) -> [String] {
  var titles: [String] = []
  if view is NSButton {
    titles.append("button")
  } else if let field = view as? NSTextField, field.isEditable {
    titles.append("text field: \(field.placeholderString ?? "")")
  }
  return titles + view.subviews.flatMap(controlTitles)
}

// MARK: Fixtures

let followUpTitles = ["dp_parent": "Run the staging soak first?", "dp_up2": "Tell the team about the release?"]
let linkedDecision = decision([
  "id": "dp_linked", "title": "Ship the 2.4 release now that the staging soak passed?", "input_type": "single_choice",
  "agent_session_id": "ags_2", "body": "This follows the soak decision.", "topic": "release", "priority": "urgent",
  "options": [["id": "a", "label": "Ship now"], ["id": "b", "label": "Wait"]],
  "recommendation": ["kind": "option", "option_id": "a"], "deadline": "2026-10-27T12:04:00Z",
  "default": ["kind": "option", "option_id": "b"], "parent_id": "dp_parent", "follow_up_ids": ["dp_up1", "dp_up2"],
])

private let longBody = (1...24).map {
  "Paragraph \($0): the migration rewrites **every row** of the `events` table, so the soak has to finish before it starts, and the on-call engineer has to know the rollback steps."
}.joined(separator: "\n\n")
private let longDecision = decision([
  "id": "dp_long", "title": String(repeating: "A long title that keeps going past one line. ", count: 2).trimmingCharacters(in: .whitespaces),
  "agent_session_id": "ags_1", "body": longBody, "recommendation": ["kind": "approve"],
])

let settledFixtures: [(String, Decision)] = [
  (
    "settled-answered",
    decision([
      "id": "dp_s1", "title": "Delete the stale preview databases?", "agent_session_id": "ags_1",
      "body": "Seven previews have had **no traffic** for 30 days.", "state": "answered",
      "answer": ["kind": "approve"], "answered_via": "app", "answered_at": "2026-10-27T11:59:00Z",
      "note": "Keep pr-412 for the demo.", "recommendation": ["kind": "approve"],
    ])
  ),
  (
    "settled-chat",
    decision([
      "id": "dp_s2", "title": "Ship the 2.4 release now?", "input_type": "single_choice", "agent_session_id": "ags_2",
      "options": [["id": "a", "label": "Ship now"], ["id": "b", "label": "Wait for Monday"]], "state": "answered",
      "answer": ["kind": "option", "option_id": "b"], "answered_via": "chat", "answered_at": "2026-10-27T11:58:00Z",
      "chat_message": "**wait** until monday, the team is out",
    ])
  ),
  (
    "settled-default",
    decision([
      "id": "dp_s3", "title": "When should the migration run?", "input_type": "single_choice", "agent_session_id": "ags_1",
      "options": [["id": "now", "label": "Now"], ["id": "night", "label": "Tonight at 02:00"]], "state": "expired",
      "answer": ["kind": "option", "option_id": "night"], "answered_via": "default", "applied_by_default": true,
      "answered_at": "2026-10-27T11:30:00Z", "deadline": "2026-10-27T11:30:00Z",
      "default": ["kind": "option", "option_id": "night"],
    ])
  ),
  (
    "settled-expired",
    decision([
      "id": "dp_s4", "title": "Rotate the signing key today?", "agent_session_id": "ags_1", "state": "expired",
      "deadline": "2026-10-27T10:00:00Z",
    ])
  ),
  (
    "settled-cancelled",
    decision([
      "id": "dp_s5", "title": "Which name should the new package use?", "input_type": "free_text",
      "agent_session_id": "ags_gone", "state": "cancelled",
    ])
  ),
]

// MARK: Rendering

@MainActor
func panelEvidence(_ failures: inout [String]) {
  line("## Detail panel (the shipped DecisionDetailView, offscreen)")
  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("detail panel: \(name)") }
  }

  var scenes: [(String, DetailPanelPresentation)] = panelDecisions.map { ("panel-\($0.0)", presentation($0.1)) }
  scenes += settledFixtures.map { ("panel-\($0.0)", presentation($0.1)) }
  scenes += [
    ("panel-long", presentation(longDecision)),
    ("panel-linked", presentation(linkedDecision, titles: followUpTitles)),
    ("panel-send-failed", presentation(panelDecisions[1].1, failure: PendingAnswers.failureMessage)),
    ("panel-refresh-failed", presentation(panelDecisions[0].1, refreshFailed: true)),
    ("panel-answer-held", presentation(panelDecisions[0].1, isAnswerable: false)),
    ("panel-loading", DetailPanelPresentation(content: .loading)),
    ("panel-unavailable", DetailPanelPresentation(content: .unavailable)),
    ("panel-load-failed", DetailPanelPresentation(content: .failed)),
  ]
  var trees: [String: [String]] = [:]
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    for (name, scene) in scenes {
      let (window, container, hosting) = settled(PanelFixture(presentation: scene), appearance: appearance)
      save(snapshot(container), "\(name)-\(mode).png")
      line("\(name)-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
      if container.bounds.width != 400 { failures.append("\(name)-\(mode) is not 400 pt wide") }
      if container.bounds.height > 560 { failures.append("\(name)-\(mode) exceeds 560 pt") }
      if trees[name] == nil { trees[name] = controlTitles(in: hosting) }
      if name == "panel-long" {
        let scroll = scrollViews(in: container).first
        let clip = scroll?.documentVisibleRect.height ?? 0
        let document = scroll?.documentView?.bounds.height ?? 0
        check(
          "the long panel (\(mode)) scrolls: \(Int(document)) pt of content in \(Int(clip)) pt", document > clip,
          &failures)
        check(
          "the long panel (\(mode)) keeps a visible scroller",
          scroll?.verticalScroller?.isHidden == false && scroll?.verticalScroller is ListScroller, &failures)
      }
      _ = window
    }
    let pair = presentation(decisions.first { $0.id == "d1" }!)
    let (window, container, _) = settled(PairFixture(presentation: pair), appearance: appearance)
    save(snapshot(container), "panel-beside-popover-\(mode).png")
    line("panel-beside-popover-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
    check(
      "the popover (340 pt), the gap (8 pt), and the panel (400 pt) sit side by side (\(mode))",
      container.bounds.width == 748, &failures)
    _ = window
  }
  line("")

  line("### What each input type's untouched AnswerDraft submits")
  for (type, shown) in panelDecisions {
    let draft = AnswerDraft.forPanel(shown)
    let answer = draft.submission.map { DecisionPresentation.answerText($0.answer, options: shown.options) }
    line("- \(type): Send and ⌘↩ submit \(answer ?? "nothing")")
    let model = panelModel(shown)
    line("  default: \(model.defaultAnswer ?? "none")")
    let suggested = draft.options.filter { draft.isSuggested($0.id) }.map(\.label)
    if !suggested.isEmpty { line("  labelled Suggested: \(suggested.joined(separator: ", "))") }
    if let text = draft.suggestedText { line("  text placeholder: \(text)") }
    if shown.inputType == .approveReject {
      line(
        "  buttons, one neutral style: Reject\(draft.isSuggested(.reject) ? " (hint \"Suggested by the agent\")" : ""), Approve\(draft.isSuggested(.approve) ? " (hint \"Suggested by the agent\")" : "")")
    }
    check("the note field is open, so a note reaches the answer (\(type))", draft.isNoteOpen, &failures)
  }
  line("")

  line("### Settled decisions (the recorded outcome, and no controls)")
  for (name, shown) in settledFixtures {
    let model = panelModel(shown)
    line("- \(name): \(model.outcome?.summary ?? "none")")
    if let message = model.outcome?.chatMessage { line("  chat message, word for word: \(message)") }
    if let note = model.outcome?.note { line("  note: \(note)") }
    check("\(name) has an outcome", model.outcome != nil && !model.isPending, &failures)
    check(
      "\(name) has no answer control: only the close control", trees["panel-\(name)"] == ["button"], &failures)
  }
  line("")

  line("### AppKit controls of each scene")
  for (name, _) in scenes.filter({ $0.0 != "panel-long" }) {
    line("- \(name): \((trees[name] ?? []).joined(separator: "; "))")
  }
  func controls(_ name: String) -> [String] { trees[name] ?? [] }
  func buttons(_ name: String) -> Int { controls(name).filter { $0 == "button" }.count }
  func fields(_ name: String) -> [String] { controls(name).filter { $0 != "button" } }
  let note = "text field: Note for the agent (optional)"
  check("each input type has a note field", panelDecisions.allSatisfy { fields("panel-\($0.0)").contains(note) }, &failures)
  check("single choice has the close control and two radio buttons", buttons("panel-single-choice") == 3, &failures)
  check("multiple choice has the close control and three checkboxes", buttons("panel-multiple-choice") == 4, &failures)
  check("free text has its text field with the suggestion as placeholder", fields("panel-free-text").first == "text field: agentdesk-core", &failures)
  check(
    "single choice or text has its radio buttons and its text field",
    buttons("panel-single-choice-or-text") == 3 && fields("panel-single-choice-or-text").first == "text field: Or type another answer",
    &failures)
  check("the linked panel adds three links to the close control and two radio buttons", buttons("panel-linked") == 6, &failures)
  check("an unavailable decision has only the close control", controls("panel-unavailable") == ["button"], &failures)
  check("a held answer has only the close control", controls("panel-answer-held") == ["button"], &failures)
  line("")
}

// MARK: The paired windows

/// The delegate events `PopoverController` turns into `AppState` calls.
@MainActor
private final class PopoverEvents: NSObject, NSPopoverDelegate {
  var willShow = 0
  var didShow = 0
  var didClose = 0
  var onWillShow: () -> Void = {}
  var onWillClose: () -> Void = {}
  var onDidClose: () -> Void = {}

  func popoverWillShow(_ notification: Notification) {
    willShow += 1
    onWillShow()
  }
  func popoverDidShow(_ notification: Notification) { didShow += 1 }
  func popoverWillClose(_ notification: Notification) { onWillClose() }
  func popoverDidClose(_ notification: Notification) {
    didClose += 1
    onDidClose()
  }
}

private struct FixtureReader: DecisionReader {
  let record: Decision
  func decision(id: String) async throws(APIError) -> Decision { record }
}

/// Real time, shortened: nothing here waits for a refresh.
private struct ShortClock: SyncClock {
  func sleep(seconds: TimeInterval) async throws { try await Task.sleep(nanoseconds: 50_000_000) }
}

/// Stands in for `AppState.handleWindowKey` with the same policy calls.
@MainActor
private final class KeyModel {
  let rows = ["a", "b", "c"]
  var selected: String?
  var sent: [String] = []
  var answerable = true
  let detail: DecisionDetail
  var closePopover: () -> Void = {}

  init(detail: DecisionDetail) {
    self.detail = detail
  }

  func handle(_ key: PopoverKey, editingText: Bool) -> Bool {
    let action = PopoverKeys.action(
      for: key, rows: rows, selected: selected, shown: detail.shownID.map(DetailPanelTarget.decision),
      shownIsAnswerable: answerable,
      editingText: editingText)
    switch action {
    case .select(let id): selected = id
    case .toggle(let id): detail.toggle(id, known: nil)
    case .send(let id): sent.append(id)
    case .closePanel: detail.close()
    case .passThrough:
      guard key == .escape else { return false }
      closePopover()
    }
    return true
  }
}

private struct PopoverSide: View {
  let model: KeyModel
  var body: some View {
    PopoverFixture(items: items(decisions), expanded: false)
      .background(PopoverKeyObserver { model.handle($0, editingText: $1) })
  }
}

private struct PanelSide: View {
  let model: KeyModel
  let shown: DetailPanelPresentation
  let maxHeight: CGFloat
  var body: some View {
    DecisionDetailView(presentation: shown, maxHeight: maxHeight)
      .background(PopoverKeyObserver(controlsKeepArrows: true) { model.handle($0, editingText: $1) })
  }
}

@MainActor
private func drain(_ seconds: TimeInterval = 0.1) {
  let until = Date().addingTimeInterval(seconds)
  while Date() < until {
    if let event = NSApp.nextEvent(
      matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true)
    {
      NSApp.sendEvent(event)
    }
  }
}

@MainActor
private func click(_ window: NSWindow) {
  let point = NSPoint(x: window.frame.width - 2, y: window.frame.height - 2)
  for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
    let event = NSEvent.mouseEvent(
      with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    NSApp.postEvent(event, atStart: false)
  }
  drain()
}

@MainActor
private func press(_ keyCode: UInt16, _ modifiers: NSEvent.ModifierFlags = [], in window: NSWindow) {
  let event = NSEvent.keyEvent(
    with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
    windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "",
    isARepeat: false, keyCode: keyCode)!
  NSApp.postEvent(event, atStart: false)
  drain()
}

private let upKey: UInt16 = 126
private let downKey: UInt16 = 125
private let returnKey: UInt16 = 36
private let escapeKey: UInt16 = 53

@MainActor
private func textField(in view: NSView) -> NSTextField? {
  if let field = view as? NSTextField, field.isEditable { return field }
  for child in view.subviews {
    if let found = textField(in: child) { return found }
  }
  return nil
}

@MainActor
func pairedWindowEvidence(_ failures: inout [String]) {
  line("## Paired windows (a real NSPopover, the shipped panel, lifetime, and key observer; posted events)")
  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("paired windows: \(name)") }
  }
  guard let screen = NSScreen.main else {
    line("not exercised: this session has no screen")
    return
  }
  // `.prohibited` stays in force from the top of the run: the system never
  // activates such a process, so it cannot take focus from the user's work.

  let record = panelDecisions[1].1
  let detail = DecisionDetail(reader: FixtureReader(record: record), clock: ShortClock())
  let model = KeyModel(detail: detail)
  let shown = presentation(record)
  let panel = DetailPanelController { PanelSide(model: model, shown: shown, maxHeight: $0) }
  panel.window.alphaValue = 0

  let popover = NSPopover()
  let events = PopoverEvents()
  popover.behavior = .applicationDefined
  popover.animates = false
  popover.delegate = events
  let host = NSHostingController(rootView: PopoverSide(model: model))
  host.sizingOptions = [.preferredContentSize]
  popover.contentViewController = host
  var popoverWindow: NSWindow? { host.view.window }

  func anchorWindow(atX x: CGFloat) -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: x, y: screen.visibleFrame.maxY - 20, width: 10, height: 10), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.orderFrontRegardless()
    return window
  }
  // Stands for the menu bar item's window, and for another window of this app.
  let statusWindow = anchorWindow(atX: screen.visibleFrame.minX + 40)
  let otherWindow = anchorWindow(atX: screen.visibleFrame.minX + 60)

  let lifetime = PairedWindowLifetime(
    isOwned: { window in window === popoverWindow || window === panel.window },
    isStatusItem: { $0 === statusWindow },
    // A real click by the Mac's user during the run must not close the pair.
    watchesOtherApps: false,
    close: { if popover.isShown { popover.performClose(nil) } })
  model.closePopover = { if popover.isShown { popover.performClose(nil) } }
  events.onWillShow = { lifetime.start() }
  events.onWillClose = { detail.close() }
  events.onDidClose = { lifetime.stop() }

  var target: String?
  detail.onChange = {
    guard detail.shownID != target else { return }
    target = detail.shownID
    if target == nil {
      panel.hide()
      panel.window.alphaValue = 0
    } else if popover.isShown {
      panel.present(beside: host.view, takesKeyFocus: false)
    }
  }

  func open(beside anchor: NSWindow) {
    popover.show(relativeTo: anchor.contentView!.bounds, of: anchor.contentView!, preferredEdge: .minY)
    popoverWindow?.alphaValue = 0
    drain()
  }
  func pair() -> Bool { popover.isShown && panel.isVisible }

  line("screen visible frame: \(Int(screen.visibleFrame.width))x\(Int(screen.visibleFrame.height)) pt; app active: \(NSApp.isActive)")

  // Placement beside a real popover frame, at both ends of the screen (AC-11.1).
  for (name, x, side) in [
    ("left end of the screen", screen.visibleFrame.minX + 200, DetailPanelPlacement.Side.right),
    ("right end of the screen", screen.visibleFrame.maxX - 200, DetailPanelPlacement.Side.left),
  ] {
    let anchor = anchorWindow(atX: x)
    open(beside: anchor)
    detail.show("a", known: record)
    drain(0.3)
    check("\(name): the panel has not taken key focus", !panel.window.isKeyWindow, &failures)
    let popoverFrame = popoverWindow?.convertToScreen(host.view.convert(host.view.bounds, to: nil)) ?? .zero
    let frame = panel.window.frame
    line(
      "\(name): popover x \(Int(popoverFrame.minX))...\(Int(popoverFrame.maxX)), panel x \(Int(frame.minX))...\(Int(frame.maxX)), panel \(Int(frame.width))x\(Int(frame.height)) pt")
    check("\(name): the panel is 400 pt wide with the popover still showing", frame.width == 400 && pair(), &failures)
    let beside =
      side == .right ? frame.minX == popoverFrame.maxX + 8 : frame.maxX == popoverFrame.minX - 8
    check("\(name): the panel sits \(side == .right ? "right" : "left") of the popover, 8 pt away", beside, &failures)
    check("\(name): the tops meet", abs(frame.maxY - popoverFrame.maxY) < 1, &failures)
    popover.close()
    drain()
    anchor.orderOut(nil)
  }

  // What a click does (AC-11.8).
  let anchor = anchorWindow(atX: screen.visibleFrame.minX + 200)
  let beforeCloses = events.didClose
  open(beside: anchor)
  detail.show("a", known: record)
  drain(0.2)
  check("the lifetime runs while the popover shows", lifetime.isRunning, &failures)
  click(panel.window)
  check("a click in the panel keeps both", pair(), &failures)
  if let window = popoverWindow { click(window) }
  check("a click in the popover keeps both", pair(), &failures)
  click(statusWindow)
  check("a click on the menu bar item's window leaves both to the item's action", pair(), &failures)
  NotificationCenter.default.post(name: NSMenu.didBeginTrackingNotification, object: NSMenu())
  drain()
  click(otherWindow)
  check("a click while a menu tracks keeps both", pair(), &failures)
  NotificationCenter.default.post(name: NSMenu.didEndTrackingNotification, object: NSMenu())
  drain()
  check("losing key status alone closes nothing", pair(), &failures)
  click(otherWindow)
  check("a click in another window closes both", !popover.isShown && !panel.isVisible, &failures)
  check("the popover's close event ran once", events.didClose == beforeCloses + 1, &failures)
  check("the lifetime stopped with it", !lifetime.isRunning, &failures)

  func closesOn(_ name: String, center: NotificationCenter, _ notification: Notification.Name, _ failures: inout [String]) {
    open(beside: anchor)
    detail.show("a", known: record)
    drain(0.2)
    center.post(name: notification, object: nil)
    drain()
    check("\(name) closes both", !popover.isShown && !panel.isVisible, &failures)
  }
  closesOn("the app's deactivation (posted)", center: .default, NSApplication.didResignActiveNotification, &failures)
  closesOn(
    "a Space change (posted)", center: NSWorkspace.shared.notificationCenter,
    NSWorkspace.activeSpaceDidChangeNotification, &failures)

  // Closing only the panel leaves the popover's lifecycle alone.
  let closesBefore = events.didClose
  open(beside: anchor)
  detail.show("a", known: record)
  drain(0.2)
  detail.close()
  drain()
  check("closing only the panel keeps the popover open", popover.isShown && !panel.isVisible, &failures)
  check("closing only the panel runs no popover close event", events.didClose == closesBefore, &failures)
  popover.close()
  drain()

  // Repeated openings keep one of each event per opening.
  let (shows, closes) = (events.willShow, events.didClose)
  for _ in 0..<3 {
    open(beside: anchor)
    detail.show("a", known: record)
    drain(0.1)
    click(otherWindow)
  }
  check(
    "three more openings run three will-show and three did-close events",
    events.willShow == shows + 3 && events.didClose == closes + 3, &failures)

  // The keys (AC-7.1, AC-11.7), from whichever window has them.
  open(beside: anchor)
  guard let keysPopover = popoverWindow else {
    failures.append("paired windows: the popover opened no window, so the keys were not checked")
    return
  }
  press(downKey, in: keysPopover)
  check("↓ selects the first row", model.selected == "a", &failures)
  press(downKey, in: keysPopover)
  check("↓ moves to the next row", model.selected == "b", &failures)
  press(upKey, in: keysPopover)
  check("↑ moves back", model.selected == "a", &failures)
  press(returnKey, in: keysPopover)
  check("↩ opens the selected row's panel", detail.shownID == "a" && pair(), &failures)
  press(returnKey, in: panel.window)
  check("↩ from the panel closes it and the popover stays", detail.shownID == nil && popover.isShown, &failures)
  press(returnKey, in: keysPopover)
  press(downKey, in: panel.window)
  check("↓ from the panel moves the selection and the panel stays", model.selected == "b" && detail.shownID == "a", &failures)
  press(returnKey, in: panel.window)
  check("↩ on another selected row replaces the panel's target", detail.shownID == "b" && pair(), &failures)
  press(returnKey, .command, in: panel.window)
  check("⌘↩ sends the shown decision", model.sent == ["b"], &failures)
  model.selected = "c"
  press(returnKey, .command, in: keysPopover)
  check("⌘↩ prefers the shown decision over the selected row", model.sent == ["b", "b"], &failures)
  model.answerable = false
  press(returnKey, .command, in: keysPopover)
  check("⌘↩ sends nothing for a settled target, and no row in its place", model.sent == ["b", "b"], &failures)
  model.answerable = true

  if let field = panel.window.contentView.flatMap(textField) {
    panel.window.makeFirstResponder(field)
    drain()
    let editing = panel.window.firstResponder is NSText
    check("a text field in the panel takes the field editor", editing, &failures)
    model.selected = "b"
    press(downKey, in: panel.window)
    check("a text field keeps ↓", model.selected == "b", &failures)
    press(returnKey, in: panel.window)
    check("a text field keeps ↩", detail.shownID == "b", &failures)
    press(returnKey, .command, in: panel.window)
    check("⌘↩ still sends from a text field", model.sent == ["b", "b", "b"], &failures)
    press(escapeKey, in: panel.window)
    check("Escape from a text field closes the panel", detail.shownID == nil && popover.isShown, &failures)
    panel.window.makeFirstResponder(nil)
    detail.show("b", known: record)
    drain(0.2)
  } else {
    failures.append("paired windows: the panel holds no text field")
  }
  press(escapeKey, in: panel.window)
  check("Escape closes the panel first and the popover stays", detail.shownID == nil && popover.isShown, &failures)
  press(escapeKey, in: keysPopover)
  drain()
  check("Escape again closes the popover", !popover.isShown, &failures)

  // A focused radio button keeps the arrows, when this machine's Keyboard
  // navigation setting lets a button take focus at all.
  open(beside: anchor)
  detail.show("b", known: record)
  drain(0.2)
  func firstButton(in view: NSView) -> NSButton? {
    for child in view.subviews {
      if let button = child as? NSButton { return button }
      if let found = firstButton(in: child) { return found }
    }
    return nil
  }
  if let radio = panel.window.contentView.flatMap(firstButton), panel.window.makeFirstResponder(radio),
    panel.window.firstResponder is NSControl
  {
    model.selected = "b"
    press(downKey, in: panel.window)
    check("a focused control in the panel keeps ↓", model.selected == "b", &failures)
    panel.window.makeFirstResponder(nil)
  } else {
    line("not exercised: a focused control keeping ↓, since a button cannot take focus with Keyboard navigation off")
  }
  press(escapeKey, in: panel.window)
  popover.close()
  drain()

  // Tab walks AppKit's key view loop, which the observers never read (AC-11.11).
  open(beside: anchor)
  detail.show("b", known: record)
  drain(0.2)
  line("macOS Keyboard navigation setting on: \(NSApp.isFullKeyboardAccessEnabled)")
  panel.window.makeFirstResponder(nil)
  var stops: [String] = []
  for _ in 0..<12 {
    panel.window.selectNextKeyView(nil)
    drain(0.02)
    let responder = panel.window.firstResponder
    let view = (responder as? NSText)?.delegate as? NSControl ?? responder as? NSControl
    let name = (view as? NSButton)?.title ?? (view as? NSTextField)?.placeholderString ?? String(describing: responder.map { type(of: $0) })
    if stops.contains(name) { break }
    stops.append(name)
  }
  line("Tab stops from the panel's start: \(stops.joined(separator: "; "))")
  check("Tab reaches the panel's note field", stops.contains { $0.contains("Note for the agent") }, &failures)
  press(escapeKey, in: panel.window)
  popover.close()
  drain()

  // The panel stays out of the system's window lists (AC-1.1).
  check("the panel is excluded from the Windows menu", panel.window.isExcludedFromWindowsMenu, &failures)
  check("the panel ignores window cycling", panel.window.collectionBehavior.contains(.ignoresCycle), &failures)
  check("the panel can take key focus", panel.window.canBecomeKey, &failures)
  check("this process never became the active app, so the user's focus never moved", ActivationWatch.shared.count == 0 && !NSApp.isActive, &failures)
  anchor.orderOut(nil)
  statusWindow.orderOut(nil)
  otherWindow.orderOut(nil)
  line("")
}

// MARK: The agent panel

let agentHistoryFixture = [
  StatusHistoryEntry(
    state: .waiting, line: "Waiting for the staging soak", link: "https://example.com/soak/12",
    at: Instant.parse("2026-10-27T11:55:00Z")!),
  StatusHistoryEntry(state: .working, line: "Ran the migration on a copy", at: Instant.parse("2026-10-27T11:20:00Z")!),
  StatusHistoryEntry(state: .working, line: "Started on the events table", at: Instant.parse("2026-10-27T08:40:00Z")!),
]

let workingAgent = session([
  "id": "ags_1", "display_name": "Claude Code · api", "topic": "api/migrations", "state": "working",
  "line": "Running the migration tests", "link": "https://example.com/pull/412", "pending_decision_count": 1,
  "status_at": "2026-10-27T11:58:00Z",
])
let blockedAgent = session([
  "id": "ags_2", "display_name": "Codex · web", "topic": "web", "state": "blocked",
  "line": "Needs a decision on the release before it can go on", "pending_decision_count": 1,
  "status_at": "2026-10-27T11:50:00Z",
])
let staleAgent = session([
  "id": "ags_3", "display_name": "Cursor · docs", "topic": "docs", "state": "waiting", "stale": true,
  "line": "Waiting for review", "last_activity_at": "2026-10-27T11:17:00Z", "status_at": "2026-10-27T11:15:00Z",
])
let noStatusAgent = session([
  "id": "ags_4", "display_name": "Claude Code · new", "topic": "new", "state": NSNull(), "line": NSNull(),
  "status_at": NSNull(),
])
let invalidLinkAgent = session([
  "id": "ags_5", "display_name": "Claude Code · link", "topic": "links", "line": "Holds a link no browser should open",
  "link": "javascript:alert(1)",
])
let relativeLinkAgent = session([
  "id": "ags_6", "display_name": "Claude Code · link", "topic": "links", "line": "Holds a relative link",
  "link": "/pull/412",
])
let longAgent = session([
  "id": "ags_7", "display_name": "Claude Code · a session whose display name runs well past the panel's header",
  "topic": "api/migrations/events/a-topic-that-is-long-enough-to-wrap-inside-the-fact-column",
  "line": String(repeating: "The migration rewrites every row of the events table. ", count: 4).prefix(200).description,
  "link": "https://example.com/pull/412", "pending_decision_count": 2,
])
let longHistory = (1...20).map {
  StatusHistoryEntry(
    state: $0.isMultiple(of: 3) ? .blocked : .working,
    line: "Status \($0): the migration rewrote another batch of rows, so the soak still has to finish before it starts.",
    link: $0.isMultiple(of: 4) ? "https://example.com/run/\($0)" : nil,
    at: Instant.parse("2026-10-27T11:00:00Z")!.addingTimeInterval(TimeInterval(-600 * $0)))
}
let agentPendingFixture = [
  decision([
    "id": "ap_1", "title": "Delete the stale preview databases?", "agent_session_id": "ags_1",
    "created_at": "2026-10-27T11:40:00Z",
  ]),
  decision([
    "id": "ap_2", "title": "Ship the 2.4 release to production now that the staging soak passed?",
    "agent_session_id": "ags_2", "priority": "urgent", "deadline": "2026-10-27T12:04:00Z",
    "created_at": "2026-10-27T11:30:00Z",
  ]),
  decision([
    "id": "ap_3", "title": "Which migration window should it use?", "agent_session_id": "ags_7",
    "created_at": "2026-10-27T11:45:00Z",
  ]),
  decision([
    "id": "ap_4", "title": "Rebuild the index afterwards?", "agent_session_id": "ags_7",
    "deadline": "2026-10-27T14:00:00Z", "created_at": "2026-10-27T11:46:00Z",
  ]),
]

func agentPresentation(
  _ session: AgentSession, history: AgentHistory = .available(agentHistoryFixture), refreshFailed: Bool = false
) -> AgentDetailPresentation {
  AgentDetailPresentation(
    content: .loaded(session, history), refreshFailed: refreshFailed, decisions: agentPendingFixture, now: now)
}

func agentScenes() -> [(String, AgentDetailPresentation)] {
  [
    ("agent-working", agentPresentation(workingAgent)),
    ("agent-stale", agentPresentation(staleAgent)),
    ("agent-blocked", agentPresentation(blockedAgent)),
    ("agent-no-status", agentPresentation(noStatusAgent, history: .available([]))),
    ("agent-history-unavailable", agentPresentation(workingAgent, history: .unavailable)),
    ("agent-invalid-link", agentPresentation(invalidLinkAgent)),
    ("agent-relative-link", agentPresentation(relativeLinkAgent)),
    ("agent-long", agentPresentation(longAgent, history: .available(longHistory))),
    ("agent-refresh-failed", agentPresentation(workingAgent, refreshFailed: true)),
    (
      "agent-loading",
      AgentDetailPresentation(content: .loading(nil), refreshFailed: false, decisions: [], now: now)
    ),
    (
      "agent-loading-seed",
      AgentDetailPresentation(content: .loading(workingAgent), refreshFailed: false, decisions: agentPendingFixture, now: now)
    ),
    (
      "agent-load-failed",
      AgentDetailPresentation(content: .failed(nil), refreshFailed: false, decisions: [], now: now)
    ),
    (
      "agent-load-failed-seed",
      AgentDetailPresentation(content: .failed(workingAgent), refreshFailed: false, decisions: agentPendingFixture, now: now)
    ),
    (
      "agent-pending-unread",
      AgentDetailPresentation(
        content: .loaded(blockedAgent, .available(agentHistoryFixture)), refreshFailed: false, decisions: [], now: now,
        decisionsAreKnown: false)
    ),
    ("agent-gone", AgentDetailPresentation(content: .gone)),
  ]
}

/// The popover with its agents list open and the panel showing a session.
private struct AgentPairFixture: View {
  let presentation: AgentDetailPresentation

  var body: some View {
    HStack(alignment: .top, spacing: CGFloat(DetailPanelPlacement.gap)) {
      PopoverFixture(items: items(decisions), expanded: true, shownAgentID: "ags_1")
      AgentDetailView(presentation: presentation)
    }
  }
}

private func historyText(_ history: AgentDetailModel.History) -> String {
  switch history {
  case .unread: "not read"
  case .unavailable: "unavailable"
  case .available(let entries): "\(entries.count)"
  }
}

/// Renders the shipped `AgentDetailView` and states what each scene holds
/// (req-mac-app AC-11.3, AC-11.4, AC-11.9, AC-11.12).
@MainActor
func agentPanelEvidence(_ failures: inout [String]) {
  line("## Agent panel (the shipped AgentDetailView, offscreen)")
  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("agent panel: \(name)") }
  }
  let scenes = agentScenes()
  var trees: [String: [String]] = [:]
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    for (name, scene) in scenes {
      let (window, container, hosting) = settled(AgentDetailView(presentation: scene), appearance: appearance)
      save(snapshot(container), "\(name)-\(mode).png")
      line("\(name)-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
      if container.bounds.width != 400 { failures.append("\(name)-\(mode) is not 400 pt wide") }
      if container.bounds.height > 560 { failures.append("\(name)-\(mode) exceeds 560 pt") }
      if trees[name] == nil { trees[name] = controlTitles(in: hosting) }
      if name == "agent-long" {
        let scroll = scrollViews(in: container).first
        let clip = scroll?.documentVisibleRect.height ?? 0
        let document = scroll?.documentView?.bounds.height ?? 0
        check(
          "the long agent panel (\(mode)) scrolls: \(Int(document)) pt of content in \(Int(clip)) pt", document > clip,
          &failures)
        check(
          "the long agent panel (\(mode)) keeps a visible scroller",
          scroll?.verticalScroller?.isHidden == false && scroll?.verticalScroller is ListScroller, &failures)
      }
      _ = window
    }
    let (window, container, _) = settled(AgentPairFixture(presentation: agentPresentation(workingAgent)), appearance: appearance)
    save(snapshot(container), "agent-beside-popover-\(mode).png")
    line("agent-beside-popover-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
    check("the popover, the gap, and the agent panel sit side by side (\(mode))", container.bounds.width == 748, &failures)
    _ = window
  }
  line("")

  line("### What each session's panel holds (AgentDetailModel)")
  for (name, scene) in scenes {
    guard let model = scene.model else {
      line("- \(name): no session to show")
      continue
    }
    line("- \(name): \(model.statusAccessibilityLabel) | line: \(model.line ?? "none") | \(model.displayName) | \(model.topic) | \(model.pendingCountText) | listed \(model.pending.map(\.id)) | history \(historyText(model.history)) | link \(model.link?.absoluteString ?? "none")")
  }
  line("")
  let working = agentPresentation(workingAgent).model
  let stale = agentPresentation(staleAgent).model
  let blocked = agentPresentation(blockedAgent).model
  let none = agentPresentation(noStatusAgent, history: .available([])).model
  let unavailable = agentPresentation(workingAgent, history: .unavailable).model
  check("a working session reads Working, its update age, and its link", working?.state == "Working" && working?.updateAge == "2m ago" && working?.link != nil, &failures)
  check("a stale session carries the text marker Stale", stale?.staleMarker == "Stale" && (stale?.statusAccessibilityLabel.contains("Stale") == true), &failures)
  check("a blocked session reads Blocked in words", blocked?.state == "Blocked" && blocked?.isBlocked == true, &failures)
  check("a session with no status invents none", none?.state == "No status yet" && none?.updateAge == "No update yet" && none?.line == nil, &failures)
  check("Waiting on you holds only this session's pending decisions", working?.pending.map(\.id) == ["ap_1"], &failures)
  check("history keeps the server's order", working?.history.entries?.map(\.line) == agentHistoryFixture.map(\.line), &failures)
  check("a 200-character status line is not cut", agentPresentation(longAgent).model?.line?.count == 200, &failures)
  check("the long history keeps every entry", agentPresentation(longAgent, history: .available(longHistory)).model?.history.entries?.count == 20, &failures)
  check("a javascript link offers no control", agentPresentation(invalidLinkAgent).model?.link == nil, &failures)
  check("a relative link offers no control", agentPresentation(relativeLinkAgent).model?.link == nil, &failures)
  check("unavailable history is its own state and holds no rows", unavailable?.history == .unavailable && unavailable?.history.entries == nil, &failures)
  check("an empty history stays apart from unavailable history", none?.history == .available([]) && none?.history != unavailable?.history, &failures)
  check("a session not read yet stays apart from both", agentPresentation(workingAgent).model?.history != unavailable?.history && AgentDetailPresentation(content: .loading(workingAgent), refreshFailed: false, decisions: [], now: now).model?.history == .unread, &failures)
  check("unavailable history keeps the session's facts", unavailable?.state == working?.state && unavailable?.line == working?.line && unavailable?.displayName == working?.displayName && unavailable?.topic == working?.topic && unavailable?.pendingCountText == working?.pendingCountText && unavailable?.pending == working?.pending && unavailable?.link == working?.link, &failures)
  line("")

  line("### AppKit controls of each agent scene")
  for (name, _) in scenes where name != "agent-long" {
    line("- \(name): \((trees[name] ?? []).joined(separator: "; "))")
  }
  check("no agent scene holds a text field: nothing here sends a message to an agent", trees.values.allSatisfy { $0.allSatisfy { $0 == "button" } }, &failures)
  line("Plain and default SwiftUI buttons are not NSButton views, so this list does not count them. access.txt counts every control through the Accessibility API.")
  line("")
}

/// Reads nothing, and records each target the panel asked for.
private final class FixtureAgentReads: AgentDetailReads, @unchecked Sendable {
  private let lock = NSLock()
  private var generation = 0
  private var recorded: AgentDetailTarget?

  var last: AgentDetailTarget? { lock.withLock { recorded } }

  func showAgent(id: String) -> AgentDetailTarget {
    lock.withLock {
      generation += 1
      let target = AgentDetailTarget(id: id, generation: generation)
      recorded = target
      return target
    }
  }
  func hideAgent() {}
  func retryAgent() {}
}

private struct UnusedSender: AnswerSender {
  func answer(id: String, answer: Answer, note: String?) async throws(APIError) -> Decision { throw .transport("unused") }
  func decision(id: String) async throws(APIError) -> Decision { throw .transport("unused") }
}

/// The panel's two targets through the shipped `DecisionCoordinator`, with the
/// same key policy calls as `AppState.handle`.
@MainActor
@Observable
private final class AgentPairModel {
  @ObservationIgnored let coordinator: DecisionCoordinator
  @ObservationIgnored let reads = FixtureAgentReads()
  var revision = 0
  @ObservationIgnored var selected: String?
  @ObservationIgnored var sent: [String] = []
  @ObservationIgnored var opened: [URL] = []
  @ObservationIgnored var closePopover: () -> Void = {}
  @ObservationIgnored let rows = ["a", "b", "c"]

  init(record: Decision) {
    coordinator = DecisionCoordinator(
      sender: UnusedSender(), reader: FixtureReader(record: record), clock: ShortClock(), agentReads: reads)
    coordinator.agent.opener = { [weak self] in self?.opened.append($0) }
  }

  func handle(_ key: PopoverKey, editingText: Bool) -> Bool {
    let action = PopoverKeys.action(
      for: key, rows: rows, selected: selected, shown: coordinator.panelTarget,
      shownIsAnswerable: coordinator.shownIsAnswerable, editingText: editingText)
    switch action {
    case .select(let id): selected = id
    case .toggle(let id): coordinator.toggle(id)
    case .send(let id): sent.append(id)
    case .closePanel: coordinator.closePanel()
    case .passThrough:
      guard key == .escape else { return false }
      closePopover()
    }
    return true
  }
}

/// `DetailPanelRoot`'s choice between the two shipped views.
private struct AgentPairPanel: View {
  let model: AgentPairModel
  let record: Decision
  let maxHeight: CGFloat

  var body: some View {
    let _ = model.revision
    Group {
      if let content = model.coordinator.agent.content {
        AgentDetailView(
          presentation: AgentDetailPresentation(
            content: content, refreshFailed: model.coordinator.agent.refreshFailed, decisions: agentPendingFixture, now: now),
          maxHeight: maxHeight,
          actions: AgentDetailActions(
            openDecision: { model.coordinator.show($0) }, close: { model.coordinator.closePanel() },
            openLink: { model.coordinator.agent.openLink() }))
      } else if model.coordinator.detail.shownID != nil {
        DecisionDetailView(presentation: presentation(record), maxHeight: maxHeight)
      }
    }
    .background(PopoverKeyObserver(controlsKeepArrows: true) { model.handle($0, editingText: $1) })
  }
}

/// The agent session in the real paired windows (req-mac-app AC-5.3, AC-11.1,
/// AC-11.5, AC-11.7, AC-11.8): transparent, inactive, and driven by events
/// posted to this process.
@MainActor
func agentPairedWindowEvidence(_ failures: inout [String]) {
  line("## Agent panel in the paired windows (a real NSPopover, the shipped panel, coordinator, lifetime, and key observer; posted events)")
  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("agent paired windows: \(name)") }
  }
  guard let screen = NSScreen.main else {
    line("not exercised: this session has no screen")
    return
  }
  let record = panelDecisions[1].1
  let model = AgentPairModel(record: record)
  let coordinator = model.coordinator
  let panel = DetailPanelController { AgentPairPanel(model: model, record: record, maxHeight: $0) }
  panel.window.alphaValue = 0

  let popover = NSPopover()
  let events = PopoverEvents()
  popover.behavior = .applicationDefined
  popover.animates = false
  popover.delegate = events
  let host = NSHostingController(
    rootView: PopoverFixture(items: items(decisions), expanded: false)
      .background(PopoverKeyObserver { model.handle($0, editingText: $1) }))
  host.sizingOptions = [.preferredContentSize]
  popover.contentViewController = host
  var popoverWindow: NSWindow? { host.view.window }

  func anchorWindow(atX x: CGFloat) -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: x, y: screen.visibleFrame.maxY - 20, width: 10, height: 10), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.orderFrontRegardless()
    return window
  }
  let statusWindow = anchorWindow(atX: screen.visibleFrame.minX + 40)
  let otherWindow = anchorWindow(atX: screen.visibleFrame.minX + 60)
  let anchor = anchorWindow(atX: screen.visibleFrame.minX + 200)
  let lifetime = PairedWindowLifetime(
    isOwned: { window in window === popoverWindow || window === panel.window },
    isStatusItem: { $0 === statusWindow },
    watchesOtherApps: false,
    close: { if popover.isShown { popover.performClose(nil) } })
  model.closePopover = { if popover.isShown { popover.performClose(nil) } }
  events.onWillShow = { lifetime.start() }
  events.onWillClose = { coordinator.closePanel() }
  events.onDidClose = { lifetime.stop() }

  var shownTarget: DetailPanelTarget?
  var hides = 0
  var targetChanges = 0
  coordinator.onDetailChange = {
    model.revision += 1
    let next = coordinator.panelTarget
    guard next != shownTarget else { return }
    shownTarget = next
    targetChanges += 1
    if next == nil {
      hides += 1
      panel.hide()
      panel.window.alphaValue = 0
    } else if popover.isShown {
      panel.present(beside: host.view, takesKeyFocus: false)
    }
  }
  func pair() -> Bool { popover.isShown && panel.isVisible }
  func open() {
    popover.show(relativeTo: anchor.contentView!.bounds, of: anchor.contentView!, preferredEdge: .minY)
    popoverWindow?.alphaValue = 0
    drain()
  }
  func load(_ session: AgentSession) {
    guard let target = model.reads.last else { return }
    coordinator.agent.apply(AgentDetailUpdate(target: target, outcome: .loaded(session, .available(agentHistoryFixture))))
    drain(0.2)
  }

  open()
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.3)
  check("clicking an entry opens the panel beside the popover", pair() && coordinator.panelTarget == .agent("ags_1"), &failures)
  let popoverFrame = popoverWindow?.convertToScreen(host.view.convert(host.view.bounds, to: nil)) ?? .zero
  check("the agent panel is 400 pt wide, 8 pt from the popover", panel.window.frame.width == 400 && panel.window.frame.minX == popoverFrame.maxX + 8, &failures)
  check("the tops meet", abs(panel.window.frame.maxY - popoverFrame.maxY) < 1, &failures)
  check("the panel has not taken key focus", !panel.window.isKeyWindow, &failures)
  load(workingAgent)
  check("the read's pair shows", coordinator.agent.session == workingAgent, &failures)
  check("no browser opened from an entry", model.opened.isEmpty, &failures)

  click(panel.window)
  check("a click in the agent panel keeps both", pair(), &failures)
  check("a click in the agent panel opens nothing", model.opened.isEmpty, &failures)
  if let window = popoverWindow { click(window) }
  check("a click in the popover keeps both", pair(), &failures)

  hides = 0
  coordinator.toggleAgent("ags_2", known: blockedAgent)
  drain(0.2)
  check("another entry replaces the session in the same panel", pair() && coordinator.panelTarget == .agent("ags_2") && hides == 0, &failures)
  coordinator.show("ap_2")
  drain(0.3)
  check("a pending decision replaces the session, and the panel never hides", pair() && coordinator.panelTarget == .decision("ap_2") && hides == 0, &failures)
  check("showing a decision ends the session's target", coordinator.agent.shownID == nil, &failures)
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  check("a session replaces the decision, and the panel never hides", pair() && coordinator.panelTarget == .agent("ags_1") && hides == 0, &failures)
  check("showing a session ends the decision's target", coordinator.detail.shownID == nil, &failures)
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  check("opening the shown session closes the panel and the popover stays", popover.isShown && !panel.isVisible && coordinator.panelTarget == nil, &failures)

  guard let keysPopover = popoverWindow else {
    failures.append("agent paired windows: the popover opened no window, so the keys were not checked")
    return
  }
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  model.selected = "c"
  press(returnKey, .command, in: panel.window)
  check("⌘↩ from the panel sends nothing on a session, and no row in its place", model.sent.isEmpty, &failures)
  press(returnKey, .command, in: keysPopover)
  check("⌘↩ from the popover sends nothing on a session, and no row in its place", model.sent.isEmpty, &failures)
  check("⌘↩ leaves the session shown", coordinator.panelTarget == .agent("ags_1"), &failures)
  press(downKey, in: panel.window)
  check("↓ from the agent panel leaves the selection at its end and the panel open", model.selected == "c" && pair(), &failures)
  press(returnKey, in: panel.window)
  check("↩ on a selected row replaces the session with that row", coordinator.panelTarget == .decision("c") && pair(), &failures)
  model.selected = nil
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  press(returnKey, in: keysPopover)
  check("↩ with no row selected closes the session's panel and the popover stays", coordinator.panelTarget == nil && popover.isShown, &failures)
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  press(escapeKey, in: panel.window)
  check("Escape closes the agent panel first and the popover stays", coordinator.panelTarget == nil && popover.isShown, &failures)
  press(escapeKey, in: keysPopover)
  drain()
  check("Escape again closes the popover", !popover.isShown, &failures)

  open()
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  click(otherWindow)
  check("a click in another window closes both", !popover.isShown && !panel.isVisible, &failures)
  check("closing the popover ends the session's target", coordinator.agent.shownID == nil, &failures)

  open()
  coordinator.toggleAgent("ags_1", known: workingAgent)
  drain(0.2)
  NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: nil)
  drain()
  check("the app's deactivation (posted) closes both", !popover.isShown && !panel.isVisible, &failures)

  check("the panel opened no browser in this section", model.opened.isEmpty, &failures)
  check("this process never became the active app, so the user's focus never moved", ActivationWatch.shared.count == 0 && !NSApp.isActive, &failures)
  anchor.orderOut(nil)
  statusWindow.orderOut(nil)
  otherWindow.orderOut(nil)
  line("")
}

// MARK: Linked recovery

/// A decision the list does not hold, answered through the shipped
/// `DecisionCoordinator`, which `AppState` delegates to. Only the sender, the
/// reader, and the clock are fixtures.
private final class ScriptedAnswers: AnswerSender, DecisionReader, @unchecked Sendable {
  private let lock = NSLock()
  private var failing = true
  private var posted = 0
  private var reads = 0
  private let record: Decision

  init(record: Decision) {
    self.record = record
  }

  var posts: Int { lock.withLock { posted } }
  var readCount: Int { lock.withLock { reads } }
  func setFailing(_ value: Bool) { lock.withLock { failing = value } }

  func answer(id: String, answer: Answer, note: String?) async throws(APIError) -> Decision {
    let fails = lock.withLock {
      posted += 1
      return failing
    }
    if fails { throw .transport("offline") }
    return record
  }

  func decision(id: String) async throws(APIError) -> Decision {
    let fails = lock.withLock {
      reads += 1
      return failing
    }
    if fails { throw .transport("offline") }
    return record
  }
}

/// Holds an answer until the harness flushes it, and refreshes nothing.
private struct HoldingClock: SyncClock {
  func sleep(seconds: TimeInterval) async throws { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
}

@MainActor
func linkedRecoveryEvidence(_ failures: inout [String]) {
  line("## Linked recovery (the shipped DecisionCoordinator with a fixture sender, reader, and clock)")
  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("linked recovery: \(name)") }
  }
  let linked = panelDecisions[3].1
  let visible = decisions.filter { $0.id == "d2" }
  let script = ScriptedAnswers(record: linked)
  script.setFailing(false)
  let coordinator = DecisionCoordinator(sender: script, reader: script, clock: HoldingClock())
  coordinator.applySnapshot(visible, isNewRead: true)
  coordinator.show(linked.id)
  RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  check("a pending decision absent from the list loads in the panel", coordinator.detail.decision == linked, &failures)
  coordinator.drafts[linked.id]?.text = "agentdesk-kit"
  coordinator.drafts[linked.id]?.note = "It matches the repository."
  let readsBefore = script.readCount

  func saveRender(_ view: NSView, _ name: String) { save(snapshot(view), name) }
  func savePopover(_ name: String, undo: String? = nil, _ failures: inout [String]) {
    for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
      let fixture = PopoverFixture(
        items: items(coordinator.listed, failures: coordinator.pending.failures), expanded: false, undoText: undo)
      let (window, container) = host(fixture, appearance: appearance, background: .vibrant)
      saveRender(container, "\(name)-\(mode).png")
      line("\(name)-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
      if container.bounds.width != 340 || container.bounds.height > 560 {
        failures.append("\(name)-\(mode) exceeds 340 x 560 pt")
      }
      _ = window
    }
  }

  // Undo: the row, the draft, and the panel return with no read or send.
  coordinator.send(linked.id)
  check("answering closes the panel and hides the row", coordinator.detail.shownID == nil && coordinator.listed.map(\.id) == ["d2"], &failures)
  savePopover("popover-linked-held", undo: coordinator.pending.undoText, &failures)
  coordinator.undo()
  check("Undo restores the row", coordinator.listed.contains { $0.id == linked.id }, &failures)
  check("Undo reopens the panel from the held record", coordinator.detail.shownID == linked.id && coordinator.detail.decision == linked, &failures)
  check("Undo keeps the draft and note", coordinator.drafts[linked.id]?.note == "It matches the repository." && coordinator.drafts[linked.id]?.text == "agentdesk-kit", &failures)
  RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  check("Undo reads nothing and sends nothing", script.readCount == readsBefore && script.posts == 0, &failures)

  // A failed send, a failed list read, and a publish of the retained snapshot.
  script.setFailing(true)
  coordinator.send(linked.id)
  coordinator.pending.flush()
  runAsync { _ = await coordinator.pending.flushAndWait() }
  check("a failed send restores the row at once", coordinator.listed.contains { $0.id == linked.id }, &failures)
  check("a failed send keeps the failure message", coordinator.pending.failures[linked.id] == PendingAnswers.failureMessage, &failures)
  check("a failed send keeps the draft and note", coordinator.drafts[linked.id]?.note == "It matches the repository." && coordinator.drafts[linked.id]?.text == "agentdesk-kit", &failures)
  coordinator.applySnapshot(visible, isNewRead: false)
  check("a retained-snapshot publish prunes nothing", coordinator.pending.failures[linked.id] != nil && coordinator.drafts[linked.id] != nil && coordinator.listed.contains { $0.id == linked.id }, &failures)
  coordinator.applySnapshot(visible, isNewRead: true)
  RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  check("a new read with a failed direct read prunes nothing", coordinator.pending.failures[linked.id] != nil && coordinator.drafts[linked.id] != nil && coordinator.listed.contains { $0.id == linked.id }, &failures)
  savePopover("popover-linked-send-failed", &failures)
  coordinator.toggle(linked.id)
  let retry = DetailPanelPresentation(
    content: .loaded(panelModel(linked), linked), failure: coordinator.pending.failures[linked.id])
  check("the restored row opens the retained record", coordinator.detail.decision == linked && coordinator.shownIsAnswerable, &failures)
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    // The shipped view reads the restored draft, as `DetailPanelRoot` binds it.
    let restored = DecisionDetailActions(draft: { .constant(coordinator.drafts[$0.id] ?? .forPanel($0)) })
    let (window, container, _) = settled(
      PanelFixture(presentation: retry, actions: restored), appearance: appearance)
    saveRender(container, "panel-linked-send-failed-\(mode).png")
    line("panel-linked-send-failed-\(mode).png: \(Int(container.bounds.width))x\(Int(container.bounds.height)) pt")
    _ = window
  }

  // The retry lands once.
  script.setFailing(false)
  let posts = script.posts
  coordinator.send(linked.id)
  runAsync { _ = await coordinator.pending.flushAndWait() }
  check("the retry posts once", script.posts == posts + 1, &failures)
  check("a landed retry leaves no record, draft, or message", coordinator.retainedIDs.isEmpty && coordinator.drafts[linked.id] == nil && coordinator.pending.failures[linked.id] == nil, &failures)
  coordinator.reset()
  check("sign-out leaves nothing", coordinator.listed.isEmpty && coordinator.drafts.isEmpty, &failures)
  line("AppState delegates its list, panel, drafts, answers, and Undo to this object; its own wiring is compiled by the Xcode build and is not run here.")
  line("")
}

// MARK: The panel's height

/// What the panel shows in the height check, as `AppState` publishes it.
@MainActor
@Observable
private final class PanelHeightModel {
  var agent: AgentDetailPresentation?
  var decision: DetailPanelPresentation?
}

/// The shipped views in the shape of the app's `DetailPanelRoot`, which needs
/// `AppState`: one group over both kinds with the key observer behind it.
private struct PanelHeightRoot: View {
  let model: PanelHeightModel
  let maxHeight: CGFloat

  var body: some View {
    Group {
      if let presentation = model.agent {
        AgentDetailView(presentation: presentation, maxHeight: maxHeight)
      } else if let presentation = model.decision {
        DecisionDetailView(presentation: presentation, maxHeight: maxHeight)
      }
    }
    .background(PopoverKeyObserver(controlsKeepArrows: true) { _, _ in false })
  }
}

/// A SwiftUI button standing for a list row, so a target can change inside a
/// SwiftUI action as a row's click changes it.
@MainActor
private final class PanelHeightRow {
  var action: () -> Void = {}
}

private struct PanelHeightRowView: View {
  let row: PanelHeightRow

  var body: some View {
    // The whole label is the button, so a posted click lands on it anywhere.
    Button {
      row.action()
    } label: {
      Color.clear
        .frame(width: 340, height: 400)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// One reading of the shipped panel's window and views. Every value comes from
/// AppKit frames, and `preferredHeight` is reported only, so the checks never
/// compare the window with the value the controller read.
private struct PanelHeightSample: Equatable {
  var windowHeight: CGFloat
  var hostHeight: CGFloat
  var preferredHeight: CGFloat
  /// Window top to the top of the header's close control.
  var headerTopGap: CGFloat
  /// Top of the close control to the top of the scrolling body.
  var headerBlock: CGFloat
  /// Bottom of the scrolling body to the window's bottom.
  var bottomGap: CGFloat
  /// The scrolling body's document, its padding included.
  var naturalBodyHeight: CGFloat
  var viewportHeight: CGFloat
  var clipOffset: CGFloat
  var hasBody: Bool

  var text: String {
    func f(_ value: CGFloat) -> String { String(format: "%.1f", value) }
    return "window \(f(windowHeight)), host \(f(hostHeight)), preferred \(f(preferredHeight)), header top \(f(headerTopGap)), header block \(f(headerBlock)), bottom \(f(bottomGap)), body \(f(naturalBodyHeight)), viewport \(f(viewportHeight)), clip \(f(clipOffset))"
  }

  /// The height the panel's parts add up to when nothing overflows: the gap
  /// above the close control, the header block, and the document's height.
  var contentHeight: CGFloat { headerTopGap + headerBlock + naturalBodyHeight }
}

@MainActor
private func allSubviews(of view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(allSubviews)
}

@MainActor
private func panelBody(in window: NSWindow) -> NSScrollView? {
  (window.contentView.map(allSubviews) ?? []).compactMap { $0 as? NSScrollView }.first
}

@MainActor
private func panelHeightSample(_ window: NSWindow) -> PanelHeightSample {
  let views = window.contentView.map(allSubviews) ?? []
  let host = window.contentView?.subviews.first
  let scroll = panelBody(in: window)
  let close = views.compactMap { $0 as? NSButton }.first { $0.enclosingScrollView == nil }
  let height = window.frame.height
  let closeTop = close.map { $0.convert($0.bounds, to: nil).maxY } ?? 0
  let scrollFrame = scroll.map { $0.convert($0.bounds, to: nil) } ?? .zero
  return PanelHeightSample(
    windowHeight: height, hostHeight: host?.frame.height ?? 0,
    preferredHeight: (host?.nextResponder as? NSViewController)?.preferredContentSize.height ?? -1,
    headerTopGap: height - closeTop, headerBlock: closeTop - scrollFrame.maxY, bottomGap: scrollFrame.minY,
    naturalBodyHeight: scroll?.documentView?.frame.height ?? 0, viewportHeight: scrollFrame.height,
    clipOffset: scroll?.contentView.bounds.minY ?? 0, hasBody: scroll != nil && close != nil)
}

/// Runs the event loop until the panel's readings hold still for `still`
/// seconds, and returns each distinct reading on the way. `converged` is false
/// when `limit` passes first.
@MainActor
private func settlePanel(
  _ window: NSWindow, limit: TimeInterval = 2, still: TimeInterval = 0.3
) -> (samples: [PanelHeightSample], converged: Bool) {
  var samples = [panelHeightSample(window)]
  let start = Date()
  var lastChange = start
  while Date().timeIntervalSince(start) < limit {
    if let event = NSApp.nextEvent(
      matching: .any, until: Date().addingTimeInterval(0.005), inMode: .default, dequeue: true)
    {
      NSApp.sendEvent(event)
    }
    let sample = panelHeightSample(window)
    if sample != samples.last {
      samples.append(sample)
      lastChange = Date()
    } else if Date().timeIntervalSince(lastChange) >= still {
      return (samples, true)
    }
  }
  return (samples, false)
}

/// The panel's height and header through one retained shipped
/// `DetailPanelController` (component-mac-app §Detail panel; req-mac-app
/// AC-11.1, AC-11.9). The windows are fully transparent and the app stays
/// inactive, as in the paired-window section.
@MainActor
func panelHeightEvidence(_ failures: inout [String]) {
  line("## The panel's height (one retained shipped DetailPanelController, its window and views read from AppKit frames)")
  guard let screen = NSScreen.main else {
    // A skipped check must not read as a pass.
    line("FAIL not exercised: this session has no screen")
    failures.append("panel height: this session has no screen")
    return
  }
  // The header pads its close control 8 pt from its top, and the control sits
  // up to 3 pt lower when a name's baseline aligns it. Ordinary frame rounding
  // gets at most 1 pt. Layout gets 2 s to hold still for 0.3 s.
  let headerTop: ClosedRange<CGFloat> = 7...12
  let tolerance: CGFloat = 1
  line("tolerances: frames within \(Int(tolerance)) pt; the close control's top \(Int(headerTop.lowerBound))...\(Int(headerTop.upperBound)) pt below the window's top; layout holds still for 0.3 s within 2 s")

  let model = PanelHeightModel()
  let panel = DetailPanelController { PanelHeightRoot(model: model, maxHeight: $0) }
  panel.window.alphaValue = 0
  let visible = screen.visibleFrame
  let anchorSize = NSSize(width: 340, height: 400)
  let anchorWindow = NSWindow(
    contentRect: NSRect(origin: NSPoint(x: visible.minX + 40, y: visible.maxY - 420), size: anchorSize),
    styleMask: [.borderless], backing: .buffered, defer: false)
  anchorWindow.alphaValue = 0
  anchorWindow.ignoresMouseEvents = true
  anchorWindow.orderFrontRegardless()
  let anchor = anchorWindow.contentView!

  enum Shown {
    case agent(AgentDetailPresentation)
    case decision(DetailPanelPresentation)
  }
  func apply(_ shown: Shown) {
    switch shown {
    case .agent(let presentation):
      model.decision = nil
      model.agent = presentation
    case .decision(let presentation):
      model.agent = nil
      model.decision = presentation
    }
  }
  /// As `AppState` does on a new target: publishes it, then tells the controller.
  func present(_ shown: Shown) {
    apply(shown)
    panel.present(beside: anchor, takesKeyFocus: false)
  }

  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("panel height: \(name)") }
  }

  /// Every reading on the way keeps the header at the window's top, the layout
  /// holds still in time, and the last reading fits what the panel shows.
  func verify(
    _ name: String, overflows: Bool = false, expectsBody: Bool = true, _ failures: inout [String], _ change: () -> Void
  ) {
    change()
    let (samples, converged) = settlePanel(panel.window)
    // The 560 pt limit, or the space below the anchor's top on a smaller screen.
    let cap = min(CGFloat(DetailPanelPlacement.maxHeight), min(anchorWindow.frame.maxY, visible.maxY) - visible.minY)
    let last = samples.last!
    line("\(name): \(samples.count) readings; settled \(last.text)")
    check("\(name): layout holds still within 2 s", converged, &failures)
    // Without the close control and the scrolling body, the checks below would
    // compare zeros and pass.
    if expectsBody { check("\(name): the close control and the scrolling body exist", last.hasBody, &failures) }
    // A former target's height cannot move the window once it reaches this one's.
    let arrived = samples.firstIndex { abs($0.windowHeight - last.windowHeight) <= tolerance } ?? 0
    check("\(name): no later reading moves the window from its height", samples[arrived...].allSatisfy { abs($0.windowHeight - last.windowHeight) <= tolerance }, &failures)
    let shifted = samples.filter { $0.hasBody && !headerTop.contains($0.headerTopGap) }
    for sample in shifted { line("  header away from the top: \(sample.text)") }
    check("\(name): the header stays at the window's top in every reading", shifted.isEmpty, &failures)
    check("\(name): the body ends at the window's bottom", abs(last.bottomGap) <= tolerance, &failures)
    check("\(name): the window is 400 pt wide", panel.window.frame.width == CGFloat(DetailPanelPlacement.width), &failures)
    if overflows {
      check("\(name): the body is taller than its viewport", last.naturalBodyHeight > last.viewportHeight + tolerance, &failures)
      check("\(name): the window stops at the \(Int(cap)) pt limit", abs(last.windowHeight - cap) <= tolerance, &failures)
      let scroller = panelBody(in: panel.window)?.verticalScroller
      check("\(name): the overflowing body shows its scroller", scroller.map { !$0.isHidden && $0.knobProportion < 1 } ?? false, &failures)
    } else {
      check("\(name): the window's height matches header plus body", abs(last.windowHeight - last.contentHeight) <= tolerance, &failures)
      check("\(name): the viewport holds the whole body", abs(last.viewportHeight - last.naturalBodyHeight) <= tolerance, &failures)
    }
    check("\(name): the body starts at its top", abs(last.clipOffset) <= tolerance, &failures)
  }

  /// Scrolls the shown body to its end, so a replacement has to reset it.
  func scrollToEnd(_ name: String, _ failures: inout [String]) {
    guard let scroll = panelBody(in: panel.window), let document = scroll.documentView else { return }
    scroll.contentView.scroll(to: NSPoint(x: 0, y: document.frame.height - scroll.contentView.bounds.height))
    scroll.reflectScrolledClipView(scroll.contentView)
    drain(0.1)
    check("\(name): the body has scrolled before its replacement", panelHeightSample(panel.window).clipOffset > tolerance, &failures)
  }

  let longDecisionTwo = decision([
    "id": "dp_long2", "title": "A second long decision that replaces the first.", "agent_session_id": "ags_2",
    "body": longBody, "recommendation": ["kind": "approve"],
  ])
  let longAgentTwo = session([
    "id": "ags_8", "display_name": "Codex · a second long session", "topic": "web", "line": "A second long session.",
  ])
  let agentLoading = Shown.agent(AgentDetailPresentation(content: .loading(nil), refreshFailed: false, decisions: [], now: now))
  let agentLoadingSeed = Shown.agent(AgentDetailPresentation(content: .loading(staleAgent), refreshFailed: false, decisions: [], now: now))
  let agentShort = Shown.agent(agentPresentation(staleAgent, history: .available([])))
  let agentOtherShort = Shown.agent(agentPresentation(noStatusAgent, history: .available([])))
  let agentTall = Shown.agent(agentPresentation(longAgent, history: .available(longHistory)))
  let agentTallTwo = Shown.agent(agentPresentation(longAgentTwo, history: .available(longHistory)))
  // Shorter than the limit, as the session before the build 359 report was.
  let agentMiddle = Shown.agent(agentPresentation(workingAgent, history: .available(Array(longHistory.prefix(3)))))
  let decisionLoading = Shown.decision(DetailPanelPresentation(content: .loading))
  let decisionShort = Shown.decision(presentation(panelDecisions[0].1))
  let decisionOtherShort = Shown.decision(presentation(settledFixtures[3].1))
  let decisionTall = Shown.decision(presentation(longDecision))
  let decisionTallTwo = Shown.decision(presentation(longDecisionTwo))

  // Loading to loaded, short and overflowing, in both kinds.
  verify("agent opens loading", &failures) { present(agentLoading) }
  verify("agent loading to short", &failures) { apply(agentShort) }
  verify("agent replaced by a seeded loading", &failures) { present(agentLoadingSeed) }
  verify("agent seeded loading to overflowing", overflows: true, &failures) { apply(agentTall) }
  // A tall target replaced by a distinct short one.
  verify("overflowing agent replaced by loading", &failures) { present(agentLoading) }
  verify("that loading to short", &failures) { apply(agentOtherShort) }
  verify("agent grows to overflowing", overflows: true, &failures) { apply(agentTall) }
  verify("overflowing agent replaced by a seeded loading", &failures) { present(agentLoadingSeed) }
  verify("that seeded loading to short", &failures) { apply(agentShort) }
  verify("agent grows short of the limit", &failures) { apply(agentMiddle) }
  verify("agent short of the limit replaced by a seeded loading", &failures) { present(agentLoadingSeed) }
  verify("agent overflowing again", overflows: true, &failures) { apply(agentTall) }
  scrollToEnd("agent", &failures)
  verify("a scrolled agent replaced by another overflowing agent starts at its top", overflows: true, &failures) { present(agentTallTwo) }

  // A tall target closed, and a short one opened in the same panel.
  verify("agent closes", expectsBody: false, &failures) {
    model.agent = nil
    panel.hide()
  }
  verify("agent reopens loading after a tall one", &failures) { present(agentLoading) }
  verify("agent grows again", overflows: true, &failures) { apply(agentTall) }

  // The other kind replaces it, then the same transitions.
  verify("overflowing agent replaced by a decision loading", &failures) { present(decisionLoading) }
  verify("decision loading to short", &failures) { apply(decisionShort) }
  verify("decision grows to overflowing", overflows: true, &failures) { apply(decisionTall) }
  verify("overflowing decision replaced by loading", &failures) { present(decisionLoading) }
  verify("decision loading to overflowing", overflows: true, &failures) { apply(decisionTall) }
  scrollToEnd("decision", &failures)
  verify("a scrolled decision replaced by another overflowing decision starts at its top", overflows: true, &failures) { present(decisionTallTwo) }
  verify("overflowing decision replaced by a short one", &failures) { present(decisionOtherShort) }
  verify("decision grows to overflowing again", overflows: true, &failures) { apply(decisionTall) }
  verify("overflowing decision replaced by an agent loading", &failures) { present(agentLoading) }

  // A change inside a SwiftUI action, as a row's click makes it. SwiftUI runs
  // the panel's update after the action, so the controller's first placement
  // reads the former target's height.
  let row = PanelHeightRow()
  let rowHost = NSHostingView(rootView: PanelHeightRowView(row: row))
  rowHost.frame = anchor.bounds
  anchor.addSubview(rowHost)
  // Only for this section: a window this transparent passes the Mac user's own
  // clicks through.
  anchorWindow.ignoresMouseEvents = false
  drain(0.2)
  func clickRow() {
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      NSApp.postEvent(
        NSEvent.mouseEvent(
          with: type, location: NSPoint(x: anchorSize.width / 2, y: anchorSize.height / 2), modifierFlags: [],
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: anchorWindow.windowNumber, context: nil,
          eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
    }
  }
  for (name, tall, short) in [("agent", agentMiddle, agentLoadingSeed), ("decision", decisionTall, decisionLoading)] {
    verify("\(name) tall before a row's click", overflows: name == "decision", &failures) { present(tall) }
    var inAction: PanelHeightSample?
    row.action = {
      present(short)
      inAction = panelHeightSample(panel.window)
    }
    verify("\(name): a row's click replaces it with a short loading", &failures) { clickRow() }
    if let inAction {
      line("  inside the click, before SwiftUI's update: \(inAction.text)")
      if inAction.hasBody {
        check("\(name): the header stays at the window's top inside the click", headerTop.contains(inAction.headerTopGap), &failures)
      }
    }
    check("\(name): the click reached the row", inAction != nil, &failures)
  }

  model.agent = nil
  model.decision = nil
  panel.hide()
  drain(0.3)
  var reopened: PanelHeightSample?
  row.action = {
    present(agentLoadingSeed)
    reopened = panelHeightSample(panel.window)
  }
  verify("a row's click reopens the panel on a short loading", &failures) { clickRow() }
  if let reopened {
    line("  inside the click, before SwiftUI's update: \(reopened.text)")
    if reopened.hasBody {
      check("reopening: the header stays at the window's top inside the click", headerTop.contains(reopened.headerTopGap), &failures)
    }
  }
  check("reopening: the click reached the row", reopened != nil, &failures)
  anchorWindow.ignoresMouseEvents = true
  rowHost.removeFromSuperview()

  // A window taller than its content never centers the content: the operator's
  // report. A constraint on the material, above the hosting view's own, holds the
  // window 240 pt too tall, so the state lasts long enough to read before any placement runs.
  for (name, loading, short) in [("agent", agentLoading, agentShort), ("decision", decisionLoading, decisionShort)] {
    for (state, shown) in [("loading", loading), ("short", short)] {
      verify("\(name) \(state) before an oversized window", &failures) { present(shown) }
      let content = panel.window.frame.height
      guard let material = panel.window.contentView else { continue }
      let hold = material.heightAnchor.constraint(equalToConstant: content + 240)
      hold.priority = NSLayoutConstraint.Priority(600)
      hold.isActive = true
      var frame = panel.window.frame
      frame.origin.y -= 240
      frame.size.height += 240
      panel.window.setFrame(frame, display: false)
      panel.window.layoutIfNeeded()
      material.layoutSubtreeIfNeeded()
      let oversized = panelHeightSample(panel.window)
      line("\(name) \(state) held 240 pt too tall: \(oversized.text)")
      check("\(name) \(state): the host is held taller than its content", oversized.hostHeight >= content + 240 - tolerance, &failures)
      check("\(name) \(state): the header stays at the top of the oversized window", headerTop.contains(oversized.headerTopGap), &failures)
      hold.isActive = false
      verify("\(name) \(state) after the oversized window", &failures) { panel.place() }
      check("\(name) \(state): the window returns to its content", abs(panel.window.frame.height - content) <= tolerance, &failures)
    }
  }

  // Placement, in the same retained controller, moved by the anchor's own window.
  func placementChecks(_ name: String, side: DetailPanelPlacement.Side, _ failures: inout [String]) {
    let anchorFrame = anchorWindow.frame
    let frame = panel.window.frame
    line("\(name): anchor \(Int(anchorFrame.minX))...\(Int(anchorFrame.maxX)), top \(Int(anchorFrame.maxY)); panel \(Int(frame.minX))...\(Int(frame.maxX)), top \(Int(frame.maxY)), height \(Int(frame.height))")
    let gap = side == .right ? frame.minX - anchorFrame.maxX : anchorFrame.minX - frame.maxX
    check("\(name): 8 pt from the anchor on the \(side)", abs(gap - CGFloat(DetailPanelPlacement.gap)) <= tolerance, &failures)
    check("\(name): the tops meet", abs(frame.maxY - anchorFrame.maxY) <= tolerance, &failures)
    check("\(name): inside the visible frame", frame.minX >= visible.minX && frame.maxX <= visible.maxX && frame.minY >= visible.minY, &failures)
  }
  verify("short target at the left of the screen", &failures) { present(agentShort) }
  placementChecks("left end", side: .right, &failures)
  verify("short target at the right of the screen", &failures) {
    anchorWindow.setFrameOrigin(NSPoint(x: visible.maxX - anchorSize.width - 40, y: anchorWindow.frame.minY))
  }
  placementChecks("right end", side: .left, &failures)
  verify("overflowing target at the right of the screen", overflows: true, &failures) { apply(decisionTall) }
  placementChecks("right end, overflowing", side: .left, &failures)
  let reduced: CGFloat = 300
  verify("overflowing target with \(Int(reduced)) pt below its top", overflows: true, &failures) {
    anchorWindow.setFrameOrigin(NSPoint(x: visible.minX + 40, y: visible.minY + reduced - anchorSize.height))
  }
  placementChecks("reduced height", side: .right, &failures)
  verify("short target with \(Int(reduced)) pt below its top", &failures) { present(agentLoading) }
  placementChecks("reduced height, short", side: .right, &failures)
  verify("that loading to short with \(Int(reduced)) pt below its top", &failures) { apply(agentOtherShort) }
  placementChecks("reduced height, loaded short", side: .right, &failures)
  anchorWindow.setFrameOrigin(NSPoint(x: visible.minX + 40, y: visible.maxY - 420))
  drain(0.1)

  // Supporting renders of the retained panel, after a tall target. The checks
  // above are the assertions.
  for (appearance, mode) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    panel.window.appearance = NSAppearance(named: appearance)
    for (name, tall, short) in [("agent", agentTall, agentLoadingSeed), ("decision", decisionTall, decisionLoading)] {
      present(tall)
      _ = settlePanel(panel.window)
      present(short)
      _ = settlePanel(panel.window)
      if let view = panel.window.contentView { save(snapshot(view), "panel-height-\(name)-loading-after-tall-\(mode).png") }
    }
  }
  model.agent = nil
  model.decision = nil
  panel.hide()
  anchorWindow.orderOut(nil)
  drain(0.1)
  check("the panel-height section never made this process the active app", !NSApp.isActive, &failures)
  line("NOT EXERCISED, assigned to the operator's pre-release checks: the panel's height and header in the installed app, on real screens, beside a real status item's popover, with physical clicks. This section reads transparent windows while the app stays inactive, through a root with the shape of DetailPanelRoot.")
  line("")
}

// MARK: The panel across later clicks

/// A read that answers about as late as a real one.
private struct SequenceReader: DecisionReader {
  let records: [String: Decision]
  func decision(id: String) async throws(APIError) -> Decision {
    try? await Task.sleep(nanoseconds: 250_000_000)
    guard let record = records[id] else { throw .transport("unused") }
    return record
  }
}

/// Nothing in this section waits for a refresh.
private struct SequenceClock: SyncClock {
  func sleep(seconds: TimeInterval) async throws { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
}

/// The shipped coordinator behind the panel, as `AppState` holds it.
@MainActor
@Observable
private final class PanelSequenceModel {
  @ObservationIgnored let coordinator: DecisionCoordinator
  @ObservationIgnored let reads = FixtureAgentReads()
  var revision = 0

  init(records: [String: Decision]) {
    coordinator = DecisionCoordinator(
      sender: UnusedSender(), reader: SequenceReader(records: records), clock: SequenceClock(), agentReads: reads)
  }

  var decisionPresentation: DetailPanelPresentation? {
    guard let content = coordinator.detail.content, coordinator.detail.shownID != nil else { return nil }
    switch content {
    case .loading: return DetailPanelPresentation(content: .loading)
    case .unavailable: return DetailPanelPresentation(content: .unavailable)
    case .failed: return DetailPanelPresentation(content: .failed)
    case .loaded(let decision): return presentation(decision)
    }
  }
}

/// The shipped views in the shape of the app's `DetailPanelRoot`.
private struct PanelSequenceRoot: View {
  let model: PanelSequenceModel
  let maxHeight: CGFloat

  var body: some View {
    let _ = model.revision
    Group {
      if let content = model.coordinator.agent.content {
        AgentDetailView(
          presentation: AgentDetailPresentation(
            content: content, refreshFailed: model.coordinator.agent.refreshFailed, decisions: agentPendingFixture, now: now),
          maxHeight: maxHeight)
      } else if let presentation = model.decisionPresentation {
        DecisionDetailView(presentation: presentation, maxHeight: maxHeight)
      }
    }
    .background(PopoverKeyObserver(controlsKeepArrows: true) { _, _ in false })
  }
}

/// The row a click lands on: a SwiftUI button in the popover, so the target
/// changes inside a SwiftUI action, as `AgentEntry` and `DecisionRow` change it.
private struct PanelSequenceRow: View {
  let row: PanelHeightRow

  var body: some View {
    Button {
      row.action()
    } label: {
      Color.clear
        .frame(width: 340, height: 300)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// The identifier AppKit gives the height constraint it installs for a view
/// controller's `preferredContentSize`.
private let preferredHeightIdentifier = "NSViewController.preferredContentSize.height"
/// The priority AppKit gives that constraint.
private let preferredHeightPriority = NSLayoutConstraint.Priority(501)
/// The priority the injected condition holds it at.
private let heldHeightPriority = NSLayoutConstraint.Priority(1)

/// Every height constraint on `view` that could size it by itself, whatever its
/// identifier, so a renamed constraint is still seen.
@MainActor
private func equalHeightConstraints(on view: NSView) -> [NSLayoutConstraint] {
  view.constraints.filter {
    ($0.firstItem as? NSView) === view && $0.firstAttribute == .height && $0.secondItem == nil && $0.relation == .equal
  }
}

/// Why `view` does not hold AppKit's height constraint exactly as expected, or
/// nil when it does. A missing, renamed, or altered constraint is a problem, so
/// the injected case cannot pass without being exercised.
@MainActor
private func preferredHeightProblem(on view: NSView, priority: NSLayoutConstraint.Priority) -> String? {
  let named = view.constraints.filter { $0.identifier == preferredHeightIdentifier }
  guard named.count == 1, let constraint = named.first else {
    return "\(named.count) constraints named \(preferredHeightIdentifier), \(equalHeightConstraints(on: view).count) equal height constraints"
  }
  guard (constraint.firstItem as? NSView) === view else { return "its first item is not the hosting view" }
  guard constraint.firstAttribute == .height else { return "its first attribute is not height" }
  guard constraint.secondItem == nil, constraint.secondAttribute == .notAnAttribute else { return "it has a second item" }
  guard constraint.relation == .equal else { return "its relation is not equal" }
  guard constraint.multiplier == 1 else { return "its multiplier is not 1" }
  guard constraint.priority == priority else { return "its priority is \(constraint.priority.rawValue), not \(priority.rawValue)" }
  return nil
}

/// Why `view` holds a constraint that corrected source must not have, or nil.
@MainActor
private func heightConstraintPresence(on view: NSView) -> String? {
  let named = view.constraints.filter { $0.identifier == preferredHeightIdentifier }
  let equal = equalHeightConstraints(on: view)
  return named.isEmpty && equal.isEmpty ? nil : "\(named.count) named, \(equal.count) equal height constraints"
}

/// The two checks above on views built here, so neither can pass by reading
/// nothing: a missing or renamed constraint fails, and so does a present one.
@MainActor
private func heightConstraintSelfCheck(_ check: (String, Bool) -> Void) {
  func view(_ identifier: String?, attribute: NSLayoutConstraint.Attribute = .height, priority: NSLayoutConstraint.Priority = preferredHeightPriority) -> NSView {
    let view = NSView()
    if let identifier {
      let constraint = NSLayoutConstraint(
        item: view, attribute: attribute, relatedBy: .equal, toItem: nil, attribute: .notAnAttribute, multiplier: 1,
        constant: 100)
      constraint.identifier = identifier
      constraint.priority = priority
      view.addConstraint(constraint)
    }
    return view
  }
  check("the matcher accepts AppKit's constraint as expected", preferredHeightProblem(on: view(preferredHeightIdentifier), priority: preferredHeightPriority) == nil)
  check("the matcher fails a missing constraint", preferredHeightProblem(on: view(nil), priority: preferredHeightPriority) != nil)
  check("the matcher fails a renamed constraint", preferredHeightProblem(on: view("renamed"), priority: preferredHeightPriority) != nil)
  check("the matcher fails a constraint on another attribute", preferredHeightProblem(on: view(preferredHeightIdentifier, attribute: .width), priority: preferredHeightPriority) != nil)
  check("the matcher fails a constraint at another priority", preferredHeightProblem(on: view(preferredHeightIdentifier, priority: heldHeightPriority), priority: preferredHeightPriority) != nil)
  check("the absence check accepts no constraint", heightConstraintPresence(on: view(nil)) == nil)
  check("the absence check fails AppKit's constraint", heightConstraintPresence(on: view(preferredHeightIdentifier)) != nil)
  check("the absence check fails a renamed constraint", heightConstraintPresence(on: view("renamed")) != nil)
}

/// A first click and later clicks on other targets, through the shipped
/// `DecisionCoordinator`, a real `NSPopover`, and the shipped controller, with a
/// read answering 250 ms after each click (req-mac-app AC-5.3, AC-11.1, AC-11.5;
/// component-mac-app §Detail panel). The windows are fully transparent, ignore
/// the Mac user's clicks, and the app stays inactive.
///
/// Each kind runs twice. The second run holds down the height constraint AppKit
/// installs for `preferredContentSize`, because that constraint hides what the
/// controller itself does: a later click's only placement reads the former
/// target's height. With the constraint at work the window settles anyway in
/// these transparent windows, and the operator's report on the installed app
/// says it does not settle there. With the correction the constraint does not
/// exist, so this run changes nothing.
///
/// `expectsUnfixedPanel` states which source this program was built with, so a
/// missing constraint is never taken as proof of corrected source. On corrected
/// source, which `run.sh` builds, each click asserts the constraint is absent. On
/// base source, which only `--unfixed-panel` declares, each click asserts its
/// identity and attributes, and the held run asserts the injection was applied
/// and persists.
@MainActor
func panelLaterClicksEvidence(expectsUnfixedPanel: Bool = false, _ failures: inout [String]) {
  line("## The panel across later clicks (the shipped coordinator and controller, a real NSPopover, a click inside a SwiftUI action, a read after 250 ms)")
  guard let screen = NSScreen.main else {
    line("FAIL not exercised: this session has no screen")
    failures.append("later clicks: this session has no screen")
    return
  }
  let headerTop: ClosedRange<CGFloat> = 7...12
  let tolerance: CGFloat = 1
  line("tolerances: frames within \(Int(tolerance)) pt; the close control's top \(Int(headerTop.lowerBound))...\(Int(headerTop.upperBound)) pt below the window's top; layout holds still for 0.3 s within 2 s")
  func check(_ name: String, _ passed: Bool, _ failures: inout [String]) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failures.append("later clicks: \(name)") }
  }

  line("declared panel source: \(expectsUnfixedPanel ? "unfixed, by --unfixed-panel" : "corrected")")
  heightConstraintSelfCheck { name, passed in check(name, passed, &failures) }

  let longLine = String(repeating: "The migration rewrites every row of the events table. ", count: 3)
  func agent(_ id: String, _ text: String, link: String? = nil) -> AgentSession {
    session([
      "id": id, "display_name": "Claude Code · \(id)", "topic": "sequence/\(id)", "line": text,
      "link": link as Any? ?? NSNull(), "pending_decision_count": 0,
    ])
  }
  // Short and tall in turn, each history shaped as its own read would return it.
  let agents: [(AgentSession, [StatusHistoryEntry], Bool)] = [
    (agent("s1", "First session, a short line"), Array(agentHistoryFixture.prefix(2)), false),
    (agent("s2", longLine, link: "https://example.com/pull/1"), Array(longHistory.prefix(6)), true),
    (agent("s3", "Third session, a short line"), [], false),
    (agent("s4", longLine, link: "https://example.com/pull/2"), Array(longHistory.prefix(6)), true),
    (agent("s5", "Fifth session, a short line", link: "https://example.com/pull/5"), Array(agentHistoryFixture.prefix(1)), false),
    (agent("s6", "Sixth session"), Array(longHistory.prefix(2)), false),
  ]
  let decisionsInTurn: [(Decision, Bool)] = [
    (panelDecisions[0].1, false),
    (longDecision, true),
    (settledFixtures[3].1, false),
    (
      decision([
        "id": "dp_long3", "title": "A second long decision that replaces a short one.", "agent_session_id": "ags_2",
        "body": longBody, "recommendation": ["kind": "approve"],
      ]), true
    ),
    (panelDecisions[1].1, false),
    (settledFixtures[4].1, false),
  ]
  let records = Dictionary(decisionsInTurn.map { ($0.0.id, $0.0) }, uniquingKeysWith: { first, _ in first })

  for (kind, count) in [("agent", agents.count), ("decision", decisionsInTurn.count)] {
    for held in [false, true] {
      let pass = held ? "\(kind), AppKit's height constraint held down" : kind
      let model = PanelSequenceModel(records: records)
      let coordinator = model.coordinator
      let panel = DetailPanelController { PanelSequenceRoot(model: model, maxHeight: $0) }
      panel.window.alphaValue = 0
      panel.window.ignoresMouseEvents = true
      let row = PanelHeightRow()
      let popover = NSPopover()
      popover.behavior = .applicationDefined
      let host = NSHostingController(rootView: PanelSequenceRow(row: row))
      host.sizingOptions = [.preferredContentSize]
      popover.contentViewController = host
      let anchorWindow = NSWindow(
        contentRect: NSRect(x: screen.visibleFrame.minX + 200, y: screen.visibleFrame.maxY - 20, width: 10, height: 10),
        styleMask: [.borderless], backing: .buffered, defer: false)
      anchorWindow.alphaValue = 0
      anchorWindow.ignoresMouseEvents = true
      anchorWindow.orderFrontRegardless()

      // As `AppState.detailChanged` and `PopoverController.panelChanged` do.
      var panelTarget: DetailPanelTarget?
      coordinator.onDetailChange = {
        model.revision += 1
        let next = coordinator.panelTarget
        guard next != panelTarget else { return }
        panelTarget = next
        if next == nil {
          panel.hide()
        } else if popover.isShown {
          panel.present(beside: host.view, takesKeyFocus: false)
        }
      }
      popover.show(relativeTo: anchorWindow.contentView!.bounds, of: anchorWindow.contentView!, preferredEdge: .minY)
      host.view.window?.alphaValue = 0
      host.view.window?.ignoresMouseEvents = true
      drain(0.5)
      guard let popoverWindow = host.view.window else {
        check("\(pass): the popover has a window", false, &failures)
        continue
      }
      let cap = min(CGFloat(DetailPanelPlacement.maxHeight), popoverWindow.frame.maxY - screen.visibleFrame.minY)

      var heldConstraint: NSLayoutConstraint?
      for index in 0..<count {
        var fired = false
        let overflows: Bool
        let name: String
        var answer: () -> Void = {}
        if kind == "agent" {
          let (session, history, tall) = agents[index]
          overflows = tall
          name = "\(pass), click \(index + 1), \(session.id)"
          row.action = {
            fired = true
            coordinator.toggleAgent(session.id, known: session)
          }
          answer = {
            guard let target = model.reads.last else { return }
            coordinator.agent.apply(AgentDetailUpdate(target: target, outcome: .loaded(session, .available(history))))
          }
        } else {
          let (record, tall) = decisionsInTurn[index]
          overflows = tall
          name = "\(pass), click \(index + 1), \(record.id)"
          row.action = {
            fired = true
            coordinator.show(record.id)
          }
        }
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
          NSApp.postEvent(
            NSEvent.mouseEvent(
              with: type, location: NSPoint(x: 170, y: 150), modifierFlags: [],
              timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: popoverWindow.windowNumber, context: nil,
              eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
        }
        drain(0.25)
        answer()
        // A loaded target has its final content once the read has answered.
        drain(0.15)
        let (samples, converged) = settlePanel(panel.window)
        let last = samples.last!
        let insets = panel.window.contentView?.subviews.first?.safeAreaInsets ?? NSEdgeInsets()
        line("\(name): \(last.text), safe area top \(Int(insets.top)) bottom \(Int(insets.bottom))")
        check("\(name): the click reached the row", fired, &failures)
        check("\(name): layout holds still within 2 s", converged, &failures)
        check("\(name): the close control and the scrolling body exist", last.hasBody, &failures)
        check("\(name): the header is at the window's top", headerTop.contains(last.headerTopGap), &failures)
        check("\(name): the body ends at the window's bottom", abs(last.bottomGap) <= tolerance, &failures)
        check("\(name): the hosting view has no safe-area inset", insets.top == 0 && insets.bottom == 0, &failures)
        if overflows {
          check("\(name): the window stops at the \(Int(cap)) pt limit", abs(last.windowHeight - cap) <= tolerance, &failures)
        } else {
          check("\(name): the window's height matches header plus body", abs(last.windowHeight - last.contentHeight) <= tolerance, &failures)
        }
        check("\(name): the body starts at its top", abs(last.clipOffset) <= tolerance, &failures)
        guard let hostView = panel.window.contentView?.subviews.first else {
          check("\(name): the hosting view exists", false, &failures)
          continue
        }
        if expectsUnfixedPanel {
          let expected = heldConstraint == nil ? preferredHeightPriority : heldHeightPriority
          let problem = preferredHeightProblem(on: hostView, priority: expected)
          if let problem { line("  \(problem)") }
          check("\(name): AppKit's height constraint has its identifier, height attribute, items, relation, multiplier, and priority \(Int(expected.rawValue))", problem == nil, &failures)
          let matched = hostView.constraints.first { $0.identifier == preferredHeightIdentifier }
          if let matched { line("  \(preferredHeightIdentifier): constant \(matched.constant), priority \(matched.priority.rawValue), preferred \(last.preferredHeight)") }
          if let heldConstraint {
            check("\(name): the held constraint is the same object and stays held", matched === heldConstraint && heldConstraint.priority == heldHeightPriority && heldConstraint.isActive, &failures)
          } else if held, let matched {
            // After the first click, because AppKit installs it with the first height.
            matched.priority = heldHeightPriority
            heldConstraint = matched
            check("\(name): the injection is applied", matched.priority == heldHeightPriority, &failures)
          }
        } else {
          let present = heightConstraintPresence(on: hostView)
          if let present { line("  \(present)") }
          check("\(name): corrected source has no height constraint from AppKit, so nothing is held", present == nil, &failures)
          check("\(name): corrected source reports no preferred height", last.preferredHeight == 0, &failures)
        }
      }
      if held && expectsUnfixedPanel {
        check("\(pass): the injection was exercised", heldConstraint != nil, &failures)
      }
      popover.performClose(nil)
      panel.hide()
      anchorWindow.orderOut(nil)
      drain(0.2)
    }
  }
  check("the later-clicks section never made this process the active app", !NSApp.isActive, &failures)
  line("Holding the constraint down is an injected condition. These transparent windows do not reproduce the operator's report without it, so this section does not show why the constraint does not settle the window in the installed app. NOT EXERCISED, assigned to the operator's pre-release checks: later clicks in the installed app, in a visible key window, with physical clicks and real reads.")
  line("")
}
