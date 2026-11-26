#!/usr/bin/env bash
# Runs the native check of the cold notification press handoff on macOS.
# It copies the pinned sources that the app builds with, so the check runs
# the real expo-notifications delegate loop and queue. See README.md.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
mobile="$(cd "$here/../../.." && pwd)"
generated="$here/Generated"

# The package directory of a dependency, resolved from the given directory
# the way Node and Metro resolve it.
resolve() {
  node -e 'const path = require("path"); process.stdout.write(path.dirname(require.resolve(process.argv[1] + "/package.json", { paths: [process.argv[2]] })))' "$1" "$2"
}
notifications="$(resolve expo-notifications "$mobile")"
modules_core="$(resolve expo-modules-core "$(resolve expo "$mobile")")"

echo "expo-notifications $(node -p "require('$notifications/package.json').version") at $notifications"
echo "expo-modules-core $(node -p "require('$modules_core/package.json').version") at $modules_core"

rm -rf "$generated"
mkdir -p "$generated/ExpoModulesCore" "$generated/ExpoNotifications" "$generated/Handoff"
cp "$modules_core/ios/Utilities/Mutex.swift" "$generated/ExpoModulesCore/"
cp "$here/Stubs/ExpoModulesCoreStubs.swift" "$generated/ExpoModulesCore/"
cp "$here/../ios/ColdPressHostStart.swift" "$generated/Handoff/"

manager_source="$notifications/ios/ExpoNotifications/Notifications/NotificationCenterManager.swift"
manager="$generated/ExpoNotifications/NotificationCenterManager.swift"
cp "$manager_source" "$manager"

# Two edits, and only these, replace the notification center calls that a
# test process cannot make. The delegate loop and the queue stay as pinned.
# Each edit must match exactly as often as expected, so a changed pinned
# source fails here instead of testing something else.
replace() {
  local pattern="$1" replacement="$2" expected="$3"
  local count
  count="$(grep -cF -- "$pattern" "$manager" || true)"
  if [ "$count" != "$expected" ]; then
    echo "expected $expected lines with: $pattern; found $count" >&2
    exit 1
  fi
  PATTERN="$pattern" REPLACEMENT="$replacement" perl -0pi -e 's/\Q$ENV{PATTERN}\E/$ENV{REPLACEMENT}/g' "$manager"
}
replace "  let userNotificationCenter: UNUserNotificationCenter = UNUserNotificationCenter.current()" "" 1
replace "UNUserNotificationCenter.current().delegate" "TestUserNotificationCenter.delegate" 2

echo "Edits to the pinned NotificationCenterManager.swift:"
diff -u "$manager_source" "$manager" || true

swift test --package-path "$here"
