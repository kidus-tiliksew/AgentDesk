#!/bin/sh
# Builds the evidence harness from the shipped sources, runs it, runs the full
# AgentDeskKit test suite, builds the app unsigned with Xcode, and writes every
# output with a manifest to apps/macos/Evidence/output, or to the directory
# given as the first argument.
# It needs only Xcode's toolchain: no account, network, or permission.
set -u

here=$(cd "$(dirname "$0")" && pwd)
macos=$(dirname "$here")
root=$(git -C "$macos" rev-parse --show-toplevel)
out=${1:-"$here/output"}
work=$(mktemp -d)
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

# Logs name the repository and scratch paths relatively, so they hold no
# machine-specific directory.
for log in "$out"/*.log; do
  sed -i '' -e "s#$root/##g" -e "s#$root#.#g" -e "s#$work#<tmp>#g" -e "s#$HOME#~#g" "$log"
done

# The manifest ties the outputs to the committed sources by Git tree hash, so
# a reader can check them against any later commit with `git rev-parse
# <commit>:<path>`.
tree() { git -C "$root" rev-parse "HEAD:$1"; }
dirty=false
if [ -n "$(git -C "$root" status --porcelain -- apps/macos/AgentDesk apps/macos/AgentDeskKit apps/macos/Evidence/Harness apps/macos/Evidence/run.sh)" ]; then
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
  printf '    {\n      "command": "%s",\n      "exit": %d,\n      "log": "xcodebuild.log"\n    }\n' "$xcodebuild_cmd" "$xcodebuild_exit"
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

echo "build=$build_exit harness=$harness_exit tests=$tests_exit xcodebuild=$xcodebuild_exit ignored=$ignored_exit dirty=$dirty -> $out"
[ "$build_exit" -eq 0 ] && [ "$harness_exit" -eq 0 ] && [ "$tests_exit" -eq 0 ] && [ "$xcodebuild_exit" -eq 0 ] && [ "$ignored_exit" -eq 0 ]
