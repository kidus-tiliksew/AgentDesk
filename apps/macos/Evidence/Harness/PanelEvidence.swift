import AppKit
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
      for: key, rows: rows, selected: selected, shown: detail.shownID, shownIsAnswerable: answerable,
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
  NSApp.setActivationPolicy(.accessory)

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
    NSApp.setActivationPolicy(.prohibited)
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
  NSApp.setActivationPolicy(.prohibited)
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
