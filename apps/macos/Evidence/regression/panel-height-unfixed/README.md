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
