import AppKit
import Observation
import SwiftUI

// The list's scrolling across openings (component-mac-app §List scrolling;
// req-mac-app AC-4.12, AC-4.13). `PopoverController` keeps one hosting
// controller for the life of the process and `NSPopover` keeps its content
// view between openings, so these scenes move one retained hosting controller
// between offscreen windows and read the shipped list's `NSScrollView`.

@MainActor
@Observable
private final class ScrollModel {
  var items: [DecisionListItem]
  var request = ListScrollRequest()
  var undo: String?
  var expanded = false
  init(items: [DecisionListItem]) { self.items = items }
}

/// The popover's stack with the shipped list, its budget, and the agents view.
/// Offscreen windows are occluded, so an animated scroll never advances; the
/// row target is applied without its 0.15 s animation.
private struct ScrollFixture: View {
  let model: ScrollModel
  var agents: [AgentSession] = groupedAgents
  @State private var quietRevealed = true
  @State private var headerHeight: CGFloat = 0
  @State private var stripsHeight: CGFloat = 0
  @State private var agentsHeight: CGFloat = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("AgentDesk")
        .font(.headline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .measuredHeight($headerHeight)
      Divider()
      AnswerStrips(outcome: nil, undoText: model.undo)
        .measuredHeight($stripsHeight)
      DecisionList(
        items: model.items, selectedID: nil, expandedID: nil,
        maxHeight: CGFloat(
          PopoverLayout.listMaxHeight(chromeHeight: Double(headerHeight + stripsHeight + agentsHeight + 2))),
        scrollRequest: model.request, rowScrollAnimation: nil)
      Divider()
      AgentsView(
        agents: agents, now: now,
        expanded: Binding(get: { model.expanded }, set: { model.expanded = $0 }),
        quietRevealed: $quietRevealed
      )
      .measuredHeight($agentsHeight)
    }
    .frame(width: 340)
    .frame(maxHeight: CGFloat(PopoverLayout.maxHeight), alignment: .top)
  }
}

@MainActor
private func pump(_ seconds: TimeInterval = 0.25) {
  RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

@MainActor
func scrollViews(in view: NSView) -> [NSScrollView] {
  (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews)
}

/// One opening of the retained controller: a fresh window, as the popover
/// gives its content, sized to the preferred content size.
@MainActor
private final class Stage {
  let host: NSHostingController<ScrollFixture>
  private var window: NSWindow?
  /// The popover material behind the content, so renders read as the popover.
  private let material = NSVisualEffectView()

  init(_ root: ScrollFixture) {
    host = NSHostingController(rootView: root)
    host.sizingOptions = [.preferredContentSize]
  }

  func open() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 340, height: 100), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .aqua)
    material.material = .popover
    material.blendingMode = .withinWindow
    material.state = .active
    window.contentView = material
    host.view.frame = material.bounds
    host.view.autoresizingMask = [.width, .height]
    material.addSubview(host.view)
    self.window = window
    settle()
  }

  func close() {
    host.view.removeFromSuperview()
    window?.contentView = nil
    window = nil
    pump(0.1)
  }

  func settle() {
    for _ in 0..<4 {
      pump(0.1)
      let size = host.preferredContentSize
      if size.height > 0 { window?.setContentSize(size) }
    }
  }

  /// The decision list is the first scroll view in the stack.
  var list: NSScrollView { scrollViews(in: host.view)[0] }
  var offset: CGFloat { list.documentVisibleRect.minY }

  func scroll(to y: CGFloat) {
    list.documentView?.scroll(NSPoint(x: 0, y: y))
    list.reflectScrolledClipView(list.contentView)
    pump(0.1)
  }

  func render() -> NSBitmapImageRep {
    material.layoutSubtreeIfNeeded()
    let rep = material.bitmapImageRepForCachingDisplay(in: material.bounds)!
    material.cacheDisplay(in: material.bounds, to: rep)
    return rep
  }
}

