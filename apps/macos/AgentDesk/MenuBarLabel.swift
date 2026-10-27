import AgentDeskKit
import AppKit
import SwiftUI

/// The menu bar item: one template image, so AppKit draws glyph, dot, and
/// count in the menu bar's text color (component-mac-app §Menu bar item;
/// req-mac-app AC-3.2). The dot style adds a dot while `Attention.dot` holds;
/// the count style adds the pending count and never a dot (AC-3.4).
struct MenuBarLabel: View {
  let state: AppState

  var body: some View {
    let description = state.labelDescription
    Image(nsImage: image(description: description))
      .accessibilityLabel(description)
  }

  private func image(description: String) -> NSImage {
    switch state.menuBarStyle {
    case .count where state.isSignedIn && state.summary.count > 0:
      PromptGlyph.image(count: state.summary.count, description: description)
    default:
      PromptGlyph.image(dotOpacity: state.dotOpacity, description: description)
    }
  }
}

/// The Prompt bubble mark, a speech bubble holding a terminal prompt
/// (DEC-9(3)), drawn as an 18 × 18 pt outline from the app icon's geometry.
/// `NSImage` is not Sendable in every SDK, so the glyph lives on the main
/// actor with the views that draw it.
@MainActor
enum PromptGlyph {
  static let size = NSSize(width: 18, height: 18)
  /// The dot's fade-in when it first appears (req-mac-app AC-3.5).
  static let fadeDuration: TimeInterval = 0.35

  /// The glyph, with a 6 pt dot at its top right when `dotOpacity` is above
  /// zero. A 1.5 pt transparent ring is cut around the dot.
  static func image(dotOpacity: Double, description: String) -> NSImage {
    let image = NSImage(size: size, flipped: true) { _ in
      drawGlyph()
      if dotOpacity > 0 {
        drawDot(opacity: dotOpacity)
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = description
    return image
  }

  /// The glyph followed by the pending count in the menu bar font.
  static func image(count: Int, description: String) -> NSImage {
    let text = NSAttributedString(
      string: "\(count)",
      attributes: [.font: NSFont.menuBarFont(ofSize: 0), .foregroundColor: NSColor.black])
    let textSize = text.size()
    let gap: CGFloat = 4
    let glyph = size
    let width = (glyph.width + gap + textSize.width).rounded(.up)
    let origin = NSPoint(x: glyph.width + gap, y: (glyph.height - textSize.height) / 2)
    let image = NSImage(size: NSSize(width: width, height: glyph.height), flipped: true) { _ in
      drawGlyph()
      text.draw(at: origin)
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = description
    return image
  }

  nonisolated private static func drawGlyph() {
    NSColor.black.setStroke()
    let bubble = bubblePath()
    bubble.lineWidth = 1.5
    bubble.lineJoinStyle = .round
    bubble.stroke()

    let prompt = NSBezierPath()
    prompt.move(to: point(398, 430))
    prompt.line(to: point(466, 487))
    prompt.line(to: point(398, 544))
    prompt.lineWidth = 1.5
    prompt.lineCapStyle = .round
    prompt.lineJoinStyle = .round
    prompt.stroke()
  }

  // The dot is 6 pt across with its edge on the image's top and right; the
  // ring is the 1.5 pt band around it, cleared to transparent.
  nonisolated private static let dotRect = NSRect(x: 12, y: 0, width: 6, height: 6)

  nonisolated private static func drawDot(opacity: Double) {
    guard let context = NSGraphicsContext.current else { return }
    context.saveGraphicsState()
    context.compositingOperation = .clear
    NSBezierPath(ovalIn: dotRect.insetBy(dx: -1.5, dy: -1.5)).fill()
    context.compositingOperation = .sourceOver
    NSColor.black.withAlphaComponent(opacity).setFill()
    NSBezierPath(ovalIn: dotRect).fill()
    context.restoreGraphicsState()
  }

  // The icon's bubble spans x 270–754 and y 326–728 on a 1024 canvas. It is
  // scaled to 15 pt wide and centred.
  nonisolated private static let scale: CGFloat = 15 / 484
  nonisolated private static let origin = CGPoint(x: 1.5, y: (18 - 402 * 15 / 484) / 2)

  nonisolated private static func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: origin.x + (x - 270) * scale, y: origin.y + (y - 326) * scale)
  }

  nonisolated private static func bubblePath() -> NSBezierPath {
    let radius = 80 * scale
    let path = NSBezierPath()
    path.move(to: point(350, 326))
    path.line(to: point(674, 326))
    path.appendArc(from: point(754, 326), to: point(754, 406), radius: radius)
    path.line(to: point(754, 568))
    path.appendArc(from: point(754, 648), to: point(674, 648), radius: radius)
    path.line(to: point(494, 648))
    path.line(to: point(394, 728))
    path.line(to: point(394, 648))
    path.line(to: point(350, 648))
    path.appendArc(from: point(270, 648), to: point(270, 568), radius: radius)
    path.line(to: point(270, 406))
    path.appendArc(from: point(270, 326), to: point(350, 326), radius: radius)
    path.close()
    return path
  }
}
