// swift-tools-version:5.9
// The native check of the cold notification press handoff. `run.sh` copies
// the pinned expo-notifications and expo-modules-core sources into
// `Generated/` and runs `swift test` on macOS. See README.md.
import PackageDescription

let package = Package(
  name: "NotificationActionNativeCheck",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "ExpoModulesCore", path: "Generated/ExpoModulesCore"),
    .target(name: "ExpoNotifications", dependencies: ["ExpoModulesCore"], path: "Generated/ExpoNotifications"),
    .target(name: "Handoff", dependencies: ["ExpoNotifications"], path: "Generated/Handoff"),
    .testTarget(name: "ColdPressHostStartTests", dependencies: ["Handoff", "ExpoNotifications"]),
  ]
)
