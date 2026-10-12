# Testing the installer

`component-installer` §Verification governs this file.

## Automated tests

`pnpm --filter agentdesk test` runs the Vitest project `installer`, and root `pnpm check` runs it with every other package. The tests need Node 22, `sh`, `curl`, `tar`, and `npm`. They need no Bun, no network, and no real harness configuration.

| File | Covers |
| --- | --- |
| `test/harnesses.test.ts` | detection of each harness by executable and by configuration path, including `CODEX_HOME` |
| `test/cli.test.ts` | selection, deselection, `--only`, `--yes`, empty selection, `--server` stored and applied, usage errors |
| `test/config.test.ts` | the `claude mcp remove` and `claude mcp add` arguments, the `~/.claude.json` fallback, byte-preserving Codex table replacement, `~/.cursor/mcp.json` merges, malformed-file refusal, once-per-run backups |
| `test/signin.test.ts` | approval for several harnesses, the 2-second poll interval on a fake clock, decline, expiry and a new code, invalid approved results, server errors, secrecy of tokens and device secrets |
| `test/state.test.ts` | state contents and mode 0600, re-runs that keep working connections and refresh the skill, server changes, `status`, `uninstall` with failed revocation and redirected paths |
| `test/uninstall-safety.test.ts` | refusal of a symlinked skill folder and of a redirected skill parent for each harness; malformed and unreadable configuration and a nonzero `claude mcp remove`, each keeping the record and exiting with status 1 |
| `test/skill.test.ts` | the Cursor skill rule, `supportsSkills: false`, `skill install` |
| `test/packaging.test.ts` | the bundle built by `scripts/build.mjs`, packed with `npm pack` and run outside the workspace against a local HTTP gateway |
| `test/install-script.test.ts` | `install.sh` under `sh` against a `file://` download directory: platform selection, checksum success and mismatch, the `PATH` hint, the placeholder; `scripts/build-binaries.mjs` with a stub Bun |

The tests use temporary home directories, a fake `PATH` holding stub `claude`, `codex`, and `cursor-agent` executables that record their arguments (`test/fixtures/fake-harness.mjs`), and an in-process fake gateway that follows `component-gateway` §Sign-in endpoints. They prove the installer's side of the protocol, not a live sign-in.

## Building

```sh
AGENTDESK_SERVER_ORIGIN=https://agentdesk.example pnpm --filter agentdesk build
AGENTDESK_SERVER_ORIGIN=https://agentdesk.example pnpm --filter agentdesk build:binaries
```

`AGENTDESK_SERVER_ORIGIN` is required and becomes the default server. `build` writes `dist/agentdesk.mjs`, the npm entry. `build:binaries` also needs Bun and writes `agentdesk-darwin-arm64`, `agentdesk-darwin-x64`, `agentdesk-linux-x64`, `agentdesk-linux-arm64`, and `SHA256SUMS` to `dist/release/`.

## Manual check before each release

Run this on a macOS machine and on a Linux host reached over SSH with no display. Use a release candidate's binaries and its deployed gateway. Record the date, the release tag, each host, and the result of each step. A step not run stays unverified; the automated tests do not stand in for it.

1. Install with `curl -fsSL <origin>/install.sh | sh`. Confirm the script names the binary for the host, verifies the checksum, installs `~/.local/bin/agentdesk`, prints a `PATH` hint when that directory is not on `PATH`, and prints `agentdesk install --server <origin>` as the next step.
2. Run `agentdesk install` with Claude Code, Codex, and Cursor installed. Confirm all three are listed and selected, and that no browser opens.
3. Enter the printed `XXXX-XXXX` code in the AgentDesk app under Add machine. Confirm the app shows the host name and the three harnesses, then approve. Confirm the installer finishes within 10 seconds of approval and prints no token.
4. Confirm `~/.claude.json`, `${CODEX_HOME:-~/.codex}/config.toml`, and `~/.cursor/mcp.json` hold the `agentdesk` entry, that unrelated entries are unchanged, and that `~/.config/agentdesk/state.json` has mode 0600 and holds no token.
5. In a new directory with no AgentDesk file, start a new session of each harness and have the agent call `ask`. Confirm each decision reaches the phone.
6. Run `agentdesk install` again. Confirm no code is shown and every connection keeps working.
7. Revoke one connection in the app, then run `agentdesk install` again. Confirm a code is shown only for that harness.
8. Run `agentdesk status`. Confirm each harness shows its connection check and skill version.
9. Revoke one connection in the app, run `agentdesk install` again, and decline in the app. Confirm the installer exits with status 1 and prints "Sign-in was declined in the app".
10. Run `agentdesk uninstall`. Confirm the app no longer lists the connections, the `agentdesk` entries and skill folders are gone, other entries and skills remain, and the state file is deleted.
