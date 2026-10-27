# AgentDesk for Mac

The native menu bar app. `component-mac-app` governs this directory. It sits outside the pnpm workspace: pnpm neither installs nor builds it, and Xcode's toolchain builds and tests it (DEC-20(3)).

This slice signs in and out. The pending-decision list, answering, notifications, and releases come in later tasks.

## Layout

- `AgentDesk.xcodeproj`: the `AgentDesk` app target and its shared scheme. Bundle id `sh.kidus.agentdesk.mac`, macOS 14.0 or later, `LSUIElement` on. Sources sit in a file-system synchronized group, so adding a file to `AgentDesk/` changes no project entry.
- `AgentDesk/`: the app target's SwiftUI views, menu bar label, and Open at Login adapter.
- `AgentDeskKit/`: a local Swift package with everything that runs without a window: models, API client, credential store, and sign-in. It imports Foundation, Security, and OSLog only.

## Build and test

The project is saved in a format Xcode 16.4 opens, which is the version CI uses.

```sh
swift test --package-path apps/macos/AgentDeskKit
xcodebuild build -project apps/macos/AgentDesk.xcodeproj -scheme AgentDesk \
  -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```

The tests never touch the login Keychain or the network. They use an in-memory credential store and a `URLProtocol` stub.

## Server

The app talks to `https://agentdesk-gateway.kidus-tiliksew.workers.dev` unless the user default `ServerURL` names another https origin. To point it at your own gateway, quit the app, then run:

```sh
defaults write sh.kidus.agentdesk.mac ServerURL https://your-gateway.example.com
```

Only the origin of an absolute https URL counts; any other value is ignored. The API token sits in the login Keychain under service `sh.kidus.agentdesk.mac` with the origin as its account, so each server has its own sign-in. Remove the override with `defaults delete sh.kidus.agentdesk.mac ServerURL`.
