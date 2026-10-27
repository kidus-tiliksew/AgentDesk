// swift-tools-version: 6.0

import PackageDescription

// Everything in the Mac app that runs without a window. The library imports
// Foundation, Security, and OSLog only, so `swift test` runs on any macOS
// runner (component-mac-app §Project layout).
let package = Package(
  name: "AgentDeskKit",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "AgentDeskKit", targets: ["AgentDeskKit"])
  ],
  targets: [
    .target(name: "AgentDeskKit"),
    .testTarget(name: "AgentDeskKitTests", dependencies: ["AgentDeskKit"]),
  ]
)
