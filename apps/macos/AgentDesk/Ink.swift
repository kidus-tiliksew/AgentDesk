import AppKit
import SwiftUI

/// Text and dot colors for the popover. Each text ink has a contrast ratio of
/// at least 4.5:1 on the popover background in light, dark, and Increase
/// Contrast (req-mac-app AC-7.3). The system's secondary and tertiary label
/// colors and system red fall below 4.5:1 on the light popover, so the popover
/// draws metadata, suggestions, and red with these instead. The green, amber,
/// and indigo dot inks are non-text, and each dot's state also reads as text,
/// so each has at least 3:1 (component-mac-app §Keyboard and accessibility).
/// Each ink follows the appearance, and Increase Contrast moves each toward the
/// label color.
@MainActor
enum Ink {
  /// Metadata and the waiting count.
  static let secondary = secondaryShades.color
  /// Suggestions and agent states.
  static let tertiary = tertiaryShades.color
  /// The Urgent marker, an urgent row's time left, time left under 5 minutes,
  /// the blocked count, and a blocked session's dot, the popover's only red
  /// (req-mac-app AC-4.3, AC-5.1).
  static let red = redShades.color
  /// A working session's dot. Fills 6 pt dots only and colors no text
  /// (req-mac-app AC-5.5).
  static let green = greenShades.color
  /// A waiting session's dot. Fills 6 pt dots only and colors no text
  /// (req-mac-app AC-5.5).
  static let amber = amberShades.color
  /// A new decision's dot. Fills 6 pt dots only and colors no text
  /// (req-mac-app AC-4.4).
  static let indigo = indigoShades.color

  static let secondaryShades = Shades(
    light: gray(0x47), dark: gray(0xC4), lightHigh: gray(0x2B), darkHigh: gray(0xE0))
  static let tertiaryShades = Shades(
    light: gray(0x5A), dark: gray(0xAD), lightHigh: gray(0x3A), darkHigh: gray(0xD0))
  static let redShades = Shades(
    light: rgb(0xA8, 0x1F, 0x18), dark: rgb(0xFF, 0x8C, 0x83),
    lightHigh: rgb(0x96, 0x14, 0x0E), darkHigh: rgb(0xFF, 0x9A, 0x92))
  static let greenShades = Shades(
    light: rgb(0x12, 0x70, 0x3A), dark: rgb(0x34, 0xC4, 0x6A),
    lightHigh: rgb(0x0C, 0x5A, 0x2C), darkHigh: rgb(0x4C, 0xD9, 0x82))
  static let amberShades = Shades(
    light: rgb(0x8F, 0x54, 0x00), dark: rgb(0xFF, 0xB3, 0x40),
    lightHigh: rgb(0x6E, 0x41, 0x00), darkHigh: rgb(0xFF, 0xC5, 0x66))
  static let indigoShades = Shades(
    light: rgb(0x4F, 0x46, 0xE5), dark: rgb(0x99, 0x93, 0xFF),
    lightHigh: rgb(0x37, 0x30, 0xA3), darkHigh: rgb(0xB3, 0xAF, 0xFF))

  /// One ink in each appearance.
  struct Shades {
    let light: NSColor
    let dark: NSColor
    let lightHigh: NSColor
    let darkHigh: NSColor

    var color: Color {
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
  }

  private static func gray(_ value: Int) -> NSColor {
    rgb(value, value, value)
  }

  private static func rgb(_ red: Int, _ green: Int, _ blue: Int) -> NSColor {
    NSColor(
      srgbRed: CGFloat(red) / 255, green: CGFloat(green) / 255, blue: CGFloat(blue) / 255, alpha: 1)
  }
}
