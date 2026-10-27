import AppKit
import SwiftUI

/// Text colors for the popover, each with a contrast ratio of at least 4.5:1
/// on the popover background in light, dark, and Increase Contrast
/// (req-mac-app AC-7.3). The system's secondary and tertiary label colors
/// and system red fall below 4.5:1 on the light popover, so the popover
/// draws metadata, suggestions, and red with these instead. Each follows the
/// appearance, and Increase Contrast moves each toward the label color.
enum Ink {
  /// Metadata and the waiting count.
  static let secondary = dynamic(
    light: gray(0x47), dark: gray(0xC4), lightHigh: gray(0x2B), darkHigh: gray(0xE0))
  /// Suggestions and agent states.
  static let tertiary = dynamic(
    light: gray(0x5A), dark: gray(0xA6), lightHigh: gray(0x3A), darkHigh: gray(0xD0))
  /// Time left under 5 minutes and the blocked count, the popover's only red
  /// (req-mac-app AC-4.3, AC-5.1).
  static let red = dynamic(
    light: rgb(0xA8, 0x1F, 0x18), dark: rgb(0xFF, 0x7A, 0x70),
    lightHigh: rgb(0x96, 0x14, 0x0E), darkHigh: rgb(0xFF, 0x9A, 0x92))

  private static func dynamic(light: NSColor, dark: NSColor, lightHigh: NSColor, darkHigh: NSColor)
    -> Color
  {
    Color(
      nsColor: NSColor(name: nil) { appearance in
        switch appearance.bestMatch(from: [
          .aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua,
        ]) {
        case .darkAqua: dark
        case .accessibilityHighContrastAqua: lightHigh
        case .accessibilityHighContrastDarkAqua: darkHigh
        default: light
        }
      })
  }

  private static func gray(_ value: Int) -> NSColor {
    rgb(value, value, value)
  }

  private static func rgb(_ red: Int, _ green: Int, _ blue: Int) -> NSColor {
    NSColor(
      srgbRed: CGFloat(red) / 255, green: CGFloat(green) / 255, blue: CGFloat(blue) / 255, alpha: 1)
  }
}
