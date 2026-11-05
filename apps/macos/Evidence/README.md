# Mac app evidence

`run.sh` produces retained evidence for the menu bar label, the popover, notifications, the built bundle's update settings and app icon, and the release script, without an account or any macOS permission. It needs the network to resolve the pinned Sparkle package and to read the `origin` remote's tags. It writes to `output/`, or to the directory given as its first argument:

```sh
apps/macos/Evidence/run.sh
```

It runs seven steps and records each command, exit status, and log in `output/manifest.json`:

1. Builds `Harness/` together with every `AgentDeskKit` source and the shipped `DecisionRow`, `AnswerControls`, `AgentsView`, `ScrollSupport`, `Ink`, `MenuBarLabel`, `NotificationController`, and `NotificationPauseLine` files into one program (`build.log`).
2. Runs the harness (`harness.log`, `report.txt`, PNGs):
   - the popover from fixtures, in light and dark, with the agents list expanded and collapsed, and empty;
   - each row marker (`popover-markers`): the new row's dot and heavier title, the Urgent marker, red time left, and "Suggests <answer>" on approve, reject, and the other input types;
   - an 18-row list overflowing with its scroller (`popover-overflow`), with the Undo strip (`popover-overflow-undo`);
   - the agents line and list (`popover-agents-line`, `popover-agents-quiet-hidden`, `popover-agents-quiet-revealed`), and 18 sessions overflowing the agents list (`popover-agents-overflow`);
   - the list across openings, with one retained hosting controller moved between offscreen windows as `NSPopover` keeps its content view: a first opening, a reopening after scrolling without the top reset (the defect) and with it, an urgent row arriving above a kept offset, a read landing at the top, the Undo strip and the expanded agents list within 560 pt, a notification's row winning over the top reset, a repeated row target, a selection change, and each overflowing list's scroller, including after the Show scroll bars change notification (`popover-open-first`, `popover-reopen-no-reset`, `popover-reopen-reset`, `popover-urgent-above-offset-no-reset`);
   - the default menu bar style: count when unset, and a stored dot staying dot;
   - one row of each input type expanded, with its Markdown body, controls, suggestion, default sentence, and links;
   - the Undo strip, a conflict's recorded outcome, and a row restored with "Couldn't send. Try again.";
   - each row's text, weight, red time left, and accessibility label and value, and the agents line;
   - what each expanded row's untouched `AnswerDraft` submits, and the strip texts;
   - contrast of the popover inks, the title, and the system colors they replace, rendered as 40 pt swatches on the vibrant popover material and on a flat popover gray;
   - contrast of every shipped `Ink` value, Increase Contrast included, computed against the rendered backgrounds and pure white or black;
   - the label as glyph, dot, a fade frame, and counts, and the seven fade frames;
   - a dot timeline through `DotPresence`: the fade on appearance, no redraw on refresh, and Reduce Motion;
   - the header with the pause line, in light and dark;
   - notification content and the `decision.approve_reject` category from the shipped `NotificationController`, with the default sound and no user info;
   - a `Notifier` timeline on a fixture clock and notification center: authorization after sign-in, push against digest and mute, the 2-minute interactive hold, the 10-minute age limit, no post while open, pause, Off, a post in flight posted once, a refused post retried, removal when decisions leave the read, and a post landing after sign-out removed;
   - Reject and Approve through `PendingAnswers.sendNow`, posted once, leaving a held popover answer alone, and a 409 outcome kept for the next opening;
   - click focus through `NotificationFocus`: a listed decision, a click during a refresh, and a stale target.
   The harness exits non-zero when a popover exceeds 340 × 560 pt, an ink falls below 4.5:1, a label image is not a template, a row marker or agents group is wrong, the first row is not at the top after an ordinary opening, a row target does not win, or an overflowing list has no visible scroller.
