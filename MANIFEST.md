# Local validation evidence for task 261122-b46c01

This branch holds only evidence and shares no history with `main`. This commit replaces the round 4 evidence (parent commit `9a77460`) with the local check at the round 5 head. It runs under umask 022 and under umask 077, as review round 4 asked.

## Subject

- Repository: kidus-tiliksew/AgentDesk
- Task branch: `conveyor/task-261122-b46c01`
- Head checked: `aeb45a9ddf2445f987862d62cfab0dc508fc9fb4`
- Base: `e0404974c2a2a3f56e616b9583fd30014d07eb34`
- Pull request: https://github.com/kidus-tiliksew/AgentDesk/pull/206

## Environment

- Host: Linux sandbox (Ubuntu 24.04.4 LTS, kernel Linux 6.8.0-117-generic x86_64)
- Node v22.23.2 (from `.nvmrc`, which pins 22), pnpm 10.34.6, dependencies from `pnpm install --frozen-lockfile`
- User: uid 1000, not root, so the permission tests are not skipped
- This sandbox gives every process the ambient capability `CAP_DAC_READ_SEARCH` (`CapEff: 0000000000000004`), which reads a `chmod 000` file anyway. Every run except the control drops it with `setpriv --ambient-caps=-all --inh-caps=-all`. Each log opens with its umask and `CapEff` line.

## Runs

| File | Command | Time (UTC) | Result |
| --- | --- | --- | --- |
| `pnpm-check-umask022.log` | `setpriv … -- bash -c 'umask 022; pnpm run check'` | 2026-11-22T13:25:02Z to 2026-11-22T13:26:29Z | exit status 0. Typecheck passed. Biome found no errors and 17 warnings, the same 17 as on base. Vitest: 97 files, 3114 tests passed, 0 failed, 0 skipped. Mobile Jest: 29 suites, 917 tests passed |
| `pnpm-check-umask077.log` | `setpriv … -- bash -c 'umask 077; pnpm run check'` | 2026-11-22T13:26:29Z to 2026-11-22T13:27:17Z | exit status 1. Typecheck and Biome passed as above. Vitest: 3113 passed and 1 failed of 3114. The failure is `skill.test.ts` "writes the Claude Code and Codex skills and no Cursor skill when both are installed", which expects mode 0644 and gets 0600. This change does not touch that test, and it fails the same way on base (see `base-skill-umask077.log`). `pnpm run check` stops before the mobile tests after a Vitest failure, so `mobile-umask077.log` runs them separately |
| `mobile-umask077.log` | `setpriv … -- bash -c 'umask 077; pnpm --filter @agentdesk/mobile test'` | after the checks | exit status 0: 29 suites, 917 tests passed |
| `installer-verbose-umask022.log` | `setpriv … -- bash -c 'umask 022; npx vitest run --project installer --reporter=verbose'` | after the checks | exit status 0: 24 files, 742 tests passed, each named. They include both permission tests and `config.test.ts` "keeps a replaced file's mode under umask 077, and gives a new file 0600" |
| `installer-verbose-umask077.log` | the same with `umask 077` | after the checks | exit status 1: 741 passed and 1 failed. The failure is the same base skill test. The new umask 077 test passes |
| `base-skill-umask077.log` | at base `e040497` (`packages/installer` and `packages/skill` checked out from base in the task worktree, then restored to the head), `setpriv … -- bash -c 'umask 077; npx vitest run --project installer test/skill.test.ts'` | before the checks | exit status 1: the same test fails on base, `expected 384 to be 420` (0600 for 0644). This shows the base suite expects umask 022 |
| `control-with-capability.log` | the two permission tests alone, with the capability kept (`CapEff: 0000000000000004`) and umask 022 | after the checks | exit status 1: both fail. The capability causes that failure, not the change |

Each log is the complete, unedited standard output and standard error of its command.

## Checksums

`SHA256SUMS` lists the SHA-256 of each log. Check them with `sha256sum --check SHA256SUMS`.
