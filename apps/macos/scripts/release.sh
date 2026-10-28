#!/usr/bin/env bash
# Builds, notarizes, signs, and publishes one AgentDesk for Mac release from
# the operator's Mac (component-mac-app §Release; component-repository §Mac
# releases). No CI job runs this script.
#
# Usage: apps/macos/scripts/release.sh <version> [--dry-run]
#
# --dry-run runs the version, working tree, and tag checks, prints what a
# release would build, and stops before archiving. It needs no signing
# identity, notary profile, Keychain access, or GitHub sign-in.
#
# Environment:
#   AGENTDESK_TEAM_ID           Apple Developer team ID (required to release)
#   AGENTDESK_SIGNING_IDENTITY  codesign identity, default "Developer ID Application"
#   AGENTDESK_RELEASE_REMOTE    Git remote checked for tags, default "origin"
#   AGENTDESK_RELEASE_REPO      GitHub repository, default "kidus-tiliksew/AgentDesk"

set -euo pipefail

usage() {
  echo "usage: apps/macos/scripts/release.sh <version> [--dry-run]" >&2
  exit 64
}

fail() {
  echo "release: $*" >&2
  exit 1
}

step() {
  echo "==> $*"
}

# Prints a plist or JSON value, or nothing when the key is missing. Some
# plutil versions print their error to stdout, so a failed extraction's
# output is never used.
plist_value() {
  local value
  value="$(plutil -extract "$1" raw -o - "$2" 2>/dev/null)" || return 0
  printf '%s' "$value"
}

version=""
dry_run=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -*) echo "release: unknown option $arg" >&2; usage ;;
    *)
      [[ -z "$version" ]] || { echo "release: more than one version given" >&2; usage; }
      version="$arg"
      ;;
  esac
done
[[ -n "$version" ]] || usage

# 1. Version, working tree, and tag checks.
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "version '$version' is not <major>.<minor>.<patch>"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
macos_dir="$repo_root/apps/macos"
project="$macos_dir/AgentDesk.xcodeproj"
source_plist="$macos_dir/AgentDesk-Info.plist"

remote="${AGENTDESK_RELEASE_REMOTE:-origin}"
github_repo="${AGENTDESK_RELEASE_REPO:-kidus-tiliksew/AgentDesk}"
identity="${AGENTDESK_SIGNING_IDENTITY:-Developer ID Application}"
tag="macos-v$version"
appcast_tag="macos-appcast"

dirty="$(git -C "$repo_root" status --porcelain --untracked-files=all)"
[[ -z "$dirty" ]] || fail "the working tree has uncommitted or untracked files:
$dirty"

if git -C "$repo_root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  fail "tag $tag already exists locally"
fi
# ls-remote exits 2 when the tag is absent; any other failure means the
# remote could not answer, which is not proof that the tag is absent.
remote_status=0
git -C "$repo_root" ls-remote --exit-code --tags "$remote" "refs/tags/$tag" >/dev/null || remote_status=$?
case "$remote_status" in
  0) fail "tag $tag already exists on $remote" ;;
  2) ;;
  *) fail "could not read tags from $remote (git ls-remote exited $remote_status)" ;;
esac

commit="$(git -C "$repo_root" rev-parse HEAD)"
build_number="$(git -C "$repo_root" rev-list --count HEAD)"
out="$repo_root/build/macos-release/$version"
dmg="$out/AgentDesk-$version.dmg"
appcast="$out/appcast.xml"
dmg_url="https://github.com/$github_repo/releases/download/$tag/AgentDesk-$version.dmg"

[[ ! -e "$out" ]] || fail "output directory $out already exists; remove it to build $version again"

echo "version:      $version"
echo "build number: $build_number"
echo "commit:       $commit"
echo "tag:          $tag"
echo "repository:   $github_repo"
echo "disk image:   $dmg"
echo "appcast:      $appcast"

if [[ "$dry_run" == true ]]; then
  echo "dry run: checks passed; stopping before archiving"
  exit 0
fi

# Release inputs. Each is an operator prerequisite in component-repository
# §Mac releases.
team="${AGENTDESK_TEAM_ID:-}"
[[ -n "$team" ]] || fail "set AGENTDESK_TEAM_ID to the Apple Developer team ID"
for tool in xcodebuild xcrun hdiutil codesign security spctl gh plutil xmllint; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done
gh auth status >/dev/null 2>&1 || fail "gh is not signed in; run gh auth login"
gh api "repos/$github_repo/commits/$commit" >/dev/null 2>&1 \
  || fail "commit $commit is not on GitHub; push it before releasing"
gh release view "$appcast_tag" --repo "$github_repo" >/dev/null 2>&1 \
  || fail "the fixed release $appcast_tag does not exist; create it once before the first release"
identities="$(security find-identity -v -p codesigning)"
[[ "$identities" == *"$identity"* ]] || fail "no valid '$identity' signing identity in the Keychain"

public_key="$(plist_value SUPublicEDKey "$source_plist")"
[[ -n "$public_key" ]] || fail "SUPublicEDKey is not set in apps/macos/AgentDesk-Info.plist"

mkdir -p "$out"
packages="$out/SourcePackages"

step "Resolving the pinned Sparkle package"
xcodebuild -resolvePackageDependencies -project "$project" -scheme AgentDesk \
  -clonedSourcePackagesDirPath "$packages" >"$out/resolve.log" 2>&1 \
  || fail "package resolution failed; see $out/resolve.log"
sparkle_bin="$packages/artifacts/sparkle/Sparkle/bin"
[[ -x "$sparkle_bin/sign_update" && -x "$sparkle_bin/generate_keys" ]] \
  || fail "Sparkle's sign_update and generate_keys are missing from $sparkle_bin"

