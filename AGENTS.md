<!-- conveyor:repo-init owner=v1 version=v0.37.0 -->
## Conveyor factory work

Repository: `agentdesk`. Base branch: `main`.
Server: `https://conveyor.kidus.sh`. Workspace: `agentdesk`.
Select a native MCP connection whose endpoint matches this server and pass workspace `agentdesk` on every call. MCP registration names vary by machine; registering MCP does not set CLI defaults.
CLI example: `conveyor --server 'https://conveyor.kidus.sh' --workspace 'agentdesk' task list`.
Refresh this owned section and the project-scoped skills through ordinary task delivery with `conveyor --server 'https://conveyor.kidus.sh' --workspace 'agentdesk' repo init`. To preserve maintained source skill wrappers, refresh only guidance with `conveyor --server 'https://conveyor.kidus.sh' --workspace 'agentdesk' repo init --guidance-only`.
On connection failure, report the failed endpoint and missing context. Do not infer a replacement host from localhost defaults, SSH configuration, or release instructions.

The confirmed document corpus is the design authority: Requirements, System Design documents, and DEC-n decisions.
Changes are filed as tasks through Conveyor.
An agent edits only under a live claim in a task worktree resolved by `conveyor checkout <task-id>`, never on the base branch.
Follow the `conveyor-plan` skill for planning, `conveyor-file-tasks` for filing tasks, and `conveyor-work` for task work.
This section and the project-scoped skills are versioned with the CLI. Re-run `conveyor repo init` after an upgrade to refresh both, or use `conveyor repo init --guidance-only` to preserve maintained source skill wrappers.
<!-- /conveyor:repo-init -->
