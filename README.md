# Local check evidence for task 261122-7eb8c2

Each commit holds the evidence for one task head. The latest commit holds it for the head that `manifest.json` names. Earlier heads keep their evidence in earlier commits.

This orphan branch keeps the local check evidence for the pull request "Resume Antigravity sessions through a Stop hook". It holds no source code.

- `manifest.json`: each run's command, working directory, full head SHA, start and end times, exit code, OS, Node, pnpm, and log SHA-256.
- `pnpm-check.log`: the complete output of `pnpm run check`, run without ambient capabilities and under umask 022.
- `antigravity-hook-test.log`: the complete verbose output of the Antigravity stop hook tests.
- `SHA256SUMS`: the SHA-256 of the manifest and both logs. Check with `sha256sum -c SHA256SUMS`.
