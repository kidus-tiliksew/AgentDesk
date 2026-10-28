#!/usr/bin/env bash
# Checks release.sh in throwaway Git repositories with stub commands, so
# nothing is archived, signed, notarized, or published.
#
# Usage: apps/macos/scripts/test-release.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
release_script="$script_dir/release.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/agentdesk-release-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   $*"; }
flunk() { echo "FAIL $*"; failures=$((failures + 1)); }

# Stub commands. Each appends its call to $STUB_LOG; $STUB_FAIL names the
# step that fails.
stubs="$work/stubs"
mkdir -p "$stubs"

cat >"$stubs/xcodebuild" <<'STUB'
#!/usr/bin/env bash
echo "xcodebuild $*" >>"$STUB_LOG"
arg_after() { local want="$1"; shift; while (($#)); do [[ "$1" == "$want" ]] && { echo "$2"; return; }; shift; done; }
setting() { local want="$1"; shift; for a in "$@"; do [[ "$a" == "$want="* ]] && echo "${a#*=}"; done; return 0; }
case " $* " in
  *" -resolvePackageDependencies "*)
    bin="$(arg_after -clonedSourcePackagesDirPath "$@")/artifacts/sparkle/Sparkle/bin"
    mkdir -p "$bin"
    cat >"$bin/sign_update" <<'TOOL'
#!/usr/bin/env bash
echo "sign_update $*" >>"$STUB_LOG"
[[ "$STUB_FAIL" == sign ]] && exit 1
echo "STUBSIGNATURE=="
TOOL
    cat >"$bin/generate_keys" <<'TOOL'
#!/usr/bin/env bash
echo "generate_keys $*" >>"$STUB_LOG"
[[ "$STUB_FAIL" == keymismatch ]] && { echo "OTHERKEY="; exit 0; }
echo "STUBPUBLICKEY="
TOOL
    chmod +x "$bin/sign_update" "$bin/generate_keys"
    ;;
  *" archive "*)
    [[ "$STUB_FAIL" == archive ]] && exit 65
    archive="$(arg_after -archivePath "$@")"
    mkdir -p "$archive"
    setting MARKETING_VERSION "$@" >"$archive/version"
    setting CURRENT_PROJECT_VERSION "$@" >"$archive/build"
    ;;
  *" -exportArchive "*)
    [[ "$STUB_FAIL" == export ]] && exit 70
    archive="$(arg_after -archivePath "$@")"
    app="$(arg_after -exportPath "$@")/AgentDesk.app"
    mkdir -p "$app/Contents"
    plist="$app/Contents/Info.plist"
    plutil -create xml1 "$plist"
    plutil -insert CFBundleShortVersionString -string "$(cat "$archive/version")" "$plist"
    plutil -insert CFBundleVersion -string "$(cat "$archive/build")" "$plist"
    plutil -insert SUPublicEDKey -string "STUBPUBLICKEY=" "$plist"
    plutil -insert LSMinimumSystemVersion -string "14.0" "$plist"
    ;;
esac
exit 0
STUB

cat >"$stubs/xcrun" <<'STUB'
#!/usr/bin/env bash
echo "xcrun $*" >>"$STUB_LOG"
case "$1 $2" in
  "notarytool submit")
    [[ "$STUB_FAIL" == notary ]] && exit 1
    status=Accepted
    [[ "$STUB_FAIL" == notary-invalid ]] && status=Invalid
    echo "{\"id\":\"stub-submission\",\"status\":\"$status\"}"
    ;;
  "stapler staple") [[ "$STUB_FAIL" == staple ]] && exit 1 ;;
esac
exit 0
STUB

cat >"$stubs/hdiutil" <<'STUB'
#!/usr/bin/env bash
echo "hdiutil $*" >>"$STUB_LOG"
for last; do :; done
printf 'stub disk image\n' >"$last"
STUB

cat >"$stubs/codesign" <<'STUB'
#!/usr/bin/env bash
echo "codesign $*" >>"$STUB_LOG"
[[ " $* " == *" --display "* ]] && echo "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1" >&2
exit 0
STUB

cat >"$stubs/security" <<'STUB'
#!/usr/bin/env bash
echo "security $*" >>"$STUB_LOG"
echo '  1) 0000 "Developer ID Application: Stub (STUBTEAM)"'
STUB

cat >"$stubs/spctl" <<'STUB'
#!/usr/bin/env bash
echo "spctl $*" >>"$STUB_LOG"
STUB

cat >"$stubs/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$STUB_LOG"
case "$1 $2" in
  "release create") [[ "$STUB_FAIL" == create ]] && exit 1 ;;
  "release upload") [[ "$STUB_FAIL" == upload ]] && exit 1 ;;
esac
exit 0
STUB

