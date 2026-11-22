# Local validation evidence for task 261122-b46c01

This branch holds only evidence and shares no history with `main`. This commit replaces the round 5 evidence (parent commit `34c3103`) with the local check at the round 7 head. It runs under umask 022 and under umask 077.

## Subject

- Repository: kidus-tiliksew/AgentDesk
- Task branch: `conveyor/task-261122-b46c01`
- Head checked: `ca5ed565183c99216f0887a929672203ba4c1f68`
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
| `pnpm-check-umask022.log` | `setpriv … -- bash -c 'umask 022; pnpm run check'` | 2026-11-22T18:12:18Z to 2026-11-22T18:13:45Z | exit status 0. Typecheck passed. Biome found no errors and 17 warnings, the same 17 as on base. Vitest: 97 files, 3118 tests passed, 0 failed, 0 skipped. Mobile Jest: 29 suites, 917 tests passed |
| `pnpm-check-umask077.log` | `setpriv … -- bash -c 'umask 077; pnpm run check'` | 2026-11-22T18:13:45Z to 2026-11-22T18:14:34Z | exit status 1. Vitest: 3117 passed and 1 failed of 3118. The failure is the unchanged `skill.test.ts` test "writes the Claude Code and Codex skills and no Cursor skill when both are installed", which also fails on base (see `base-skill-umask077.log`). `pnpm run check` stops before the mobile tests, so `mobile-umask077.log` runs them |
| `mobile-umask077.log` | `setpriv … -- bash -c 'umask 077; pnpm --filter @agentdesk/mobile test'` | after the checks | exit status 0: 29 suites, 917 tests passed |
| `installer-verbose-umask022.log` | `setpriv … -- bash -c 'umask 022; npx vitest run --project installer --reporter=verbose'` | after the checks | exit status 0: 24 files, 746 tests passed, each named. They include both permission tests and the round 6 cases: `hooks.test.ts` "recognizes the Node bundle's agentdesk.mjs for Antigravity alone", "owns the hook a Node bundle named agentdesk.mjs writes, across re-run, status, and uninstall", and "still refuses a foreign handler that names another bundle file", and `bundle.test.ts` "bundle named agentdesk.mjs with Antigravity > owns its own hook across install, re-run, status, and uninstall" |
| `installer-verbose-umask077.log` | the same with `umask 077` | after the checks | exit status 1: 745 passed and 1 failed. The failure is the same base skill test |
| `base-skill-umask077.log` | carried unchanged from parent commit `34c3103`: `skill.test.ts` at base `e040497` under umask 077 | 2026-11-22, round 5 | exit status 1, `expected 384 to be 420`. This is base behavior and does not depend on the head |
| `control-with-capability.log` | the two permission tests alone, with the capability kept (`CapEff: 0000000000000004`) and umask 022 | after the checks | exit status 1: both fail. The capability causes that failure, not the change |

Each log is the complete, unedited standard output and standard error of its command.

## Checksums

`SHA256SUMS` lists the SHA-256 of each log. Check them with `sha256sum --check SHA256SUMS`.
