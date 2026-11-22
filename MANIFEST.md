# Local validation evidence for task 261122-b46c01

This branch holds only evidence. It shares no history with `main`. It records the local `pnpm run check` that review round 1 asked for, run so that the `chmod 000` permission tests can work.

## Subject

- Repository: kidus-tiliksew/AgentDesk
- Task branch: `conveyor/task-261122-b46c01`
- Head checked: `95d56be1481433d18ab9424436d617c0391d8f6f`
- Pull request: https://github.com/kidus-tiliksew/AgentDesk/pull/206

## Environment

- Host: Linux sandbox (Ubuntu 24.04.4 LTS, kernel Linux 6.8.0-117-generic x86_64)
- Node v22.23.2 (from `.nvmrc`, which pins 22), pnpm 10.34.6, dependencies from `pnpm install --frozen-lockfile`
- User: uid 1000, not root, so the permission tests are not skipped
- This sandbox gives every process the ambient capability `CAP_DAC_READ_SEARCH` (`CapEff: 0000000000000004`). That capability reads a `chmod 000` file anyway, so it defeats the permission tests. The runs below drop it with `setpriv --ambient-caps=-all --inh-caps=-all`, and each log's first lines show `CapEff: 0000000000000000`.

## Runs

| File | Command | Started (UTC) | Result |
| --- | --- | --- | --- |
| `pnpm-check.log` | `setpriv --ambient-caps=-all --inh-caps=-all -- pnpm run check` | 2026-11-22T12:05:02Z to 2026-11-22T12:06:21Z | exit status 0. Typecheck passed, and Biome found 17 warnings (the same 17 as on base) and no errors. Vitest: 95 files, 2960 tests passed, 0 failed, 0 skipped. Mobile Jest: 29 suites, 917 tests passed |
| `installer-verbose.log` | `setpriv --ambient-caps=-all --inh-caps=-all -- npx vitest run --project installer --reporter=verbose` | after the check | exit status 0: 22 files, 588 tests passed. Each test is named, including both permission tests: `hooks.test.ts` "refuses an unreadable hook file before sign-in" and `uninstall-safety.test.ts` "keeps the record when ~/.claude.json cannot be read" |
| `control-with-capability.log` | the two permission tests alone, with the capability kept (`CapEff: 0000000000000004`) | after the check | exit status 1: both fail, as they did in the round 1 report. The capability caused that failure, not the change |

Each log is complete: it is the unedited standard output and standard error of its command.

## Checksums

`SHA256SUMS` lists the SHA-256 of each log. Check them with `sha256sum --check SHA256SUMS`.
