# Run records

These are the raw records behind the claims in pull request 205 about the Mac panel height work (Conveyor task 261106-fe7d61). A reader on another machine can check each claim here. They are not evidence output: `run.sh` neither reads nor writes this directory, and it sits outside `Evidence/output/` and the source trees the manifest names, so committing it leaves the retained provenance valid.

`SHA256SUMS` holds the hash of every file here except itself. Check it from this directory with `shasum -a 256 -c SHA256SUMS`.

Timestamps are UTC. Dates are 2026-11-06 and 2026-11-07, and each directory or table below says which.

## What was removed

Each file is a copy of the original with these values replaced, and nothing else changed:

- the home directory, scratch, worktree, and temporary paths, by `~`, `<scratch>`, `<worktree>`, and `<tmp>`;
- application bundle identifiers, by `<app>`, because diagnostic captures named the operator's frontmost app.

`final-runs/*/lock-samples.txt` needed no change and is byte-identical to the original. Screenshots, the operator's messages, and session identifiers are not here.

## The final runs

| Directory | Source commit | Manifest `generated_at` | Started at idle | Result |
| --- | --- | --- | --- | --- |
| `final-runs/43e7e0d/` | `43e7e0d` | 2026-11-07T09:17:53Z | 200.8 s | **Compliant, the retained run.** All eight steps exit 0, idle never fell |
| `final-runs/80c76d9/` | `80c76d9` | 2026-11-07T08:57:57Z | 62.9 s | All eight steps exit 0, **not idle throughout**, replaced |
| `final-runs/3f14a11/` | `3f14a11` | 2026-11-07T08:24:25Z | 242.9 s | All eight steps exit 0, input once, replaced |
| `final-runs/1432122/` | `1432122` | 2026-11-07T07:51:22Z | 288.3 s | All eight steps exit 0, idle never fell, replaced when the check changed |

Each directory holds:

- `lock-samples.txt`: one line per sample, `HH:MM:SS lock asleep idle-seconds`. `absent` means the session did not read locked, and `0` means the display was awake.
- `wait.txt`: when the start condition was met, with the state then and the head commit.
- `stdout.txt`: `run.sh`'s summary line and exit, with its end time.
- `verdict.txt`, on `43e7e0d` only: how the monitor ended.
- `manifest.json`: a copy of that run's manifest. Its output hashes apply to the output committed with it.

**The boundaries of the compliant run.** `monitoring/idle-attempt.sh.txt`, run as `WAIT=2700 idle-attempt.sh impl5-a1`, writes `wait.txt`, launches `caffeinate -d -i apps/macos/Evidence/run.sh`, and only then takes its first sample, so the samples start after the launch. It samples every 3 s while that process lives and once more after it exits, so the last sample follows the end of the run. `generated_at` 09:17:53 falls inside the samples, which run from 09:13:49 to 09:17:56. Each sample reads `monitoring/session-state.swift.txt`, which reports `CGSSessionScreenIsLocked`, `CGDisplayIsAsleep`, and `CGEventSource.secondsSinceLastEventType` for all input.

`final-runs/check-idle.py.txt` reads the samples:

```text
=== 43e7e0d
samples 82, from 09:13:49 to 09:17:56, largest gap 4 s
idle from 200.9 s to 447.9 s, lowest 200.9 s
lock and display states: [('absent', '0')]
samples where idle fell: 0 []
largest difference between idle growth and the clock: 0.93 s
=== 80c76d9
samples 49, from 08:53:56 to 08:57:58, largest gap 6 s
idle from 63.0 s to 0.2 s, lowest 0.0 s
lock and display states: [('absent', '0')]
samples where idle fell: 10 ['08:56:22', '08:56:27', '08:56:37', '08:56:42', '08:56:47', '08:56:57', '08:57:17', '08:57:38', '08:57:43', '08:57:58']
largest difference between idle growth and the clock: 304.74 s
=== 3f14a11
samples 48, from 08:20:28 to 08:24:25, largest gap 6 s
idle from 243.0 s to 8.6 s, lowest 0.3 s
lock and display states: [('absent', '0')]
samples where idle fell: 1 ['08:24:10']
largest difference between idle growth and the clock: 471.43 s
=== 1432122
samples 45, from 07:47:41 to 07:51:23, largest gap 6 s
idle from 288.3 s to 510.4 s, lowest 288.3 s
lock and display states: [('absent', '0')]
samples where idle fell: 0 []
largest difference between idle growth and the clock: 0.59 s
```

Idle time grows with the clock until input resets it, so a reset would show as a fall. A reset between samples would show too, because the samples are seconds apart. The harness's own events are posted inside its process and do not reset this value: `1432122` and `43e7e0d` show no fall across a whole run.

`final-runs/80c76d9/` was monitored by `monitoring/final-attempt.sh.txt`, which waited for 60 s idle and did not stop on input. The earlier two runs used the same script.

## Claims and their records

