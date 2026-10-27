import AppKit
import SwiftUI

/// The menu bar item: the Prompt bubble mark as one template glyph, so AppKit
/// draws it in the menu bar's text color (component-mac-app §Menu bar item;
/// req-mac-app AC-3.2). This slice draws no dot or count.
struct MenuBarLabel: View {
  var body: some View {
    Image(nsImage: PromptGlyph.image)
      .accessibilityLabel("AgentDesk")
  }
}

/// The Prompt bubble mark, a speech bubble holding a terminal prompt
/// (DEC-9(3)), drawn as an 18 × 18 pt outline from the app icon's geometry.
enum PromptGlyph {
  static let size = NSSize(width: 18, height: 18)

  static let image: NSImage = {
    let image = NSImage(size: size, flipped: true) { _ in
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
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "AgentDesk"
    return image
  }()

  // The icon's bubble spans x 270–754 and y 326–728 on a 1024 canvas. It is
  // scaled to 15 pt wide and centred.
  private static let scale: CGFloat = 15 / 484
  private static let origin = CGPoint(x: 1.5, y: (18 - 402 * 15 / 484) / 2)

  private static func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: origin.x + (x - 270) * scale, y: origin.y + (y - 326) * scale)
  }

  private static func bubblePath() -> NSBezierPath {
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
