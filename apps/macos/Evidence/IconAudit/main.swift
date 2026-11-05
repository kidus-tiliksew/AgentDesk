import AppKit

// Asks macOS for the icon of a built app bundle, as Finder does, and compares
// it with the generic application icon and the icon's source. It reads files
// only and never launches the bundle. `run.sh` runs it on the unsigned build.
//
// Usage: icon-audit <app> <source png> <output png>

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
  print("FAIL usage: icon-audit <app> <source png> <output png>")
  exit(2)
}
let side = 128

func pixels(_ image: NSImage) -> [Double] {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor.white.setFill()
  NSRect(x: 0, y: 0, width: side, height: side).fill()
  image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
  NSGraphicsContext.restoreGraphicsState()
  var values: [Double] = []
  for y in 0..<side {
    for x in 0..<side {
      let color = rep.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
      values += [color.redComponent, color.greenComponent, color.blueComponent].map(Double.init)
    }
  }
  return values
}

func distance(_ a: [Double], _ b: [Double]) -> Double {
  zip(a, b).map { abs($0 - $1) }.reduce(0, +) / Double(a.count)
}

let bundleIcon = NSWorkspace.shared.icon(forFile: arguments[1])
let generic = NSWorkspace.shared.icon(for: .applicationBundle)
guard let source = NSImage(contentsOfFile: arguments[2]) else {
  print("FAIL cannot read \(arguments[2])")
  exit(1)
}

let (icon, sourcePixels, genericPixels) = (pixels(bundleIcon), pixels(source), pixels(generic))
let fromGeneric = distance(icon, genericPixels)
let fromSource = distance(icon, sourcePixels)
let sourceFromGeneric = distance(sourcePixels, genericPixels)
print(String(format: "NSWorkspace icon differs from the generic app icon by %.3f", fromGeneric))
print(String(format: "NSWorkspace icon differs from the source icon by %.3f", fromSource))
print(String(format: "the source icon differs from the generic app icon by %.3f", sourceFromGeneric))

bundleIcon.size = NSSize(width: 256, height: 256)
let tiff = bundleIcon.tiffRepresentation!
let png = NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: arguments[3]))

if fromGeneric > 0.05 && fromSource < fromGeneric {
  print("ok the built bundle's icon is the AgentDesk icon, not the generic app icon")
  exit(0)
}
print("FAIL the built bundle's icon is not the AgentDesk icon")
exit(1)
