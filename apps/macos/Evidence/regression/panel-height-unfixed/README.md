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

After `report.txt` was captured, two review findings changed the check: a run with no screen now fails, and the overflow limit comes from the space below the anchor's top. `panel-height-final-harness.txt` is that check on unfixed source: the `Evidence/Harness` tree `1e0a4de481b9c3f67d7737ceae327881c0058fe6`, built by `run.sh`'s build command with `AgentDesk/DetailPanelWindow.swift` from base `8633bbd`, then run as `<tmp>/evidence <directory> --panel-height`. It exited 1 with 382 ok and the same 5 FAIL, sha256 `f763e4411c1fb065969dbf3fa9cdd45f1326426fafa39a837065e267e5466645`. The same tree with the correction exited 0 with 387 ok and 0 FAIL, and the same section of `output/report.txt` is its retained run.
