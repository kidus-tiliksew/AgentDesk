# AgentDesk for Mac

The native menu bar app. `component-mac-app` governs this directory. It sits outside the pnpm workspace: pnpm neither installs nor builds it, and Xcode's toolchain builds and tests it (DEC-20(3)).

The app signs in and out, polls the pending decisions and live agents, shows the attention dot or the pending count in the menu bar, and lists the pending decisions with the agents line below them. Each row answers in place. Approve-or-reject rows carry Reject and Approve. Clicking a row's text expands it to the body, the controls for its input type, a note, and Send. An answer waits 4 seconds behind an Undo strip before it is sent, and quitting waits for it. ↑ and ↓ select a row, ↩ expands it, ⌘↩ sends it, and Escape collapses it or closes the popover. Notifications and releases come in later tasks.

## Layout

- `AgentDesk.xcodeproj`: the `AgentDesk` app target and its shared scheme. Bundle id `sh.kidus.agentdesk.mac`, macOS 14.0 or later, `LSUIElement` on. Sources sit in a file-system synchronized group, so adding a file to `AgentDesk/` changes no project entry.
- `AgentDesk/`: the app target's SwiftUI views, menu bar label, Open at Login adapter, the wake and network-path triggers for sync, and the app delegate that holds quitting until answers are sent.
- `AgentDeskKit/`: a local Swift package with everything that runs without a window: models, API client, credential store, sign-in, sync, ordering, the seen store, attention, row text, answer drafts, pending answers, and the popover's key mapping. It imports Foundation, Security, and OSLog only.

## Build and test

The project is saved in a format Xcode 16.4 opens, which is the version CI uses.

```sh
swift test --package-path apps/macos/AgentDeskKit
xcodebuild build -project apps/macos/AgentDesk.xcodeproj -scheme AgentDesk \
  -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```

The tests never touch the login Keychain or the network. They use an in-memory credential store and a `URLProtocol` stub.

`Evidence/run.sh` renders the menu bar label and the popover from fixtures, including expanded rows and the answer strips, and records contrast, layout, and freshness evidence with a manifest; see `Evidence/README.md`.

## Server

The app talks to `https://agentdesk-gateway.kidus-tiliksew.workers.dev` unless the user default `ServerURL` names another https origin. To point it at your own gateway, quit the app, then run:

```sh
defaults write sh.kidus.agentdesk.mac ServerURL https://your-gateway.example.com
```

Only the origin of an absolute https URL counts; any other value is ignored. The API token sits in the login Keychain under service `sh.kidus.agentdesk.mac` with the origin as its account, so each server has its own sign-in. Remove the override with `defaults delete sh.kidus.agentdesk.mac ServerURL`.
