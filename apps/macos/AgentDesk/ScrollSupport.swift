import AppKit
import SwiftUI

/// Keeps the enclosing list's scroller visible while the list overflows,
/// whatever the system's Show scroll bars setting is (component-mac-app §List
/// scrolling; req-mac-app AC-4.13). SwiftUI's `.scrollIndicators(.visible)`
/// alone still fades overlay scrollers, so this installs `ListScroller` on the
/// `NSScrollView` behind the SwiftUI `ScrollView`. Autohiding stays on, so a
/// list that fits shows none. Place it in the background of the scrolled
/// content.
struct PersistentScroller: NSViewRepresentable {
  func makeNSView(context: Context) -> Locator {
    Locator()
  }

  func updateNSView(_ view: Locator, context: Context) {
    view.apply()
  }

  final class Locator: NSView {
    private var styleObserver: NSObjectProtocol?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let styleObserver {
        NotificationCenter.default.removeObserver(styleObserver)
        self.styleObserver = nil
      }
      guard window != nil else { return }
      apply()
      // AppKit restores the preferred style when the setting or the pointing
      // device changes.
      styleObserver = NotificationCenter.default.addObserver(
        forName: NSScroller.preferredScrollerStyleDidChangeNotification, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.apply() }
      }
    }

    func apply() {
      guard let scrollView = enclosingScrollView else { return }
      if scrollView.scrollerStyle != .legacy { scrollView.scrollerStyle = .legacy }
      scrollView.hasVerticalScroller = true
      scrollView.autohidesScrollers = true
      if !(scrollView.verticalScroller is ListScroller) {
        scrollView.verticalScroller = ListScroller()
      }
      scrollView.verticalScroller?.controlSize = .small
    }
  }
}

/// A scroller that draws its own knob in tertiary ink with no track, so it
/// stays visible and calm on the popover material. A scroller subclass is not
/// compatible with overlay scrollers, which keeps it in the legacy style.
final class ListScroller: NSScroller {
  override func draw(_ dirtyRect: NSRect) {
    drawKnob()
  }

  override func drawKnob() {
    let knob = rect(for: .knob).insetBy(dx: 1, dy: 0)
    guard knob.height > 0 else { return }
    NSColor(Ink.tertiary).withAlphaComponent(Self.knobOpacity).setFill()
    NSBezierPath(roundedRect: knob, xRadius: knob.width / 2, yRadius: knob.width / 2).fill()
  }

  /// Opaque enough for 3:1 against the popover while staying quieter than
  /// the text beside it.
  static let knobOpacity: CGFloat = 0.7
}

extension View {
  /// Reports this view's height, for the popover's height budget.
  func measuredHeight(_ height: Binding<CGFloat>) -> some View {
    onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height.wrappedValue = $0 }
  }
}
