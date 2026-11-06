import AppKit
import ApplicationServices
import Observation
import SwiftUI

// Keyboard and assistive evidence for the shipped `DecisionDetailView`,
// `AgentDetailView`, and `AgentEntry` (req-mac-app AC-11.11, AC-7.2). `run.sh` runs this as its own process, with
// `-AppleKeyboardUIMode 2` on its command line and nothing else overridden.
//
// An Accessibility API read shows what an assistive client such as VoiceOver is
// given, not what VoiceOver speaks. VoiceOver never starts, and the Mac's
// Keyboard navigation setting is never read or changed by anything but AppKit.
// Every window here is fully transparent and never takes key focus.

/// One element as an assistive client reads it.
private struct AXEntry: Sendable {
  let depth: Int
  let role: String
  let subrole: String?
  let title: String?
  let description: String?
  let value: String?
  let help: String?
  let enabled: Bool?
  let actions: [String]
  let focusSettable: Bool
  let path: [Int]

  var name: String { description ?? title ?? value ?? "" }

  var line: String {
    var parts = [String(repeating: "  ", count: depth) + role]
    if let description { parts.append("description=\"\(description)\"") }
    if let title, !title.isEmpty { parts.append("title=\"\(title)\"") }
    if let value { parts.append("value=\"\(value)\"") }
    if let help, !help.isEmpty { parts.append("help=\"\(help)\"") }
    if enabled == false { parts.append("disabled") }
    let shown = actions.filter { $0 == "AXPress" || $0 == "AXConfirm" }
    if !shown.isEmpty { parts.append("actions=\(shown.joined(separator: ","))") }
    if focusSettable { parts.append("focusable") }
    return parts.joined(separator: " ")
  }

  var isControl: Bool {
    ["AXButton", "AXLink", "AXRadioButton", "AXCheckBox", "AXTextField", "AXTextArea"].contains(role)
  }
}