/// How many of the scroller's own pixels it paints.
@MainActor
private func knobPixels(_ scroller: NSScroller) -> Int {
  let rep = scroller.bitmapImageRepForCachingDisplay(in: scroller.bounds)!
  scroller.cacheDisplay(in: scroller.bounds, to: rep)
  var painted = 0
  for y in 0..<rep.pixelsHigh {
    for x in 0..<rep.pixelsWide where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.3 {
      painted += 1
    }
  }
  return painted
}

@MainActor
func scrollEvidence(_ failures: inout [String]) {
  line("## List scrolling (a retained hosting controller moved between offscreen windows)")
  line("system preferred scroller style: \(NSScroller.preferredScrollerStyle == .overlay ? "overlay" : "legacy")")

  var failed: [String] = []
  func check(_ name: String, _ passed: Bool) {
    line("\(passed ? "ok" : "FAIL") \(name)")
    if !passed { failed.append(name) }
  }
  func describe(_ stage: Stage, _ label: String) {
    line(String(format: "%@: clip offset %.0f pt", label, stage.offset))
  }
  /// The first row sits at the top of the list, and the list inside the popover.
  func firstRowShows(_ stage: Stage) -> Bool {
    let frame = stage.list.convert(stage.list.bounds, to: stage.host.view)
    return stage.offset == 0 && frame.minY >= 0 && frame.maxY <= stage.host.view.bounds.height
  }

  let model = ScrollModel(items: items(overflowDecisions, seen: []))
  let stage = Stage(ScrollFixture(model: model))

  stage.open()
  describe(stage, "first opening")
  check("the first opening shows the first row", firstRowShows(stage))
  save(stage.render(), "popover-open-first.png")

  // The defect: what a retained host does without the top reset.
  stage.scroll(to: 500)
  stage.close()
  stage.open()
  describe(stage, "reopened after scrolling 500 pt, no reset")
  check("the cause: a retained hosting controller keeps its clip offset", stage.offset == 500)
  save(stage.render(), "popover-reopen-no-reset.png")
  stage.close()

  // The correction: AppState's will-show and did-show requests.
  model.request.toTop()
  stage.open()
  describe(stage, "will-show requested the top before the content had a window")
  model.request.repeatLast()
  stage.settle()
  describe(stage, "did-show repeated the request")
  check("reopening after scrolling shows the first row", firstRowShows(stage))
  save(stage.render(), "popover-reopen-reset.png")

  // The live review's case: a row sorts above a kept offset while closed.
  stage.scroll(to: 30)
  stage.close()
  model.items = items(
    [decision(["id": "fresh", "title": "A new urgent decision that sorts above every other row in the list?", "priority": "urgent", "agent_session_id": "ags_2"])]
      + overflowDecisions, seen: [])
  stage.open()
  describe(stage, "an urgent row arrived above a kept 30 pt offset, no reset")
  check("the cause: the new first row's title is out of view", stage.offset == 30)
  save(stage.render(), "popover-urgent-above-offset-no-reset.png")
  stage.close()
  model.request.toTop()
  stage.open()
  model.request.repeatLast()
  stage.settle()
  describe(stage, "the same arrival with the requests")
  check("the new urgent row's title shows at the top", firstRowShows(stage))

  // A refreshed snapshot while open at the top keeps the top.
  model.items = items(
    [decision(["id": "fresh2", "title": "Another urgent decision that arrives while the popover is open?", "priority": "urgent", "agent_session_id": "ags_2"])]
      + overflowDecisions, seen: [])
  stage.settle()
  check("a read that lands at the top stays at the top", firstRowShows(stage))

  // A strip inserted above a full list, which the 470 pt fixed list overflowed.
  model.undo = "Approve · Delete the stale preview databases?"
  stage.settle()
  line(String(format: "with the Undo strip: popover %.0f pt, list %.0f pt", stage.host.view.bounds.height, stage.list.bounds.height))
  check("the Undo strip shortens the list and the popover stays within 560 pt", stage.host.preferredContentSize.height <= 560)
  check("the strip leaves the first row at the top of the list", firstRowShows(stage))
  model.undo = nil
  stage.settle()

  // The agents list expanded with the quiet sessions revealed.
  model.expanded = true
  stage.settle()
  line(String(format: "agents expanded: popover %.0f pt, list %.0f pt", stage.host.view.bounds.height, stage.list.bounds.height))
  check("the expanded agents list stays within 560 pt", stage.host.preferredContentSize.height <= 560)
  model.undo = "Approve · Delete the stale preview databases?"
  stage.settle()
  check("agents and the strip together stay within 560 pt", stage.host.preferredContentSize.height <= 560)
  model.undo = nil
  model.expanded = false
  stage.settle()

  // A notification's row: requested after the top, so it wins, and the
  // did-show repeat keeps it.
  stage.close()
  model.request.toTop()
  model.request.toRow("o15")
  stage.open()
  model.request.repeatLast()
  stage.settle()
  describe(stage, "opened with a notification's row")
  check("a notification's row wins over the top reset", stage.offset > 0)
  let targetOffset = stage.offset

  // The same row asked for again, as a second click on its notification.
  stage.scroll(to: 0)
  model.request.toRow("o15")
  stage.settle()
  describe(stage, "the same row requested again")
  check("a repeated row target scrolls again", stage.offset == targetOffset)

  // A key press after an ordinary opening moves the list.
  stage.close()
  model.request.toTop()
  stage.open()
  model.request.repeatLast()
  stage.settle()
  check("an ordinary opening returns to the top after a row target", firstRowShows(stage))
  model.request.toRow(model.items.last!.id)
  stage.settle()
  describe(stage, "a selection change after opening")
  check("a selection change after opening scrolls to its row", stage.offset > 0)
  stage.scroll(to: 0)

  // The scroller.
  /// The scroller is installed and shown, and its knob reaches the pixels.
  func scrollerShows(_ scrollView: NSScrollView) -> Bool {
    guard let scroller = scrollView.verticalScroller as? ListScroller else { return false }
    return scrollView.scrollerStyle == .legacy && !scroller.isHidden && scroller.alphaValue == 1
      && scroller.knobProportion < 1 && knobPixels(scroller) > 0
  }
  line(
    String(
      format: "overflowing list: style %@, hidden %@, width %.0f pt, content width %.0f pt, knob pixels %d",
      stage.list.scrollerStyle == .legacy ? "legacy" : "overlay",
      (stage.list.verticalScroller?.isHidden ?? true) ? "yes" : "no",
      stage.list.verticalScroller?.frame.width ?? 0, stage.list.contentSize.width,
      stage.list.verticalScroller.map(knobPixels) ?? 0))
  check("an overflowing list keeps a visible scroller", scrollerShows(stage.list))
  // AppKit restores the system's style when the setting changes.
  stage.list.scrollerStyle = .overlay
  NotificationCenter.default.post(name: NSScroller.preferredScrollerStyleDidChangeNotification, object: nil)
  pump(0.1)
  check("the scroller returns after the Show scroll bars setting changes", scrollerShows(stage.list))
  model.items = items(Array(overflowDecisions.prefix(2)), seen: [])
  stage.settle()
  check("a list that fits shows no scroller", stage.list.verticalScroller?.isHidden ?? true)
  stage.close()

  // The agents list, with the live review's 18 sessions.
  let agentsModel = ScrollModel(items: items(Array(overflowDecisions.prefix(2)), seen: []))
  agentsModel.expanded = true
  let agentsStage = Stage(ScrollFixture(model: agentsModel, agents: manyAgents))
  agentsStage.open()
  let lists = scrollViews(in: agentsStage.host.view)
  let agentsList = lists.last!
  line(String(format: "agents list: %.0f pt shown of %.0f pt", agentsList.bounds.height, agentsList.documentView?.bounds.height ?? 0))
  check("the overflowing agents list stays at 160 pt", agentsList.bounds.height <= AgentsView.maxListHeight)
  check("the overflowing agents list keeps a visible scroller", scrollerShows(agentsList))
  agentsStage.close()

  failures.append(contentsOf: failed.map { "scrolling: \($0)" })
  line("")
}
