#!/bin/sh
# Builds the evidence harness from the shipped sources, runs it, runs the
# freshness and dot tests, and writes every output with a manifest to
# apps/macos/Evidence/output, or to the directory given as the first argument.
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

# The harness compiles the kit and four app-target files into one module, so
# their `import AgentDeskKit` lines are dropped.
cp "$macos"/AgentDeskKit/Sources/AgentDeskKit/*.swift "$macos"/AgentDeskKit/Sources/AgentDeskKit/Models/*.swift "$work/src/"
for file in DecisionRow AgentsView Ink MenuBarLabel; do
  sed '/^import AgentDeskKit$/d' "$macos/AgentDesk/$file.swift" >"$work/src/$file.swift"
done
cp "$here"/Harness/*.swift "$work/src/"

build_cmd="swiftc -swift-version 6 -O -o <tmp>/evidence <kit sources> AgentDesk/{DecisionRow,AgentsView,Ink,MenuBarLabel}.swift Evidence/Harness/*.swift"
swiftc -swift-version 6 -O -o "$work/evidence" "$work"/src/*.swift >"$out/build.log" 2>&1
build_exit=$?

harness_exit=127
if [ "$build_exit" -eq 0 ]; then
  "$work/evidence" "$out" >"$out/harness.log" 2>&1
  harness_exit=$?
fi

tests_cmd="swift test --package-path apps/macos/AgentDeskKit --filter 'SyncFreshnessTests|DotPresenceTests|SyncTests'"
swift test --package-path "$macos/AgentDeskKit" --filter 'SyncFreshnessTests|DotPresenceTests|SyncTests' >"$out/tests.log" 2>&1
tests_exit=$?
grep '^FRESHNESS' "$out/tests.log" >"$out/freshness.txt"

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
  printf '    {"command": "%s", "exit": %d, "log": "build.log"},\n' "$build_cmd" "$build_exit"
  printf '    {"command": "<tmp>/evidence apps/macos/Evidence/output", "exit": %d, "log": "harness.log", "report": "report.txt"},\n' "$harness_exit"
  printf '    {"command": "%s", "exit": %d, "log": "tests.log", "summary": "freshness.txt"}\n' "$tests_cmd" "$tests_exit"
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

echo "build=$build_exit harness=$harness_exit tests=$tests_exit dirty=$dirty -> $out"
[ "$build_exit" -eq 0 ] && [ "$harness_exit" -eq 0 ] && [ "$tests_exit" -eq 0 ]
