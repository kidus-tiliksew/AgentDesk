#!/bin/sh
# Builds the evidence harness from the shipped sources, runs it, runs the full
# AgentDeskKit test suite, builds the app unsigned with Xcode, and writes every
# output with a manifest to apps/macos/Evidence/output, or to the directory
# given as the first argument.
# It then audits the built bundle's Sparkle keys, checks and tests the release
# script, and runs the release script's dry runs in a throwaway clone.
# It needs Xcode's toolchain and the network, to resolve the pinned Sparkle
# package and read the origin remote's tags: no account or permission.
set -u

here=$(cd "$(dirname "$0")" && pwd)
macos=$(dirname "$here")
root=$(git -C "$macos" rev-parse --show-toplevel)
out=${1:-"$here/output"}
# Git prints the resolved /private/var path and Xcode the /var one, so logs
# scrub both.
work_link=$(mktemp -d)
work=$(cd "$work_link" && pwd -P)
trap 'rm -rf "$work"' EXIT

mkdir -p "$out" "$work/src"
rm -f "$out"/*.png "$out"/*.txt "$out"/*.log "$out"/manifest.json

# The harness compiles the kit and seven app-target files into one module, so
# their `import AgentDeskKit` lines are dropped.
cp "$macos"/AgentDeskKit/Sources/AgentDeskKit/*.swift "$macos"/AgentDeskKit/Sources/AgentDeskKit/Models/*.swift "$work/src/"
for file in DecisionRow AnswerControls AgentsView Ink MenuBarLabel NotificationController NotificationPauseLine; do
  sed '/^import AgentDeskKit$/d' "$macos/AgentDesk/$file.swift" >"$work/src/$file.swift"
done
cp "$here"/Harness/*.swift "$work/src/"

build_cmd="swiftc -swift-version 6 -O -o <tmp>/evidence <kit sources> AgentDesk/{DecisionRow,AnswerControls,AgentsView,Ink,MenuBarLabel,NotificationController,NotificationPauseLine}.swift Evidence/Harness/*.swift"
swiftc -swift-version 6 -O -o "$work/evidence" "$work"/src/*.swift >"$out/build.log" 2>&1
build_exit=$?

harness_exit=127
if [ "$build_exit" -eq 0 ]; then
  "$work/evidence" "$out" >"$out/harness.log" 2>&1
  harness_exit=$?
fi

# The full suite, as CI runs it; the freshness measurement is part of it.
tests_cmd="swift test --package-path apps/macos/AgentDeskKit"
swift test --package-path "$macos/AgentDeskKit" >"$out/tests.log" 2>&1
tests_exit=$?
grep '^FRESHNESS' "$out/tests.log" >"$out/freshness.txt"

# The unsigned app build, as CI runs it. A scratch derived-data directory
# makes every run compile the app and the package from scratch, so the log
# holds every compile step.
xcodebuild_cmd="xcodebuild build -project apps/macos/AgentDesk.xcodeproj -scheme AgentDesk -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO -derivedDataPath <tmp>/DerivedData"
(cd "$root" && xcodebuild build -project apps/macos/AgentDesk.xcodeproj -scheme AgentDesk \
  -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "$work/DerivedData") >"$out/xcodebuild.log" 2>&1
xcodebuild_exit=$?

# The bundle the unsigned build produced: each Sparkle key's value and type,
# the public key's decoded length, and the embedded framework. Any value other
# than the expected one fails the step.
app="$work/DerivedData/Build/Products/Debug/AgentDesk.app"
bundle_exit=0
{
  info="$app/Contents/Info.plist"
  for entry in \
    "SUFeedURL string https://github.com/kidus-tiliksew/AgentDesk/releases/download/macos-appcast/appcast.xml" \
    "SUPublicEDKey string $(plutil -extract SUPublicEDKey raw -o - "$macos/AgentDesk-Info.plist")" \
    "SUEnableAutomaticChecks bool true" \
    "SUScheduledCheckInterval integer 86400" \
    "SUAutomaticallyUpdate bool false" \
    "SUAllowsAutomaticUpdates bool false" \
    "SUEnableSystemProfiling bool false"; do
    set -- $entry
    got_type=$(plutil -type "$1" "$info" 2>/dev/null)
    got_value=$(plutil -extract "$1" raw -o - "$info" 2>/dev/null) || got_value="<missing>"
    if [ "$got_type" = "$2" ] && [ "$got_value" = "$3" ]; then verdict=ok; else verdict=FAIL; bundle_exit=1; fi
    printf '%s %s %s = %s\n' "$verdict" "$1" "${got_type:-<missing>}" "$got_value"
  done
  key_bytes=$(plutil -extract SUPublicEDKey raw -o - "$info" 2>/dev/null | base64 -d 2>/dev/null | wc -c | tr -d ' ')
  if [ "$key_bytes" = 32 ]; then verdict=ok; else verdict=FAIL; bundle_exit=1; fi
  printf '%s SUPublicEDKey decodes to %s bytes, an Ed25519 public key\n' "$verdict" "$key_bytes"
  framework="$app/Contents/Frameworks/Sparkle.framework"
  sparkle_version=$(plutil -extract CFBundleShortVersionString raw -o - "$framework/Resources/Info.plist" 2>/dev/null) || sparkle_version="<missing>"
  if [ "$sparkle_version" = 2.10.1 ]; then verdict=ok; else verdict=FAIL; bundle_exit=1; fi
  printf '%s Contents/Frameworks/Sparkle.framework CFBundleShortVersionString = %s\n' "$verdict" "$sparkle_version"
} >"$out/bundle.txt" 2>&1

# The release script: syntax of both scripts, then its stub-command checks.
release_tests_cmd="bash -n apps/macos/scripts/release.sh && bash -n apps/macos/scripts/test-release.sh && bash apps/macos/scripts/test-release.sh"
(cd "$root" && bash -n apps/macos/scripts/release.sh && bash -n apps/macos/scripts/test-release.sh \
  && bash apps/macos/scripts/test-release.sh) >"$out/release-tests.log" 2>&1
release_tests_exit=$?

# Dry runs against a clean clone of this commit whose origin is the real
# remote, since the outputs above make this checkout dirty. Each run states
# its expected exit; a different exit fails the step. The existing tag is
# created only in the clone.
clone="$work/clone"
dry_run_exit=0
{
  git clone -q --no-checkout "$root" "$clone" && git -C "$clone" checkout -q --detach "$(git -C "$root" rev-parse HEAD)" \
    && git -C "$clone" remote set-url origin "$(git -C "$root" remote get-url origin)" || dry_run_exit=1
  dry_run() {
    want=$1
    shift
    echo "\$ apps/macos/scripts/release.sh $* (expect exit $want)"
    "$clone/apps/macos/scripts/release.sh" "$@" 2>&1
    got=$?
    if [ "$got" = "$want" ]; then echo "ok exit $got"; else echo "FAIL exit $got"; dry_run_exit=1; fi
    echo
  }
  dry_run 1 0.1 --dry-run
  touch "$clone/untracked.txt"
  echo "(untracked.txt added to the clone)"
  dry_run 1 0.1.0 --dry-run
  rm "$clone/untracked.txt"
  git -C "$clone" tag macos-v0.0.1
  echo "(tag macos-v0.0.1 created in the clone)"
  dry_run 1 0.0.1 --dry-run
  dry_run 0 0.1.0 --dry-run
} >"$out/release-dry-run.log" 2>&1

# Logs name the repository and scratch paths relatively, so they hold no
# machine-specific directory.
for log in "$out"/*.log "$out/bundle.txt"; do
  sed -i '' -e "s#$root/##g" -e "s#$root#.#g" -e "s#$work#<tmp>#g" -e "s#$work_link#<tmp>#g" -e "s#$HOME#~#g" "$log"
done

# The manifest ties the outputs to the committed sources by Git tree hash, so
# a reader can check them against any later commit with `git rev-parse
# <commit>:<path>`.
tree() { git -C "$root" rev-parse "HEAD:$1"; }
dirty=false
if [ -n "$(git -C "$root" status --porcelain -- apps/macos/AgentDesk apps/macos/AgentDeskKit apps/macos/AgentDesk-Info.plist apps/macos/AgentDesk.xcodeproj apps/macos/scripts apps/macos/Evidence/Harness apps/macos/Evidence/run.sh)" ]; then
  dirty=true
fi
{
  printf '{\n'
  printf '  "generated_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "source_commit": "%s",\n' "$(git -C "$root" rev-parse HEAD)"
  printf '  "sources_dirty": %s,\n' "$dirty"
  printf '  "source_trees": {\n'
  printf '    "apps/macos/AgentDesk": "%s",\n' "$(tree apps/macos/AgentDesk)"
  printf '    "apps/macos/AgentDeskKit": "%s",\n' "$(tree apps/macos/AgentDeskKit)"
  printf '    "apps/macos/AgentDesk-Info.plist": "%s",\n' "$(tree apps/macos/AgentDesk-Info.plist)"
  printf '    "apps/macos/AgentDesk.xcodeproj": "%s",\n' "$(tree apps/macos/AgentDesk.xcodeproj)"
  printf '    "apps/macos/scripts": "%s",\n' "$(tree apps/macos/scripts)"
  printf '    "apps/macos/Evidence/Harness": "%s",\n' "$(tree apps/macos/Evidence/Harness)"
  printf '    "apps/macos/Evidence/run.sh": "%s"\n' "$(tree apps/macos/Evidence/run.sh)"
  printf '  },\n'
  printf '  "toolchain": "%s; %s",\n' "$(xcodebuild -version | tr '\n' ' ' | sed 's/ *$//')" "$(swift --version 2>&1 | head -1)"
  printf '  "macos": "%s",\n' "$(sw_vers -productVersion)"
  printf '  "commands": [\n'
  # One key per line, as the repository's Biome formatter writes JSON.
  printf '    {\n      "command": "%s",\n      "exit": %d,\n      "log": "build.log"\n    },\n' "$build_cmd" "$build_exit"
  printf '    {\n      "command": "<tmp>/evidence apps/macos/Evidence/output",\n      "exit": %d,\n      "log": "harness.log",\n      "report": "report.txt"\n    },\n' "$harness_exit"
  printf '    {\n      "command": "%s",\n      "exit": %d,\n      "log": "tests.log",\n      "summary": "freshness.txt"\n    },\n' "$tests_cmd" "$tests_exit"
  printf '    {\n      "command": "%s",\n      "exit": %d,\n      "log": "xcodebuild.log"\n    },\n' "$xcodebuild_cmd" "$xcodebuild_exit"
  printf '    {\n      "command": "plutil and base64 on <tmp>/DerivedData/Build/Products/Debug/AgentDesk.app",\n      "exit": %d,\n      "log": "bundle.txt"\n    },\n' "$bundle_exit"
  printf '    {\n      "command": "%s",\n      "exit": %d,\n      "log": "release-tests.log"\n    },\n' "$release_tests_cmd" "$release_tests_exit"
  printf '    {\n      "command": "apps/macos/scripts/release.sh dry runs in <tmp>/clone at source_commit",\n      "exit": %d,\n      "log": "release-dry-run.log"\n    }\n' "$dry_run_exit"
  printf '  ],\n'
  printf '  "outputs": {\n'
  first=true
  for file in "$out"/*; do
    name=$(basename "$file")
    [ "$name" = manifest.json ] && continue
    if [ "$first" = true ]; then first=false; else printf ',\n'; fi
    printf '    "%s": "sha256:%s"' "$name" "$(shasum -a 256 "$file" | cut -d' ' -f1)"
  done
  printf '\n  }\n'
  printf '}\n'
} >"$out/manifest.json"

# Every output the manifest names must be committable; an ignore rule that
# drops one fails the run instead of leaving the manifest unresolvable.
ignored=$(cd "$out" && git -C "$root" check-ignore --no-index -- "$out"/* 2>/dev/null | sed "s#^$out/##")
ignored_exit=0
if [ -n "$ignored" ]; then
  echo "git ignores these outputs: $(echo "$ignored" | tr '\n' ' ')" >&2
  ignored_exit=1
fi

echo "build=$build_exit harness=$harness_exit tests=$tests_exit xcodebuild=$xcodebuild_exit bundle=$bundle_exit release_tests=$release_tests_exit dry_run=$dry_run_exit ignored=$ignored_exit dirty=$dirty -> $out"
[ "$build_exit" -eq 0 ] && [ "$harness_exit" -eq 0 ] && [ "$tests_exit" -eq 0 ] && [ "$xcodebuild_exit" -eq 0 ] \
  && [ "$bundle_exit" -eq 0 ] && [ "$release_tests_exit" -eq 0 ] && [ "$dry_run_exit" -eq 0 ] && [ "$ignored_exit" -eq 0 ]