chmod +x "$stubs"/*

# A repository holding release.sh, a project placeholder, and an Info.plist
# with a public key, pushed to a local bare remote.
new_fixture() {
  local name="$1"
  fixture="$work/$name"
  git init -q --bare "$work/$name-remote.git"
  git init -q -b main "$fixture"
  git -C "$fixture" config user.email test@example.com
  git -C "$fixture" config user.name test
  mkdir -p "$fixture/apps/macos/scripts" "$fixture/apps/macos/AgentDesk.xcodeproj"
  cp "$release_script" "$fixture/apps/macos/scripts/release.sh"
  touch "$fixture/apps/macos/AgentDesk.xcodeproj/project.pbxproj"
  plutil -create xml1 "$fixture/apps/macos/AgentDesk-Info.plist"
  plutil -insert SUPublicEDKey -string "STUBPUBLICKEY=" "$fixture/apps/macos/AgentDesk-Info.plist"
  echo "build/" >"$fixture/.gitignore"
  git -C "$fixture" add -A
  git -C "$fixture" commit -q -m one
  git -C "$fixture" commit -q --allow-empty -m two
  git -C "$fixture" remote add origin "$work/$name-remote.git"
  git -C "$fixture" push -q origin main
}

# run <name> <expected exit> <expected output fragment> -- <release.sh args>
run() {
  local name="$1" want_exit="$2" want_text="$3"
  shift 4
  : >"$STUB_LOG"
  rm -rf "$fixture/build"
  local got_exit=0
  output="$(PATH="$stubs:$PATH" bash "$fixture/apps/macos/scripts/release.sh" "$@" 2>&1)" || got_exit=$?
  if [[ "$got_exit" != "$want_exit" ]]; then
    flunk "$name: exit $got_exit, want $want_exit"
    echo "$output" | sed 's/^/     /'
  elif [[ "$output" != *"$want_text"* ]]; then
    flunk "$name: output lacks '$want_text'"
    echo "$output" | sed 's/^/     /'
  else
    pass "$name"
  fi
}

log_has() {
  local name="$1" pattern="$2"
  if grep -qE -- "$pattern" "$STUB_LOG"; then pass "$name"; else flunk "$name: no call matching '$pattern'"; fi
}

log_lacks() {
  local name="$1" pattern="$2"
  if grep -qE -- "$pattern" "$STUB_LOG"; then flunk "$name: unexpected call matching '$pattern'"; else pass "$name"; fi
}

export STUB_LOG="$work/stub.log"
export STUB_FAIL=""
export AGENTDESK_TEAM_ID=STUBTEAM
export AGENTDESK_RELEASE_REPO=example/agentdesk

new_fixture main
commit="$(git -C "$fixture" rev-parse HEAD)"

echo "# arguments and versions"
run "no version" 64 "usage:" --
run "two versions" 64 "more than one version" -- 1.0.0 1.0.1 --dry-run
run "unknown option" 64 "unknown option --force" -- 1.0.0 --force
for bad in 1.2 1.2.3.4 v1.2.3 01.2.3 1.02.3 1.2.3-beta " 1.2.3" a.b.c; do
  run "malformed version '$bad'" 1 "is not <major>.<minor>.<patch>" -- "$bad" --dry-run
done

echo "# dry run"
run "valid dry run" 0 "dry run: checks passed; stopping before archiving" -- 1.2.3 --dry-run
[[ "$output" == *"build number: 2"* && "$output" == *"commit:       $commit"* && "$output" == *"tag:          macos-v1.2.3"* ]] \
  && pass "dry run reports version, build number, commit, and tag" \
  || flunk "dry run report: $output"
[[ ! -s "$STUB_LOG" ]] && pass "dry run calls no build, signing, Keychain, or GitHub tool" \
  || flunk "dry run called: $(cat "$STUB_LOG")"
run "dry run flag first" 0 "stopping before archiving" -- --dry-run 0.1.0
[[ -z "$(git -C "$fixture" status --porcelain --untracked-files=all)" ]] \
  && pass "dry run leaves the tree clean" || flunk "dry run dirtied the tree"

echo "# working tree"
echo change >>"$fixture/.gitignore"
run "modified tracked file" 1 "uncommitted or untracked files" -- 1.2.3 --dry-run
git -C "$fixture" checkout -q -- .gitignore
echo new >"$fixture/untracked.txt"
run "untracked file" 1 "uncommitted or untracked files" -- 1.2.3 --dry-run
rm "$fixture/untracked.txt"
echo staged >"$fixture/staged.txt"
git -C "$fixture" add staged.txt
run "staged file" 1 "uncommitted or untracked files" -- 1.2.3 --dry-run
git -C "$fixture" rm -q --cached staged.txt
rm "$fixture/staged.txt"

echo "# tags"
git -C "$fixture" tag macos-v1.2.3
run "existing local tag" 1 "tag macos-v1.2.3 already exists locally" -- 1.2.3 --dry-run
git -C "$fixture" push -q origin macos-v1.2.3
git -C "$fixture" tag -d macos-v1.2.3 >/dev/null
run "existing remote tag" 1 "tag macos-v1.2.3 already exists on origin" -- 1.2.3 --dry-run
run "other version still allowed" 0 "stopping before archiving" -- 1.2.4 --dry-run
git -C "$fixture" tag v1.2.5
run "installer tag does not block a Mac version" 0 "stopping before archiving" -- 1.2.5 --dry-run
git -C "$fixture" tag -d v1.2.5 >/dev/null
git -C "$fixture" remote set-url origin "$work/missing-remote.git"
run "unreachable remote" 1 "could not read tags from origin" -- 1.2.6 --dry-run
git -C "$fixture" remote set-url origin "$work/main-remote.git"

echo "# release with stubs"
run "full release" 0 "released AgentDesk for Mac 2.0.0" -- 2.0.0
order="$(grep -oE '^(xcodebuild -resolve|generate_keys|xcodebuild archive|xcodebuild -exportArchive|hdiutil create|xcrun notarytool submit|xcrun stapler staple|sign_update|gh release create|gh release upload)' "$STUB_LOG" | tr '\n' '|')"
want="xcodebuild -resolve|generate_keys|xcodebuild archive|xcodebuild -exportArchive|hdiutil create|xcrun notarytool submit|xcrun stapler staple|sign_update|gh release create|gh release upload|"
[[ "$order" == "$want" ]] && pass "steps run in order" || flunk "step order: $order"
log_has "archive sets version and build number" '^xcodebuild archive .*MARKETING_VERSION=2\.0\.0 CURRENT_PROJECT_VERSION=2 '
log_has "archive keeps hardened runtime" '^xcodebuild archive .*ENABLE_HARDENED_RUNTIME=YES'
log_has "notarization waits on the agentdesk-notary profile" '^xcrun notarytool submit .*AgentDesk-2\.0\.0\.dmg --wait --keychain-profile agentdesk-notary'
log_has "release is created not-latest at the commit" "^gh release create macos-v2\.0\.0 .*AgentDesk-2\.0\.0\.dmg --repo example/agentdesk --target $commit .*--latest=false"
log_has "appcast replaces the fixed release asset" '^gh release upload macos-appcast .*appcast\.xml --repo example/agentdesk --clobber'
log_lacks "no release is marked latest" '--latest( |=true|$)'
grep -qF 'ExportOptions.plist' "$STUB_LOG" && grep -q '<string>developer-id</string>' "$fixture/build/macos-release/2.0.0/ExportOptions.plist" \
  && pass "export uses the developer-id method" || flunk "export options lack developer-id"
appcast="$fixture/build/macos-release/2.0.0/appcast.xml"
dmg_size="$(stat -f %z "$fixture/build/macos-release/2.0.0/AgentDesk-2.0.0.dmg" 2>/dev/null || echo missing)"
for fragment in \
  '<sparkle:version>2</sparkle:version>' \
  '<sparkle:shortVersionString>2.0.0</sparkle:shortVersionString>' \
  '<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>' \
  'url="https://github.com/example/agentdesk/releases/download/macos-v2.0.0/AgentDesk-2.0.0.dmg"' \
  "length=\"$dmg_size\"" \
  'sparkle:edSignature="STUBSIGNATURE=="'; do
  grep -qF -- "$fragment" "$appcast" && pass "appcast has $fragment" || flunk "appcast lacks $fragment"
done
xmllint --noout "$appcast" 2>/dev/null && pass "appcast is well-formed" || flunk "appcast is not well-formed"
[[ -z "$(git -C "$fixture" status --porcelain --untracked-files=all)" ]] \
  && pass "release leaves the tree clean" || flunk "release dirtied the tree"

echo "# failures stop before publishing"
for failing in keymismatch archive export notary notary-invalid staple sign; do
  STUB_FAIL="$failing" run "$failing failure stops" 1 "release:" -- 2.0.0
  log_lacks "$failing failure publishes nothing" '^gh release (create|upload)'
done
STUB_FAIL=notary-invalid run "rejected notarization names its status" 1 "notarization status is 'Invalid', not Accepted" -- 2.0.0
log_lacks "rejected notarization is not stapled or signed" '^(xcrun stapler|sign_update)'
STUB_FAIL=keymismatch run "mismatched public key names the problem" 1 "does not match SUPublicEDKey" -- 2.0.0
log_lacks "mismatched public key stops before archiving" '^xcodebuild archive'
STUB_FAIL=create run "release creation failure skips the appcast" 1 "nothing was published to macos-appcast" -- 2.0.0
log_lacks "release creation failure leaves the appcast alone" '^gh release upload'
STUB_FAIL=upload run "appcast upload failure reports a partial release" 1 "partial release: macos-v2.0.0 is published" -- 2.0.0
AGENTDESK_TEAM_ID="" run "missing team ID" 1 "set AGENTDESK_TEAM_ID" -- 2.0.0
log_lacks "missing team ID stops before archiving" '^xcodebuild'

plutil -remove SUPublicEDKey "$fixture/apps/macos/AgentDesk-Info.plist"
git -C "$fixture" commit -q -am "no key"
run "missing public key" 1 "SUPublicEDKey is not set" -- 2.0.0
log_lacks "missing public key stops before archiving" '^xcodebuild'

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all release script checks passed"