keychain_key="$("$sparkle_bin/generate_keys" -p)" \
  || fail "could not read the Sparkle EdDSA key from the Keychain"
[[ "$keychain_key" == "$public_key" ]] \
  || fail "the Keychain's Sparkle public key does not match SUPublicEDKey in apps/macos/AgentDesk-Info.plist"

# 2. Archive and export with Developer ID, hardened runtime on.
step "Archiving AgentDesk $version ($build_number)"
archive="$out/AgentDesk.xcarchive"
xcodebuild archive -project "$project" -scheme AgentDesk -configuration Release \
  -destination 'generic/platform=macOS' -archivePath "$archive" \
  -clonedSourcePackagesDirPath "$packages" -derivedDataPath "$out/DerivedData" \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build_number" \
  DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$identity" \
  ENABLE_HARDENED_RUNTIME=YES OTHER_CODE_SIGN_FLAGS=--timestamp \
  >"$out/archive.log" 2>&1 \
  || fail "archive failed; see $out/archive.log"

step "Exporting with the developer-id method"
cat >"$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>developer-id</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>$identity</string>
	<key>teamID</key>
	<string>$team</string>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/export" \
  -exportOptionsPlist "$out/ExportOptions.plist" >"$out/export.log" 2>&1 \
  || fail "export failed; see $out/export.log"

app="$out/export/AgentDesk.app"
[[ -d "$app" ]] || fail "export produced no AgentDesk.app"
info="$app/Contents/Info.plist"
[[ "$(plist_value CFBundleShortVersionString "$info")" == "$version" ]] \
  || fail "the exported app's CFBundleShortVersionString is not $version"
[[ "$(plist_value CFBundleVersion "$info")" == "$build_number" ]] \
  || fail "the exported app's CFBundleVersion is not $build_number"
[[ "$(plist_value SUPublicEDKey "$info")" == "$public_key" ]] \
  || fail "the exported app's SUPublicEDKey does not match apps/macos/AgentDesk-Info.plist"
codesign --verify --deep --strict "$app" || fail "the exported app's signature does not verify"
signature_details="$(codesign --display --verbose=4 "$app" 2>&1)"
runtime_flag='flags=[^[:space:]]*runtime'
[[ "$signature_details" =~ $runtime_flag ]] \
  || fail "the exported app is not signed with the hardened runtime"
minimum_system="$(plist_value LSMinimumSystemVersion "$info")"
[[ -n "$minimum_system" ]] || fail "the exported app has no LSMinimumSystemVersion"

# 3. Disk image, notarized and stapled.
step "Building AgentDesk-$version.dmg"
stage="$out/dmg"
mkdir -p "$stage"
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
hdiutil create -volname AgentDesk -srcfolder "$stage" -format UDZO "$dmg" >"$out/hdiutil.log" 2>&1 \
  || fail "hdiutil failed; see $out/hdiutil.log"
codesign --sign "$identity" --timestamp "$dmg" || fail "signing the disk image failed"

step "Notarizing (this waits for Apple)"
xcrun notarytool submit "$dmg" --wait --keychain-profile agentdesk-notary \
  --output-format json >"$out/notary.json" 2>"$out/notary.log" \
  || fail "notarytool submit failed; see $out/notary.log and $out/notary.json"
notary_status="$(plist_value status "$out/notary.json")"
if [[ "$notary_status" != "Accepted" ]]; then
  submission="$(plist_value id "$out/notary.json")"
  fail "notarization status is '${notary_status:-unknown}', not Accepted; read the log with: xcrun notarytool log $submission --keychain-profile agentdesk-notary"
fi
xcrun stapler staple "$dmg" || fail "stapling failed"
xcrun stapler validate "$dmg" || fail "the stapled ticket does not validate"
spctl --assess --type open --context context:primary-signature --verbose "$dmg" \
  || fail "Gatekeeper rejects the disk image"

# 4. Sign the stapled disk image and write this version's appcast item.
step "Signing the update"
signature="$("$sparkle_bin/sign_update" -p "$dmg")" || fail "sign_update failed"
[[ -n "$signature" ]] || fail "sign_update printed no signature"
length="$(stat -f %z "$dmg")"
pub_date="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
cat >"$appcast" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>AgentDesk</title>
    <link>https://github.com/$github_repo/releases/download/$appcast_tag/appcast.xml</link>
    <item>
      <title>Version $version</title>
      <pubDate>$pub_date</pubDate>
      <sparkle:version>$build_number</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$minimum_system</sparkle:minimumSystemVersion>
      <enclosure url="$dmg_url" length="$length" type="application/octet-stream" sparkle:edSignature="$signature"/>
    </item>
  </channel>
</rss>
XML
xmllint --noout "$appcast" || fail "appcast.xml is not well-formed"

# 5. Publish. Neither release is ever marked latest, so install.sh keeps
# reading the installer's v* release from releases/latest.
step "Creating GitHub Release $tag"
gh release create "$tag" "$dmg" --repo "$github_repo" --target "$commit" \
  --title "AgentDesk for Mac $version" \
  --notes "AgentDesk for Mac $version. Requires macOS 14 or later." \
  --latest=false \
  || fail "gh release create failed; nothing was published to $appcast_tag. Check whether $tag exists before running again"

step "Replacing appcast.xml on $appcast_tag"
if ! gh release upload "$appcast_tag" "$appcast" --repo "$github_repo" --clobber; then
  fail "partial release: $tag is published but $appcast_tag still serves the previous appcast. Retry with: gh release upload $appcast_tag '$appcast' --repo $github_repo --clobber"
fi

echo "released AgentDesk for Mac $version: https://github.com/$github_repo/releases/tag/$tag"