3. Runs the full suite, `swift test --package-path apps/macos/AgentDeskKit`, as CI does (`tests.log`). `freshness.txt` holds the measured time from a server change to a published snapshot, open and closed.
4. Builds the app unsigned with the CI command, `xcodebuild build -project apps/macos/AgentDesk.xcodeproj -scheme AgentDesk -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO`, into a scratch derived-data directory so every run compiles from scratch (`xcodebuild.log`).
5. Audits the bundle that build produced (`bundle.txt`), without launching it: the value and type of each Sparkle key in `Info.plist`, that `SUPublicEDKey` decodes to a 32-byte Ed25519 public key, that `Contents/Frameworks/Sparkle.framework` is version 2.10.1, the `AppIcon` set's ten slots at their pixel sizes, its 1024 pixel file equal to `apps/mobile/assets/icon.png`, the build setting in Debug and Release, `CFBundleIconName` and `CFBundleIconFile`, the compiled `AppIcon.icns` and `Assets.car`, and the icon `NSWorkspace` returns for the bundle (`IconAudit/`, `bundle-icon-finder.png`), compared with the generic application icon and the source. Any other value fails the step.
6. Checks the release script with `bash -n` on `release.sh` and `test-release.sh`, then runs `test-release.sh` (`release-tests.log`).
7. Runs `release.sh` dry runs in a throwaway clone of the commit, whose `origin` is this checkout's `origin` remote, because the outputs above leave this checkout dirty (`release-dry-run.log`). Each run states the exit it expects: a malformed version, an untracked file, and a `macos-v` tag created only in the clone are refused, and a valid version on the clean clone stops before archiving. A different exit fails the step.

The run fails when Git would ignore any output, so every file the manifest names is committed with it. The manifest names the Git tree hashes of `AgentDesk/`, `AgentDeskKit/`, `AgentDesk-Info.plist`, `AgentDesk.xcodeproj`, `scripts/`, `Harness/`, `IconAudit/`, and `run.sh` at the commit the run used, and the SHA-256 of every output. Compare them with `git rev-parse <commit>:apps/macos/AgentDesk` and the like to confirm the outputs belong to a later commit's sources. `sources_dirty` is true when those paths had uncommitted changes.

## Limits

- Offscreen windows render the popover material without the desktop behind it, which is the closest available stand-in for the `NSPopover` window.
- `NSAppearance(named: .accessibilityHighContrastAqua)` resolves to plain Aqua offscreen, so Increase Contrast is computed from the shipped values, not rendered.
- The harness opens no window on screen, so the live `NSPopover` and its will-show and did-show events are not captured. The scroll section drives the shipped list in a retained hosting controller moved between offscreen windows and calls the requests `AppState` makes on those events. Offscreen windows are occluded, so an animated scroll never advances and the row target is applied without its animation. A fresh process's first layout stays at the top there, so the clipped opening is reproduced from a kept offset, not from a first show. `ListScrollRequestTests` covers the request policy, and the operator's pre-release check covers the live popover.
- `NSWorkspace` returns the built bundle's icon as Finder reads it. The icon in System Settings and in a delivered notification, which macOS resolves through the registered app for the bundle id, needs an installed build, so it is not captured.
- Live VoiceOver output and the live popover open and close need assistive access for the process. The harness reports `AXIsProcessTrusted` and prints the accessibility strings the row view applies.
- Keys reach the popover through a key monitor on the live popover window, which the harness does not open. `PopoverKeysTests` covers what each key does; Escape with no row expanded closes the popover.
- `UNUserNotificationCenter` needs the app bundle and the user's permission, so the permission prompt, a delivered banner, a click opening the popover, the notification buttons, and removal from Notification Center are not captured. The harness drives the shipped planning and content code through a fixture center instead.
- Offscreen windows are never key, so buttons draw in their inactive style and the accent comes from the system, not the app's asset catalog.
- The freshness measurement uses an in-process `URLProtocol` stub, so it bounds the app's own share of the delay. A request may take up to the 15-second timeout on a slow network.