| Claim in the pull request | Record | Status |
| --- | --- | --- |
| The final run was idle throughout | `final-runs/43e7e0d/` | Retained |
| The run at `80c76d9` had input from about 08:56:18 | `final-runs/80c76d9/lock-samples.txt` | Retained. **The panel sections' end, 08:56:00, is unretained**: it came from file times of `popover-linked-held-*.png`, which a later run replaced |
| 18:37 run at `5622989`: 6 placement FAIL | `earlier-runs/5622989-1837/report.txt`, `manifest.json` | Retained |
| Input resumed at about 18:38:39 | `earlier-runs/5622989-1837/lock-samples.txt` | Retained. **The section start, about 18:38:45, is my estimate**: reports hold no times |
| `--access` 327 ok on the unlocked session | `earlier-runs/5622989-1837/access.txt` | Retained |
| `--access` 125 ok, 177 FAIL on a locked session | `earlier-runs/04d1771/access.txt`, `earlier-runs/7aeb6e6/access.txt`, `earlier-runs/8633bbd-access/` | Retained. **The lock readings at 12:46 and 15:16 are unretained**: they were read in the session and not written to a file. The later reading at 17:28 is in `earlier-runs/5622989-1728-stopped/lock-samples.txt` |
| Unfixed run at `04d1771`; corrected runs at `615a21e`, `7aeb6e6` | `earlier-runs/` | Retained. The run at `c50cce3` is in `../panel-height-unfixed/` |
| 17:28 run stopped, no result | `earlier-runs/5622989-1728-stopped/` | Retained |
| 19:06 run at `b845b65`: harness 635 ok | `earlier-runs/b845b65-1906-stopped/` holds its samples and summary only | **Partly unretained.** Its output was restored as instructed, so no file holds the 635 ok. It counts as one of the 19 |
| 18:42 to 18:47: two corrected and two base runs | `comparison/2026-11-06-1842-to-1848-result-lines.txt` | **Result lines only.** Their reports were overwritten, so the 18:45 failure has its one FAIL line and no report |
| 18:55 to 19:06: five corrected and two base runs | `comparison/2026-11-06-1855-to-1906/`, `comparison/2026-11-06-1855-to-1906-result-lines.txt` | Retained |
| 10 alternating pairs on 2026-11-07, and the two base active-app failures | `comparison/2026-11-07-pairs.txt`, `comparison/2026-11-07/` | Retained. Runs 1 and 2 used the first capture, and the rest the extended one. PNGs are not kept |
| Input near the openings in about 3 of 9 runs per harness | `comparison/input-near-openings.txt` | Retained |
| The paired section alone, looped 10 times, passed in both | `comparison/paired-section-loop-*.txt` | Retained |
| Forced reproductions, and a forced base active-app failure | `forced/` | Retained |
| How the diagnostic copies were made | `comparison/copies/`, `traces/` patches | Retained. The copies themselves are not kept and are not in the branch |
| First divergence: one `setFrame` per later click at the former height, and the observer firing 0 times | `traces/base-controller-trace-no-fault.txt` | Retained |
| The window stays at the former height with the constraint held down | `traces/base-probe-held.txt`, `traces/corrected-probe-held.txt`, `../panel-height-unfixed/` | Retained |
| 2% alpha and `.accessory` still read not visible | `traces/base-probe-2-percent-alpha.txt`, `traces/base-probe-accessory-policy.txt` | Retained |
| Safe-area and scroll insets read 0 | `traces/base-probe-held.txt`, `traces/corrected-probe-held.txt` | Retained |
| First-opening timing, and the 1 pt window for about 7 ms | `traces/first-opening-*.txt` | Retained |
| 2 of 19 and 0 of 14 | the rows above; see below | Retained except where those rows say otherwise |

### The 33 runs

| Runs | With the correction | Base | Record |
| --- | --- | --- | --- |
| 11-06 18:38 | 1, placement failure | | report |
| 11-06 18:42 to 18:47 | 2: one pass, one placement failure | 2 passes | result lines only |
| 11-06 18:55 to 19:06 | 5 passes | 2 passes | full run output |
| 11-06 19:07 | 1 pass | | samples only; the count is unretained |
| 11-07 07:00 to 07:39 | 10 passes | 10: 8 passes, 2 active-app failures | report, capture, samples |
| **Total** | **19, 2 placement failures** | **14, 0 placement, 2 active-app** | |

## Unretained, and why

- **The operator's words and their visual check on builds 370 and 381.** They reached this work through the coordinator's messages. The pull request quotes them, and no file here holds them.
- **The operator's screenshot, about 530 pt tall with about 296 pt of content.** It shows their desktop, so it is deliberately not committed, and the figures are my reading of it.
- **The lock readings at 12:46 and 15:16 on 2026-11-06.**
- **The file times showing the panel sections ended by 08:56:00 in the run at `80c76d9`.**
- **The 635 ok of the 19:06 run, and the reports of the four runs from 18:42 to 18:47.**
- **The earliest scratch probes, before the retained check existed.** Nothing in the pull request rests on them alone: the values it quotes from them, such as the first misplaced layout, are in `../panel-height-unfixed/`.
