# Local validation evidence for task 261122-b46c01

This branch holds only evidence and shares no history with `main`. This commit replaces the evidence for `3b82673` (parent commit `d0e6ee9`) with the local `pnpm run check` at the round 4 head `e4c4afa`. That head adds the fix for CodeRabbit's partial temporary file finding. The run uses the same method, which lets the `chmod 000` permission tests work.

## Subject

- Repository: kidus-tiliksew/AgentDesk
- Task branch: `conveyor/task-261122-b46c01`
- Head checked: `e4c4afac0e8750d91b5e71b25f5f8607128a7226`
- Pull request: https://github.com/kidus-tiliksew/AgentDesk/pull/206

## Environment

- Host: Linux sandbox (Ubuntu 24.04.4 LTS, kernel Linux 6.8.0-117-generic x86_64)
- Node v22.23.2 (from `.nvmrc`, which pins 22), pnpm 10.34.6, dependencies from `pnpm install --frozen-lockfile`
- User: uid 1000, not root, so the permission tests are not skipped
- This sandbox gives every process the ambient capability `CAP_DAC_READ_SEARCH` (`CapEff: 0000000000000004`), which reads a `chmod 000` file anyway. The first two runs drop it with `setpriv --ambient-caps=-all --inh-caps=-all`, and their logs open with `CapEff: 0000000000000000`.

## Runs

| File | Command | Time (UTC) | Result |
| --- | --- | --- | --- |
| `pnpm-check.log` | `setpriv --ambient-caps=-all --inh-caps=-all -- pnpm run check` | 2026-11-22T13:12:12Z to 2026-11-22T13:14:04Z | exit status 0. Typecheck passed. Biome found no errors and 17 warnings, the same 17 as on base. Vitest: 97 files, 3113 tests passed, 0 failed, 0 skipped. Mobile Jest: 29 suites, 917 tests passed |
| `installer-verbose.log` | `setpriv --ambient-caps=-all --inh-caps=-all -- npx vitest run --project installer --reporter=verbose` | after the check | exit status 0: 24 files, 741 tests passed, each named. They include both permission tests, all 132 cases of `antigravity-paths.test.ts`, and the 2 cases of `write-cleanup.test.ts` |
| `control-with-capability.log` | the two permission tests alone, with the capability kept (`CapEff: 0000000000000004`) | after the check | exit status 1: both fail. The capability causes that failure, not the change |

Each log is the complete, unedited standard output and standard error of its command.

## Checksums

`SHA256SUMS` lists the SHA-256 of each log. Check them with `sha256sum --check SHA256SUMS`.
