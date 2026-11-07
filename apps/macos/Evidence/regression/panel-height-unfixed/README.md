# Panel height check on source without the correction

This directory keeps the failing run of the panel height check, apart from `output/`, so a later `run.sh` cannot overwrite it.

- **Source:** commit `c50cce3ececfd551940030fcfd3bf00b247d91af`, `sources_dirty` false. It holds the check in `Harness/PanelEvidence.swift`. The production correction is absent: `AgentDesk/DetailPanelWindow.swift` is the file at base `8633bbd`.
- **Command:** `apps/macos/Evidence/run.sh <scratch directory>`, then `report.txt` and `manifest.json` copied here. `run.sh` exited 1.
- **Hashes:** `report.txt` is sha256 `03193461edfcb1ae3712ac88948e83cde9f288bd92b4d71a2e76cc6f621a6ac5`, which `manifest.json` also names. `manifest.json` is sha256 `cb3072ce24eaeb18c56a551a44a34ae44753f5d64b5c527c0b55162342b89d79`.

| Step | Exit | Result |
| --- | --- | --- |
| harness build | 0 | |
| harness, `report.txt` | 1 | 630 ok, 5 FAIL, all five in the panel height section |
| `--access` | 1 | 125 ok, 177 FAIL: the nested `AXApplication` read that `Evidence/README.md` lists under Limits. This check does not run in that step |
| `swift test` | 0 | |
| unsigned `xcodebuild build` | 0 | |
| bundle audit | 0 | |
| release script checks | 0 | |
| release dry runs | 0 | |

The five failures, from `report.txt`:

| Check | Reading |
| --- | --- |
| agent opens loading: the header stays at the window's top in every reading | window 71.0, header top 33.0, bottom -24.5 |
| agent loading: the header stays at the top of the oversized window | window 311.0, header top 128.5, bottom 120.0 |
| agent short: the same | window 538.0, header top 131.0, bottom 120.0 |
| decision loading: the same | window 311.0, header top 128.5, bottom 120.0 |
| decision short: the same | window 541.0, header top 131.0, bottom 120.0 |

The oversized readings show the operator's report: the content sits in the middle of a taller window, with about 120 pt of empty space above and below.

Every settled height check passed on this source. No transparent run left the window taller than its content once layout held still, so this run does not reproduce a window that stays too tall.

An earlier run at `04d1771`, before the check gained its stale-resize and reopening assertions, gave the same five harness failures and the same `--access` result. It is not retained.

## The check as delivered

After `report.txt` was captured, review findings changed the check. A run with no screen now fails, and the overflow limit comes from the space below the anchor's top. Each open state must now hold the close control and the scrolling body, a body must have scrolled before its replacement, the samples inside a click must have the header at the top, and the reduced height has a loaded short target. A review then asked for a height regression, so the check gained a later-clicks section. A second review asked that its injected condition cannot pass unexercised, so the section now asserts the constraint it holds down, and a third review added its constant.

**This regression is conditional.** Its height failures appear only while the height constraint AppKit installs for `preferredContentSize` is held down. Without that injected condition, the later-clicks runs pass on unfixed source, so these transparent windows do not reproduce the operator's report by themselves. Why the window stays at the former target's height in the installed app is not established.

All runs below use the `Evidence/Harness` tree `6e37a8a409659a777236769ec0d6c669b16d11a6`, built by `run.sh`'s build command, then run as `<tmp>/evidence <directory> --panel-height`. `--unfixed-panel` declares that the program holds `AgentDesk/DetailPanelWindow.swift` from base `8633bbd`.

| File | Panel source | Declared | Result | sha256 |
| --- | --- | --- | --- | --- |
| `panel-height-final-harness.txt` | base | unfixed | exit 1, 654 ok, 34 FAIL | `210a524ff69d27f7aae1231f54898b0cedd7953fc907463657354149dace02b3` |
| `base-source-declared-corrected.txt` | base | corrected | exit 1, 53 FAIL | `49d49d37d6a498511b0c308a64bbac0614ce59e2079e7c8f0510fead8cf46b17` |
| `corrected-source-declared-unfixed.txt` | corrected | unfixed | exit 1, 650 ok, 26 FAIL | `976ef3aa949009f338bf95525964cdef1f15aaf925c682a20b91f8ef9613b325` |
| not kept here; the same sections of `output/report.txt` are its retained run | corrected | corrected | exit 0, 698 ok, 0 FAIL | |

`panel-height-final-harness.txt` is the regression:

- 5 FAIL are header position, the same five as above.
- 29 FAIL are in the later-clicks section, all in the runs that hold the constraint down. At the third agent click the window is 560 pt around a 266 pt body, with the header 142 pt down and 131 pt empty below. At the third decision click it is 555 pt around a 141 pt body, with the header 202 pt down and 191 pt empty below.
- The constraint's identity and attributes pass at every click, and its constant stays within 1 pt of the hosting view's preferred height, read separately at each click. The injection is applied after the first click, and the same object stays held at every later click. The constant follows the preferred height while the window does not follow it.

The other two files show that the injected case cannot pass unexercised:

- `corrected-source-declared-unfixed.txt` is a real missing constraint: "0 constraints named ...", with 24 identity failures and "the injection was exercised" failing for both kinds.
- `base-source-declared-corrected.txt` fails the absence checks, 24 for the constraint and 24 for the preferred height.
