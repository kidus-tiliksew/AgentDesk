# Local validation evidence for task 261122-b46c01

This branch holds only evidence and shares no history with `main`. This commit replaces the round 3 evidence (parent commit `6b251bd`) with the local `pnpm run check` at the round 4 head. The run uses the same method, which lets the `chmod 000` permission tests work.

## Subject

- Repository: kidus-tiliksew/AgentDesk
- Task branch: `conveyor/task-261122-b46c01`
- Head checked: `3b82673a1fdaa467d6a7ee492c680373e7c4611c`
- Pull request: https://github.com/kidus-tiliksew/AgentDesk/pull/206

## Environment

- Host: Linux sandbox (Ubuntu 24.04.4 LTS, kernel Linux 6.8.0-117-generic x86_64)
- Node v22.23.2 (from `.nvmrc`, which pins 22), pnpm 10.34.6, dependencies from `pnpm install --frozen-lockfile`
- User: uid 1000, not root, so the permission tests are not skipped
- This sandbox gives every process the ambient capability `CAP_DAC_READ_SEARCH` (`CapEff: 0000000000000004`), which reads a `chmod 000` file anyway. The first two runs drop it with `setpriv --ambient-caps=-all --inh-caps=-all`, and their logs open with `CapEff: 0000000000000000`.

## Runs

| File | Command | Time (UTC) | Result |
| --- | --- | --- | --- |
| `pnpm-check.log` | `setpriv --ambient-caps=-all --inh-caps=-all -- pnpm run check` | 2026-11-22T12:59:53Z to 2026-11-22T13:01:18Z | exit status 0. Typecheck passed. Biome found no errors and 17 warnings, the same 17 as on base. Vitest: 96 files, 3111 tests passed, 0 failed, 0 skipped. Mobile Jest: 29 suites, 917 tests passed |
| `installer-verbose.log` | `setpriv --ambient-caps=-all --inh-caps=-all -- npx vitest run --project installer --reporter=verbose` | after the check | exit status 0: 23 files, 739 tests passed, each named. They include both permission tests and all 132 cases of `antigravity-paths.test.ts` |
| `control-with-capability.log` | the two permission tests alone, with the capability kept (`CapEff: 0000000000000004`) | after the check | exit status 1: both fail. The capability causes that failure, not the change |

Each log is the complete, unedited standard output and standard error of its command.

## Checksums

`SHA256SUMS` lists the SHA-256 of each log. Check them with `sha256sum --check SHA256SUMS`.
