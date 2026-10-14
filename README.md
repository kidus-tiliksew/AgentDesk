# Evidence for task 261014-bafaf2 (PR #116)

## Round 2: head 3c414c2b68be06bb8e19ea147ae4cc178dc724d5

- `round2/manifest.json` has one entry per local run. Each entry records the command, cwd, full head, start and end times, exit code, environment (OS, Node, pnpm), log file name, and the log's sha256.
- `round2/website-test.log`, `round2/website-build.log`, and `round2/pnpm-check.log` are the complete original stdout and stderr of those runs.
- `round2/landing-metadata.txt` compares the landing page's `<title>`, `<meta>`, and icon tags in `dist/index.html` with the pre-change build in `round2/landing-head-376e95e.html`.
- `screenshots/` and `results.json` come from `browser-check.mjs`, which drives headless Google Chrome over the DevTools protocol against `astro preview` of this head.

## Round 1: head a4221980ae701db53af9fb8d5661a4dedfd34d95

- `round1/pnpm-check-a422198.log` (sha256 `cd346a96…`) and `round1/website-build-a422198.log` (sha256 `db5e0002…`) are the complete original logs.
- The standalone `pnpm --filter @agentdesk/website test` run at a422198 was not saved to a log; its output exists only in the implementer's session transcript. Round 2 replaces it with `round2/website-test.log`.
