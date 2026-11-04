#!/bin/zsh
set -u
WT=/Users/kidusteshome/.conveyor/worktrees/agentdesk-task-261104-9da5be
E=/tmp/conveyor-9da5be/evidence
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"
cd "$WT/apps/website"
pnpm exec astro build >/tmp/conveyor-9da5be/rebuild.log 2>&1 || { echo build failed; exit 1; }
pnpm exec astro preview --host 127.0.0.1 --port 4377 >/tmp/conveyor-9da5be/preview.log 2>&1 &
PREVIEW=$!
PROFILE=$(mktemp -d /tmp/conveyor-9da5be/chrome.XXXXXX)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check --remote-debugging-port=9377 --user-data-dir="$PROFILE" about:blank >/tmp/conveyor-9da5be/chrome.log 2>&1 &
CHROME=$!
trap 'kill $PREVIEW $CHROME 2>/dev/null; pkill -f "astro preview --host 127.0.0.1 --port 4377" 2>/dev/null; rm -rf "$PROFILE"' EXIT
for i in {1..40}; do curl -sf http://127.0.0.1:4377/privacy >/dev/null && curl -sf http://127.0.0.1:9377/json/version >/dev/null && break; sleep 0.5; done
curl -s http://127.0.0.1:9377/json/version | python3 -c 'import json,sys;print(json.load(sys.stdin)["Browser"])'
node /tmp/conveyor-9da5be/check.mjs "$E" http://127.0.0.1:4377 http://127.0.0.1:9377 2>&1 | tee "$E/browser-check.log"
echo check-exit=$pipestatus[1]
