#!/bin/sh
# Installs the agentdesk command (component-installer §Build and distribution).
#
# The gateway serves this file as /install.sh and replaces the placeholder in
# AGENTDESK_ORIGIN with its PUBLIC_ORIGIN. The script detects the platform,
# downloads the matching release binary and SHA256SUMS, verifies the checksum,
# installs to ~/.local/bin, and runs `agentdesk install` with the script's own
# arguments, so `curl -fsSL <url> | sh -s -- --only codex` passes `--only codex`
# on (AC-9.8). It exits with the installer's status.
#
# AGENTDESK_DOWNLOAD_BASE overrides the download location (tests use file://).
set -eu

AGENTDESK_ORIGIN="__AGENTDESK_PUBLIC_ORIGIN__"
DOWNLOAD_BASE="${AGENTDESK_DOWNLOAD_BASE:-https://github.com/kidus-tiliksew/AgentDesk/releases/latest/download}"
INSTALL_DIR="${HOME}/.local/bin"

fail() {
  echo "agentdesk install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system $(uname -s); AgentDesk supports macOS and Linux." ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m); AgentDesk supports arm64 and x64." ;;
esac

asset="agentdesk-${os}-${arch}"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required to verify the download."
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading ${asset}..."
download "${DOWNLOAD_BASE}/${asset}" "${tmp}/${asset}" || fail "could not download ${DOWNLOAD_BASE}/${asset}"
download "${DOWNLOAD_BASE}/SHA256SUMS" "${tmp}/SHA256SUMS" || fail "could not download ${DOWNLOAD_BASE}/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "${tmp}/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no entry for ${asset}."
actual="$(sha256_of "${tmp}/${asset}")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for ${asset}; nothing was installed."

mkdir -p "$INSTALL_DIR"
chmod 755 "${tmp}/${asset}"
mv "${tmp}/${asset}" "${INSTALL_DIR}/agentdesk"
echo "Installed ${INSTALL_DIR}/agentdesk"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "${INSTALL_DIR} is not on your PATH. Add it, for example:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

echo ""
# An unsubstituted copy (run from the repository) names no server.
if [ "$AGENTDESK_ORIGIN" = "__AGENTDESK_PUBLIC""_ORIGIN__" ]; then
  set -- install "$@"
else
  set -- install --server "$AGENTDESK_ORIGIN" "$@"
fi

# Standard input is the terminal when one can be opened, otherwise /dev/null,
# so the installer never reads the rest of a script piped into sh.
status=0
if (: </dev/tty) 2>/dev/null; then
  "${INSTALL_DIR}/agentdesk" "$@" </dev/tty || status=$?
else
  "${INSTALL_DIR}/agentdesk" "$@" </dev/null || status=$?
fi
exit "$status"