private func axCopy(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func axText(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = axCopy(element, name) else { return nil }
  if let text = value as? String { return text.isEmpty ? nil : text }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  (axCopy(element, "AXChildren") as? [AXUIElement]) ?? []
}

private func axEntries(_ element: AXUIElement, depth: Int, path: [Int], into entries: inout [AXEntry]) {
  guard depth < 24 else { return }
  var names: CFArray?
  AXUIElementCopyActionNames(element, &names)
  var settable = DarwinBoolean(false)
  AXUIElementIsAttributeSettable(element, "AXFocused" as CFString, &settable)
  entries.append(
    AXEntry(
      depth: depth, role: axText(element, "AXRole") ?? "?", subrole: axText(element, "AXSubrole"),
      title: axText(element, "AXTitle"), description: axText(element, "AXDescription"),
      value: axText(element, "AXValue"), help: axText(element, "AXHelp"),
      enabled: (axCopy(element, "AXEnabled") as? NSNumber)?.boolValue, actions: (names as? [String]) ?? [],
      focusSettable: settable.boolValue, path: path))
  for (index, child) in axChildren(element).enumerated() {
    axEntries(child, depth: depth + 1, path: path + [index], into: &entries)
  }
}

private func axRoot(_ pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  return (axCopy(app, "AXWindows") as? [AXUIElement])?.first
}

private func axElement(_ root: AXUIElement, _ path: [Int]) -> AXUIElement? {
  var current = root
  for index in path {
    let children = axChildren(current)
    guard index < children.count else { return nil }
    current = children[index]
  }
  return current
}

@MainActor
private func pumpEvents(_ seconds: TimeInterval) {
  let until = Date().addingTimeInterval(seconds)
  while Date() < until {
    if let event = NSApp.nextEvent(
      matching: .any, until: Date().addingTimeInterval(0.01), inMode: .default, dequeue: true)
    {
      NSApp.sendEvent(event)
    }
  }
}

/// Runs an Accessibility API call. A call into this same process is answered in
/// place on the calling thread: a press from a background queue stopped the
/// process at SwiftUI's main-actor assertion. So these calls run on the main
/// thread, and they reach the view's accessibility objects without crossing a
/// process boundary.
@MainActor
private func axRun<Result>(_ work: () -> Result) -> Result {
  work()
}

/// What the panel's controls did when an assistive client pressed them.
@MainActor
@Observable
private final class AccessModel {
  var draft: AnswerDraft
  var closes = 0
  var retries = 0
  var opened: [String] = []
  var answers: [String] = []
  var sends = 0

  init(decision: Decision) {
    draft = .forPanel(decision)
  }

  var actions: DecisionDetailActions {
    DecisionDetailActions(
      open: { self.opened.append($0) },
      close: { self.closes += 1 },
      retry: { self.retries += 1 },
      answer: { _, answer in self.answers.append(DecisionPresentation.answerText(answer, options: nil)) },
      send: { _ in self.sends += 1 },
      draft: { _ in Binding(get: { self.draft }, set: { self.draft = $0 }) })
  }
}

/// One scene shown in a transparent window that never takes key focus.
@MainActor
private final class AccessStage {
  let window: NSWindow
  let pid = getpid()

  init<V: View>(_ view: V, width: CGFloat) {
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(x: 0, y: 0, width: width, height: 620)
    window = NSWindow(
      contentRect: NSRect(x: 40, y: 40, width: width, height: 620), styleMask: [.borderless], backing: .buffered,
      defer: false)
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.contentView = host
    window.orderFrontRegardless()
    pumpEvents(0.3)
  }

  func close() {
    window.orderOut(nil)
    pumpEvents(0.05)
  }

  func read() -> [AXEntry] {
    let pid = self.pid
    return axRun {
      guard let root = axRoot(pid) else { return [] }
      var entries: [AXEntry] = []
      axEntries(root, depth: 0, path: [], into: &entries)
      return entries
    }
  }

  /// Presses the named control as an assistive client does, and reports the
  /// API's answer.
  func press(_ entry: AXEntry) -> Bool {
    let pid = self.pid
    let path = entry.path
    let result = axRun { () -> Bool in
      guard let root = axRoot(pid), let element = axElement(root, path) else { return false }
      return AXUIElementPerformAction(element, "AXPress" as CFString) == .success
    }
    pumpEvents(0.15)
    return result
  }

  /// Sets a text field's value as an assistive client does.
  func setValue(_ entry: AXEntry, _ value: String) -> Bool {
    let pid = self.pid
    let path = entry.path
    let result = axRun { () -> Bool in
      guard let root = axRoot(pid), let element = axElement(root, path) else { return false }
      return AXUIElementSetAttributeValue(element, "AXValue" as CFString, value as CFString) == .success
    }
    pumpEvents(0.15)
    return result
  }

  /// Focuses the field with this placeholder and types into its field editor,
  /// as the keyboard does.
  func typeText(_ text: String, in placeholder: String) -> Bool {
    func field(_ view: NSView) -> NSTextField? {
      if let field = view as? NSTextField, field.isEditable, field.placeholderString == placeholder { return field }
      for child in view.subviews {
        if let found = field(child) { return found }
      }
      return nil
    }
    guard let target = window.contentView.flatMap(field), window.makeFirstResponder(target),
      let editor = window.firstResponder as? NSTextView
    else { return false }
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    pumpEvents(0.15)
    window.makeFirstResponder(nil)
    pumpEvents(0.05)
    return true
  }

  /// Posts Tab or Shift-Tab to the window and names the responder it lands on.
  func tab(backward: Bool) -> String {
    let event = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: backward ? [.shift] : [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
      characters: "\t", charactersIgnoringModifiers: "\t", isARepeat: false, keyCode: 48)!
    window.sendEvent(event)
    pumpEvents(0.05)
    let responder = window.firstResponder
    if let field = (responder as? NSText)?.delegate as? NSTextField { return field.placeholderString ?? "text field" }
    if let view = responder as? NSView, view !== window.contentView, responder !== window {
      return String(describing: type(of: view))
    }
    return "none"
  }

  /// The stops Tab walks from no focus before it repeats.
  func forwardStops() -> [String] {
    window.makeFirstResponder(nil)
    var found: [String] = []
    for _ in 0..<14 {
      let stop = tab(backward: false)
      if found.contains(stop) { break }
      found.append(stop)
    }
    return found
  }

  /// The stops Shift-Tab walks from the last Tab stop before it repeats.
  func backwardStops(from count: Int) -> [String] {
    window.makeFirstResponder(nil)
    for _ in 0..<count { _ = tab(backward: false) }
    var found: [String] = []
    for _ in 0..<14 {
      let stop = tab(backward: true)
      if found.contains(stop) { break }
      found.append(stop)
    }
    return found
  }
}

private struct Scene: Sendable {
  let name: String
  let decision: Decision
}

/// Over the 2,000-character note limit, so the answer controls refuse.
private let overLimitNote = String(repeating: "n", count: AnswerDraft.noteLimit + 1)

@MainActor
func accessEvidence() -> Int32 {
  var lines: [String] = []
  var failed: [String] = []
  func say(_ text: String) {
    lines.append(text)
    print(text)
  }
  func check(_ name: String, _ passed: Bool) {
    say("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failed.append(name) }
  }
  func finish() -> Int32 {
    say("")
    say(failed.isEmpty ? "RESULT: PASS" : "RESULT: FAIL")
    for name in failed { say("  \(name)") }
    try! lines.joined(separator: "\n").appending("\n").write(
      to: out.appendingPathComponent("access.txt"), atomically: true, encoding: .utf8)
    return failed.isEmpty ? 0 : 1
  }

  // The system never activates a process with this policy, so this one cannot
  // take focus from the Mac user's work. `ActivationWatch` fails the run if it
  // does. `finishLaunching` registers the app for assistive clients.
  NSApp.setActivationPolicy(.prohibited)
  NSApp.finishLaunching()
  say("# Panel keyboard and assistive evidence")
  say("Compiled from the shipped DecisionDetailView, AgentDetailView, AgentsView, AnswerControls, and ApproveRejectButtons; only the actions and draft storage are fixtures.")
  say("An Accessibility API read shows what an assistive client is given, not what VoiceOver speaks.")
  say("")

  // Route 1: the launch-argument domain, for this process only.
  let commandLineMode = UserDefaults.standard.object(forKey: "AppleKeyboardUIMode")
  let afterArgument = NSApp.isFullKeyboardAccessEnabled
  say("## Full keyboard access for this process")
  say("Route 1, launch argument -AppleKeyboardUIMode 2: this process's defaults read \(commandLineMode.map { "\($0)" } ?? "nothing"), and NSApp.isFullKeyboardAccessEnabled reads \(afterArgument).")
  say(afterArgument ? "The override took effect, or the Mac's setting is on." : "The override did not take effect: AppKit does not read that value from the argument domain.")

  let scenes: [Scene] = panelDecisions.map { Scene(name: $0.0, decision: $0.1) }
  func keyboardStops() -> [(String, [String], [String])] {
    scenes.map { scene in
      let stage = AccessStage(
        DecisionDetailView(presentation: presentation(scene.decision)), width: CGFloat(DetailPanelPlacement.width))
      let forward = stage.forwardStops()
      let backward = stage.backwardStops(from: forward.count)
      stage.close()
      return (scene.name, forward, backward)
    }
  }
  let plain = keyboardStops()
  say("")
  say("Real key view loop, Tab and Shift-Tab posted to the transparent window, with NSApp.isFullKeyboardAccessEnabled \(NSApp.isFullKeyboardAccessEnabled):")
  for (name, forward, backward) in plain {
    say("- \(name): Tab \(forward.joined(separator: " > ")); Shift-Tab \(backward.joined(separator: " > "))")
    check("\(name): Tab reaches the note field", forward.contains("Note for the agent (optional)"))
    check(
      "\(name): Shift-Tab from the last stop walks the same stops in reverse",
      backward == Array(forward.reversed().dropFirst()) + forward.suffix(1))
  }
  let choiceOrText = plain.first { $0.0 == "single-choice-or-text" }!
  check(
    "single-choice-or-text: Tab moves from the answer field to the note field",
    choiceOrText.1 == ["Or type another answer", "Note for the agent (optional)"])

  // Route 2: this process's answer from NSApp, changed by replacing its method.
  let method = class_getInstanceMethod(NSApplication.self, NSSelectorFromString("isFullKeyboardAccessEnabled"))!
  let original = method_getImplementation(method)
  let enabled: @convention(block) (AnyObject) -> Bool = { _ in true }
  method_setImplementation(method, imp_implementationWithBlock(enabled))
  let afterMethod = NSApp.isFullKeyboardAccessEnabled
  let overridden = keyboardStops()
  method_setImplementation(method, original)
  say("")
  say("Route 2, NSApp.isFullKeyboardAccessEnabled replaced in this process only: it reads \(afterMethod).")
  let moved = zip(plain, overridden).contains { $0.1 != $1.1 || $0.2 != $1.2 }
  say(
    moved
      ? "The key view loop changed under this override."
      : "The key view loop did not change: AppKit and SwiftUI decide button focus from a value this method does not supply.")
  say("NOT EXERCISED, assigned to the operator's pre-release checks: buttons, links, radio buttons, and checkboxes in the Tab order with the Mac's Keyboard navigation setting on. Neither override reproduces that setting, and the setting was not changed.")
  say("")

  guard AXIsProcessTrusted() else {
    say("## Assistive client")
    say("NOT EXERCISED: this process is not trusted for Accessibility, so AXIsProcessTrusted is false and no element tree was read.")
    return finish()
  }

  say("## Assistive client (AXUIElement calls within this process, with AXIsProcessTrusted true)")
  let manual = AXUIElementSetAttributeValue(
    AXUIElementCreateApplication(getpid()), "AXManualAccessibility" as CFString, kCFBooleanTrue
  ).rawValue
  say("AXManualAccessibility set returned \(manual), which is kAXErrorAttributeUnsupported on this OS; the tree below builds without it. These calls stay inside this process.")
  say("")

  func tree(_ name: String, _ entries: [AXEntry]) {
    say("### \(name)")
    for entry in entries where entry.depth > 1 { say(entry.line) }
  }
  func named(_ entries: [AXEntry], _ role: String, _ text: String) -> AXEntry? {
    entries.first { $0.role == role && $0.name.contains(text) }
  }
  func needsPress(_ entries: [AXEntry], _ name: String) {
    let controls = entries.filter(\.isControl)
    check(
      "\(name): every control has a name",
      controls.allSatisfy { !$0.name.isEmpty })
    check(
      "\(name): every button, link, radio button, and checkbox offers AXPress",
      controls.filter { $0.role != "AXTextField" && $0.role != "AXTextArea" }.allSatisfy { $0.actions.contains("AXPress") })
    check("\(name): the close control is named and pressable", named(entries, "AXButton", "Close detail")?.actions.contains("AXPress") == true)
    check("\(name): the panel names itself", entries.contains { $0.description == "Decision detail" })
  }
  func run(
    _ name: String, _ decision: Decision, titles: [String: String] = [:],
    _ body: (AccessModel, AccessStage, [AXEntry]) -> Void
  ) {
    let model = AccessModel(decision: decision)
    let shown = presentation(decision, titles: titles)
    let stage = AccessStage(
      DecisionDetailView(presentation: shown, actions: model.actions), width: CGFloat(DetailPanelPlacement.width))
    let entries = stage.read()
    tree(name, entries)
    needsPress(entries, name)
    body(model, stage, entries)
    if let close = named(stage.read(), "AXButton", "Close detail") {
      check("\(name): AXPress on the close control runs it", stage.press(close) && model.closes == 1)
    }
    stage.close()
    say("")
  }

  run("approve-reject", panelDecisions[0].1) { model, stage, entries in
    let reject = named(entries, "AXButton", "Reject")
    let approve = named(entries, "AXButton", "Approve")
    check("approve-reject: the note field is named", named(entries, "AXTextField", "Note for the agent") != nil)
    check("approve-reject: the recommended button says so, not by color", approve?.help == "Suggested by the agent")
    check("approve-reject: AXPress on Reject answers", reject.map(stage.press) == true && model.answers == ["Reject"])
    check("approve-reject: AXPress on Approve answers", approve.map(stage.press) == true && model.answers == ["Reject", "Approve"])
    if let note = named(stage.read(), "AXTextField", "Note for the agent") {
      let accepted = stage.setValue(note, "ok")
      say("approve-reject: setting the note's AXValue returned \(accepted), and the draft's note then read \"\(model.draft.note)\".")
      check("approve-reject: typing in the focused note field reaches the draft", stage.typeText("ok", in: "Note for the agent (optional)") && model.draft.note == "ok")
    }
    model.draft.note = overLimitNote
    pumpEvents(0.2)
    let refused = stage.read()
    check("approve-reject: an over-long note reads as disabled Reject and Approve", named(refused, "AXButton", "Reject")?.enabled == false && named(refused, "AXButton", "Approve")?.enabled == false)
    check("approve-reject: the note limit is read as text", refused.contains { $0.name.contains("Notes can be up to") })
  }

  run("single-choice", panelDecisions[1].1) { model, stage, entries in
    let suggested = named(entries, "AXRadioButton", "Ship now")
    let other = named(entries, "AXRadioButton", "Wait for Monday")
    check("single-choice: the group is named", entries.contains { $0.role == "AXRadioGroup" && $0.name == "Answer" })
    check("single-choice: the suggestion is in the name, not by color", suggested?.name.contains("Suggested") == true)
    check("single-choice: the chosen radio button reads its value", suggested?.value == "1" && other?.value == "0")
    check("single-choice: AXPress chooses a radio button", other.map(stage.press) == true && model.draft.selectedOption == "b")
    let after = stage.read()
    check("single-choice: the new choice reads back", named(after, "AXRadioButton", "Wait for Monday")?.value == "1" && named(after, "AXRadioButton", "Ship now")?.value == "0")
    check("single-choice: AXPress on Send sends", named(after, "AXButton", "Send").map(stage.press) == true && model.sends == 1)
    check("single-choice: Send names its key", named(after, "AXButton", "Send")?.help == "Command-Return")
  }

  run("multiple-choice", panelDecisions[2].1) { model, stage, entries in
    let extra = named(entries, "AXCheckBox", "Asia Pacific")
    check("multiple-choice: each option is a named checkbox", ["Europe", "United States", "Asia Pacific"].allSatisfy { named(entries, "AXCheckBox", $0) != nil })
    check("multiple-choice: suggestions are in the name, not by color", named(entries, "AXCheckBox", "Europe")?.name.contains("Suggested") == true)
    check("multiple-choice: each checkbox reads its value", named(entries, "AXCheckBox", "Europe")?.value == "1" && extra?.value == "0")
    check("multiple-choice: AXPress toggles a checkbox", extra.map(stage.press) == true && model.draft.selectedOptions.contains("ap"))
    check("multiple-choice: the new state reads back", named(stage.read(), "AXCheckBox", "Asia Pacific")?.value == "1")
    check("multiple-choice: AXPress on Send sends", named(stage.read(), "AXButton", "Send").map(stage.press) == true && model.sends == 1)
  }

  run("free-text", panelDecisions[3].1) { model, stage, entries in
    let answer = named(entries, "AXTextField", "Your answer")
    check("free-text: the answer field is named", answer != nil)
    check("free-text: the note field is named", named(entries, "AXTextField", "Note for the agent") != nil)
    check("free-text: typing in the focused answer field reaches the draft", stage.typeText("agentdesk-kit", in: "agentdesk-core") && model.draft.text == "agentdesk-kit")
    check("free-text: AXPress on Send sends", named(stage.read(), "AXButton", "Send").map(stage.press) == true && model.sends == 1)
    model.draft.text = "   "
    pumpEvents(0.2)
    check("free-text: invalid input reads as a disabled Send", named(stage.read(), "AXButton", "Send")?.enabled == false)
  }

  run("single-choice-or-text", panelDecisions[4].1) { model, stage, entries in
    check("single-choice-or-text: the radio buttons are named", named(entries, "AXRadioButton", "Now") != nil && named(entries, "AXRadioButton", "Tonight at 02:00") != nil)
    check("single-choice-or-text: the alternative field is named", named(entries, "AXTextField", "Your answer") != nil)
    check("single-choice-or-text: AXPress chooses a radio button", named(entries, "AXRadioButton", "Now").map(stage.press) == true && model.draft.selectedOption == "now")
    check("single-choice-or-text: AXPress on Send sends", named(stage.read(), "AXButton", "Send").map(stage.press) == true && model.sends == 1)
  }

  run("linked, urgent, with a default", linkedDecision, titles: followUpTitles) { model, stage, entries in
    let links = entries.filter { $0.role == "AXLink" }
    check("linked: the parent and each follow-up are links", links.count == 3)
    check("linked: each link says what it does", links.allSatisfy { $0.help == "Shows this decision in the panel" })
    check("linked: Urgent is text, not only red", entries.contains { $0.value == "Urgent" })
    check("linked: the title is a heading", entries.contains { $0.role == "AXHeading" && $0.name.contains("Ship the 2.4 release") })
    check("linked: the agent and age read", entries.contains { ($0.value ?? "").contains("Codex · web · 2m ago") })
    check("linked: the time left is text, not only red", entries.contains { ($0.value ?? "").contains("4m left") })
    check("linked: the separator between deadline and time left is not read", !entries.contains { ($0.value ?? "").hasPrefix("Deadline") && ($0.value ?? "").contains("·") })
    for label in ["Recommendation", "Deadline", "Default", "Topic"] {
      check("linked: \(label) reads with its value in one element", entries.contains { $0.role == "AXStaticText" && ($0.value ?? "").hasPrefix("\(label), ") })
    }
    check("linked: the Markdown body reads", entries.contains { $0.value == "This follows the soak decision." })
    check("linked: \"Follow-ups\" is a heading", entries.contains { $0.role == "AXHeading" && $0.name == "Follow-ups" })
    for (index, link) in links.enumerated() { _ = index; _ = stage.press(link) }
    check("linked: AXPress on each link shows its decision", model.opened == ["dp_parent", "dp_up1", "dp_up2"])
  }

  for (name, decision) in settledFixtures {
    run(name, decision) { _, _, entries in
      let controls = entries.filter(\.isControl).map(\.name)
      check("\(name): the close control is the only control", controls == ["Close detail"])
      check("\(name): the recorded outcome reads as text", entries.contains { $0.role == "AXStaticText" && $0.value == panelModelOutcome(decision) })
      check("\(name): no element has an unknown role", !entries.contains { $0.role == "AXUnknown" })
    }
  }
  run("settled-chat message", settledFixtures[1].1) { _, _, entries in
    check("settled-chat: the message reads word for word", entries.contains { ($0.value ?? "").contains("**wait** until monday, the team is out") })
  }

  func stateScene(
    _ name: String, _ content: DetailPanelPresentation, decision: Decision = panelDecisions[0].1,
    _ body: (AccessModel, AccessStage, [AXEntry]) -> Void
  ) {
    let model = AccessModel(decision: decision)
    let stage = AccessStage(
      DecisionDetailView(presentation: content, actions: model.actions), width: CGFloat(DetailPanelPlacement.width))
    let entries = stage.read()
    tree(name, entries)
    needsPress(entries, name)
    body(model, stage, entries)
    stage.close()
    say("")
  }
  stateScene("load-failed", DetailPanelPresentation(content: .failed)) { model, stage, entries in
    check("load-failed: the message reads", entries.contains { ($0.value ?? "").contains("Couldn't load this decision.") })
    check("load-failed: AXPress on Try Again retries", named(entries, "AXButton", "Try Again").map(stage.press) == true && model.retries == 1)
  }
  stateScene("unavailable", DetailPanelPresentation(content: .unavailable)) { _, _, entries in
    check("unavailable: the message reads", entries.contains { ($0.value ?? "").contains("This decision isn't available.") })
    check("unavailable: the close control is the only control", entries.filter(\.isControl).map(\.name) == ["Close detail"])
  }
  stateScene("loading", DetailPanelPresentation(content: .loading)) { _, _, entries in
    check("loading: the state is named", entries.contains { $0.name.contains("Loading the decision") })
  }
  stateScene("send-failed", presentation(panelDecisions[1].1, failure: PendingAnswers.failureMessage), decision: panelDecisions[1].1) { _, _, entries in
    check("send-failed: the failure reads as text", entries.contains { $0.value == PendingAnswers.failureMessage })
    check("send-failed: Send stays reachable to retry", named(entries, "AXButton", "Send")?.actions.contains("AXPress") == true)
  }
  stateScene("answer-held", presentation(panelDecisions[0].1, isAnswerable: false)) { _, _, entries in
    check("answer-held: the state reads as text", entries.contains { ($0.value ?? "").contains("Your answer to this decision is on its way.") })
    check("answer-held: the close control is the only control", entries.filter(\.isControl).map(\.name) == ["Close detail"])
  }
  stateScene("refresh-failed", presentation(panelDecisions[0].1, refreshFailed: true)) { _, _, entries in
    check("refresh-failed: the state reads as text", entries.contains { ($0.value ?? "").contains("Couldn't refresh this decision.") })
  }

  // The agent panel (AC-11.3, AC-11.4, AC-11.5, AC-11.11).
  say("## Agent panel")
  say("")
  final class AgentActions {
    var closes = 0
    var retries = 0
    var openedLinks = 0
    var decisions: [String] = []
    var actions: AgentDetailActions {
      AgentDetailActions(
        openDecision: { self.decisions.append($0) }, close: { self.closes += 1 }, retry: { self.retries += 1 },
        openLink: { self.openedLinks += 1 })
    }
  }
  func agentScene(
    _ name: String, _ shown: AgentDetailPresentation, _ body: (AgentActions, AccessStage, [AXEntry]) -> Void
  ) {
    let model = AgentActions()
    let stage = AccessStage(
      AgentDetailView(presentation: shown, actions: model.actions), width: CGFloat(DetailPanelPlacement.width))
    let entries = stage.read()
    tree(name, entries)
    let controls = entries.filter(\.isControl)
    check("\(name): every control has a name", controls.allSatisfy { !$0.name.isEmpty })
    check("\(name): every control offers AXPress", controls.allSatisfy { $0.actions.contains("AXPress") })
    check("\(name): the close control is named and pressable", named(entries, "AXButton", "Close detail")?.actions.contains("AXPress") == true)
    check("\(name): the panel names itself", entries.contains { $0.description == "Agent detail" })
    check("\(name): nothing reads as a web link", !entries.contains { $0.role == "AXLink" })
    check("\(name): every element has a known role", !entries.contains { $0.role == "AXUnknown" })
    check("\(name): no text field, so nothing sends a message to the agent", !entries.contains { $0.role == "AXTextField" || $0.role == "AXTextArea" })
    body(model, stage, entries)
    if let close = named(stage.read(), "AXButton", "Close detail") {
      check("\(name): AXPress on the close control closes", stage.press(close) && model.closes == 1)
    }
    stage.close()
    say("")
  }
  func reads(_ entries: [AXEntry], _ text: String) -> Bool {
    entries.contains { ($0.value ?? "").contains(text) || ($0.description ?? "").contains(text) || ($0.title ?? "").contains(text) }
  }
  agentScene("agent-working", agentPresentation(workingAgent)) { model, stage, entries in
    for (fact, text) in [
      ("state and update age", "Working, 2m ago"), ("the status line", "Running the migration tests"),
      ("the display name", "Claude Code · api"), ("the topic", "api/migrations"),
      ("the pending count", "1 pending decision"), ("the section", "Waiting on you"), ("the history section", "History"),
      ("the newest history entry", "Waiting for the staging soak"), ("an older history entry", "Started on the events table"),
    ] {
      check("agent-working: \(fact) reads as text", reads(entries, text))
    }
    check("agent-working: the status line is a heading", entries.contains { $0.role == "AXHeading" && $0.name.contains("Running the migration tests") })
    check("agent-working: a history entry's link is plain text", entries.contains { $0.role == "AXStaticText" && ($0.value ?? "").contains("https://example.com/soak/12") })
    check("agent-working: AXPress on the pending decision shows it, with no browser", named(entries, "AXButton", "Delete the stale preview databases?").map(stage.press) == true && model.decisions == ["ap_1"] && model.openedLinks == 0)
    check("agent-working: AXPress on Open link is the one thing that opens a link", named(entries, "AXButton", "Open link").map(stage.press) == true && model.openedLinks == 1)
  }
  agentScene("agent-stale", agentPresentation(staleAgent)) { model, _, entries in
    check("agent-stale: the stale marker reads as text", reads(entries, "Waiting, 45m ago, Stale"))
    check("agent-stale: the empty list reads as text", reads(entries, "No pending decisions."))
    check("agent-stale: with no link, close is the only control", entries.filter(\.isControl).map(\.name) == ["Close detail"])
  }
  agentScene("agent-blocked", agentPresentation(blockedAgent)) { _, _, entries in
    check("agent-blocked: blocked reads in words, not only red", reads(entries, "Blocked, 10m ago"))
    let row = named(entries, "AXButton", "Ship the 2.4 release")
    check("agent-blocked: the pending decision reads urgent and its time left", (row?.value ?? "").contains("Urgent") && (row?.value ?? "").contains("4m left"))
  }
  agentScene("agent-no-status", agentPresentation(noStatusAgent, history: .available([]))) { _, _, entries in
    check("agent-no-status: reads no status and no update", reads(entries, "No status yet, No update yet"))
    check("agent-no-status: the empty history reads as text", reads(entries, "No earlier statuses."))
    check("agent-no-status: an empty history never reads as unavailable", !reads(entries, "History isn't available on this server."))
  }
  // req-mac-app AC-11.12: the server finds the session but not its history.
  agentScene("agent-history-unavailable", agentPresentation(workingAgent, history: .unavailable)) { model, stage, entries in
    check(
      "agent-history-unavailable: the message is static text",
      entries.contains { $0.role == "AXStaticText" && ($0.value ?? "").contains("History isn't available on this server.") })
    for (fact, text) in [
      ("state and update age", "Working, 2m ago"), ("the status line", "Running the migration tests"),
      ("the display name", "Claude Code · api"), ("the topic", "api/migrations"),
      ("the pending count", "1 pending decision"), ("the section", "Waiting on you"), ("the history section", "History"),
    ] {
      check("agent-history-unavailable: \(fact) reads as text", reads(entries, text))
    }
    check("agent-history-unavailable: it never reads as gone", !reads(entries, "This agent session is gone."))
    check("agent-history-unavailable: it never reads as an empty history", !reads(entries, "No earlier statuses."))
    check("agent-history-unavailable: it carries no refresh warning", !reads(entries, "Couldn't refresh this agent."))
    check("agent-history-unavailable: it shows no history entry", !reads(entries, "Waiting for the staging soak"))
    check(
      "agent-history-unavailable: the session's controls stay, with no Try Again",
      Set(entries.filter(\.isControl).map(\.name)) == ["Close detail", "Delete the stale preview databases?", "Open link"])
    check(
      "agent-history-unavailable: AXPress on the pending decision shows it, with no browser",
      named(entries, "AXButton", "Delete the stale preview databases?").map(stage.press) == true && model.decisions == ["ap_1"] && model.openedLinks == 0)
    check(
      "agent-history-unavailable: AXPress on Open link opens the link",
      named(entries, "AXButton", "Open link").map(stage.press) == true && model.openedLinks == 1)
  }
  for (name, session) in [("agent-invalid-link", invalidLinkAgent), ("agent-relative-link", relativeLinkAgent)] {
    agentScene(name, agentPresentation(session)) { _, _, entries in
      check("\(name): offers no Open link", named(entries, "AXButton", "Open link") == nil)
    }
  }
  agentScene("agent-loading", AgentDetailPresentation(content: .loading(nil), refreshFailed: false, decisions: [], now: now)) { _, _, entries in
    check("agent-loading: the state is named", reads(entries, "Loading this agent"))
  }
  agentScene("agent-load-failed", AgentDetailPresentation(content: .failed(workingAgent), refreshFailed: false, decisions: [], now: now)) { model, stage, entries in
    check("agent-load-failed: the message reads", reads(entries, "Couldn't load this agent."))
    check("agent-load-failed: the list's record stays", reads(entries, "Running the migration tests"))
    check("agent-load-failed: AXPress on Try Again retries", named(entries, "AXButton", "Try Again").map(stage.press) == true && model.retries == 1)
  }
  agentScene("agent-refresh-failed", agentPresentation(workingAgent, refreshFailed: true)) { model, stage, entries in
    check("agent-refresh-failed: the warning reads", reads(entries, "Couldn't refresh this agent."))
    check("agent-refresh-failed: the session stays", reads(entries, "Running the migration tests"))
    check("agent-refresh-failed: AXPress on Try Again retries", named(entries, "AXButton", "Try Again").map(stage.press) == true && model.retries == 1)
  }
  agentScene(
    "agent-pending-unread",
    AgentDetailPresentation(
      content: .loaded(blockedAgent, .available(agentHistoryFixture)), refreshFailed: false, decisions: [], now: now,
      decisionsAreKnown: false)
  ) { _, _, entries in
    check("agent-pending-unread: an unread list says so", reads(entries, "Pending decisions aren't available yet."))
    check("agent-pending-unread: it never reads as empty", !reads(entries, "No pending decisions."))
    check("agent-pending-unread: the count still reads", reads(entries, "1 pending decision"))
  }
  agentScene("agent-gone", AgentDetailPresentation(content: .gone)) { _, _, entries in
    check("agent-gone: the message reads", reads(entries, "This agent session is gone."))
    check("agent-gone: close is the only control", entries.filter(\.isControl).map(\.name) == ["Close detail"])
  }
  do {
    let stage = AccessStage(
      AgentDetailView(presentation: agentPresentation(workingAgent)), width: CGFloat(DetailPanelPlacement.width))
    let stops = stage.forwardStops()
    say("Agent panel's key view loop with NSApp.isFullKeyboardAccessEnabled \(NSApp.isFullKeyboardAccessEnabled): \(stops.joined(separator: " > "))")
    say("NOT EXERCISED, assigned to the operator's pre-release checks: the agent panel's buttons in the Tab order with the Mac's Keyboard navigation setting on. This panel has no text field, so Tab has no stop with that setting off.")
    stage.close()
    say("")
  }

  // The entries, which open the panel and no browser (AC-5.3).
  do {
    final class Opened {
      var ids: [String] = []
    }
    let opened = Opened()
    let linked = [workingAgent, blockedAgent, staleAgent, invalidLinkAgent, stateAgents[0]]
    let stage = AccessStage(
      AgentsView(
        agents: linked, now: now, expanded: .constant(true), quietRevealed: .constant(true),
        open: { opened.ids.append($0) }), width: 340)
    let entries = stage.read()
    tree("agent entries", entries)
    for (session, text) in [
      (workingAgent, "Claude Code · api, working, Running the migration tests"),
      (blockedAgent, "Codex · web, blocked, Needs a decision"),
      (staleAgent, "Cursor · docs, quiet 43m, Waiting for review"),
      (invalidLinkAgent, "Claude Code · link, working, Holds a link"),
      // Draws "migrations" and no status line, and reads both in full (AC-5.4, AC-5.2).
      (stateAgents[0], "Claude Code · api/migrations, working, Running the migration tests"),
    ] {
      let entry = named(entries, "AXButton", text)
      check("entry \(session.id): a named button, with or without a link", entry?.actions.contains("AXPress") == true)
      opened.ids = []
      check("entry \(session.id): AXPress opens the panel for that session", entry.map(stage.press) == true && opened.ids == [session.id])
    }
    check("entries: none reads as a web link", !entries.contains { $0.role == "AXLink" })
    stage.close()
    say("")
  }

  // A row, for the list's half of the same requirement (AC-7.2).
  do {
    let stage = AccessStage(
      PopoverFixture(items: items(decisions), expanded: false, selectedID: "d1"), width: 340)
    let entries = stage.read()
    tree("popover rows", entries)
    let row = entries.first { ($0.description ?? "").contains("Ship the 2.4 release") }
    check("row: the title is its name", row != nil)
    check("row: the value reads the agent, time left, new, urgent, and suggestion", ["Codex · web", "4m left", "new", "urgent", "suggests Ship now"].allSatisfy { (row?.value ?? "").contains($0) })
    let freeText = entries.first { ($0.description ?? "").contains("Which name should") }
    check("row: a free-text row draws no suggestion and its value reads one", freeText?.value?.contains("suggests agentdesk-core") == true)
    check("row: it offers AXPress", row?.actions.contains("AXPress") == true)
    check("row: Reject and Approve are separate named buttons", named(entries, "AXButton", "Reject") != nil && named(entries, "AXButton", "Approve") != nil)
    stage.close()
    say("")
  }

  say("## What this does not establish")
  say("This evidence is non-live, and it does not establish the reach req-mac-app AC-11.11 sets. These checks are assigned to the operator's pre-release checks:")
  say("NOT EXERCISED: VoiceOver speech and focus. VoiceOver did not run; the tree above is what it would be given.")
  say("NOT EXERCISED: the Mac's Keyboard navigation setting on, and physical Tab or Shift-Tab keys.")
  say("NOT EXERCISED: focus moving on opening, replacing, and closing the panel in the live app.")
  say("NOT EXERCISED: an assistive client in another process. These AXUIElement calls were answered inside this process.")
  say("NOT EXERCISED: moving AX focus into a control, since this app stays inactive and its windows never take key focus. Focusable above means AXFocused is settable.")
  say("")
  say("## Focus")
  check("this process never became the active app", ActivationWatch.shared.count == 0 && !NSApp.isActive)
  return finish()
}

@MainActor
private func panelModelOutcome(_ decision: Decision) -> String {
  DecisionPresentation.settledOutcome(decision, now: now)?.summary ?? "?"
}
