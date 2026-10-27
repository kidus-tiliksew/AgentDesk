# Mac app evidence

`run.sh` produces retained evidence for the menu bar label and the read-only popover without an account, a network, or any macOS permission. It writes to `output/`, or to the directory given as its first argument:

```sh
apps/macos/Evidence/run.sh
```

It runs three steps and records each command, exit status, and log in `output/manifest.json`:

1. Builds `Harness/` together with every `AgentDeskKit` source and the shipped `DecisionRow`, `AgentsView`, `Ink`, and `MenuBarLabel` files into one program (`build.log`).
2. Runs the harness (`harness.log`, `report.txt`, PNGs):
   - the popover from fixtures, in light and dark, with the agents list expanded and collapsed, and empty;
   - each row's text, weight, red time left, and accessibility label and value, and the agents line;
   - contrast of the popover inks, the title, and the system colors they replace, rendered as 40 pt swatches on the vibrant popover material and on a flat popover gray;
   - contrast of every shipped `Ink` value, Increase Contrast included, computed against the rendered backgrounds and pure white or black;
   - the label as glyph, dot, a fade frame, and counts, and the seven fade frames;
   - a dot timeline through `DotPresence`: the fade on appearance, no redraw on refresh, and Reduce Motion.
   The harness exits non-zero when a popover exceeds 340 × 560 pt, an ink falls below 4.5:1, or a label image is not a template.
3. Runs `SyncFreshnessTests`, `DotPresenceTests`, and `SyncTests` (`tests.log`). `freshness.txt` holds the measured time from a server change to a published snapshot, open and closed.

The manifest names the Git tree hashes of `AgentDesk/`, `AgentDeskKit/`, `Harness/`, and `run.sh` at the commit the run used, and the SHA-256 of every output. Compare them with `git rev-parse <commit>:apps/macos/AgentDesk` and the like to confirm the outputs belong to a later commit's sources. `sources_dirty` is true when those paths had uncommitted changes.

## Limits

- Offscreen windows render the popover material without the desktop behind it, which is the closest available stand-in for the `MenuBarExtra` window.
- `NSAppearance(named: .accessibilityHighContrastAqua)` resolves to plain Aqua offscreen, so Increase Contrast is computed from the shipped values, not rendered.
- Live VoiceOver output and the live popover open and close need assistive access for the process. The harness reports `AXIsProcessTrusted` and prints the accessibility strings the row view applies.
- The freshness measurement uses an in-process `URLProtocol` stub, so it bounds the app's own share of the delay. A request may take up to the 15-second timeout on a slow network.
