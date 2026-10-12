---
name: agentdesk
description: Use when you work without the user watching and meet a choice you should not make alone, or reach a point worth reporting. AgentDesk asks the user on their phone, returns the answer, and shows your status.
metadata:
  version: "1.0.0"
---

# AgentDesk

AgentDesk reaches the user while you work unattended. Its MCP server offers `ask`, `await`, `check`, `cancel`, and `status`.

## Topic

Pass a `topic` to every `ask` and `status` call. Derive it once per task:

1. If the `AGENTDESK_TOPIC` environment variable is set, use its value and skip the steps below.
2. Run `git remote get-url origin`.
3. Parse the URL to `owner/name`:
   - HTTPS: `https://github.com/Acme/Api.git` gives `acme/api`.
   - SSH URL: `ssh://git@github.com/Acme/Api.git` gives `acme/api`.
   - SSH scp form: `git@github.com:Acme/Api.git` gives `acme/api`.
4. Keep the last two path segments. Drop a trailing `.git`. Lowercase the result.
5. If the repository has no origin remote, use the name of the working directory.

## When to ask

Ask only when one of these holds:

- The next action is irreversible or destructive, such as deleting data, force-pushing, publishing, or changing production.
- The choice depends on the user's preference, not on facts you can check.
- The task is ambiguous, and neither the repository nor the task resolves it.

Otherwise decide yourself. Name the choice in your next `status` line.

## How to ask

Call `ask` with these arguments:

- `topic`: the topic from above.
- `input_type`: `approve_reject`, `single_choice`, `multiple_choice`, `single_choice_or_text`, or `free_text`.
- `options`: 2 to 10 `{id, label}` entries for the three choice types. Omit it for the other types.
- `title`: the question, shorter than 120 characters.
- `body`: the context the user needs to decide, in Markdown.
- `recommendation`: the answer you would choose. Set it on every decision.
- `deadline` and `default`: set both when the default action is reversible. `deadline` is an ISO 8601 time in the future. `default` is the answer applied when the deadline passes.

Set no `default` when the default action is irreversible. Never set `default` without `deadline`.

Write `recommendation` and `default` as answers valid for the input type:

- `approve_reject`: `{"kind": "approve"}` or `{"kind": "reject"}`.
- `single_choice`: `{"kind": "option", "option_id": "pg"}`.
- `multiple_choice`: `{"kind": "options", "option_ids": ["pg", "mysql"]}`.
- `free_text`: `{"kind": "text", "text": "Use Postgres"}`.
- `single_choice_or_text`: an option answer or a text answer.

Example arguments:

```json
{
  "topic": "acme/api",
  "input_type": "single_choice",
  "title": "Which database should the migration target?",
  "body": "Staging runs Postgres 16. Production runs MySQL 8.",
  "options": [
    { "id": "pg", "label": "Postgres 16" },
    { "id": "mysql", "label": "MySQL 8" }
  ],
  "recommendation": { "kind": "option", "option_id": "pg" },
  "deadline": "<ISO 8601 time, one hour from now>",
  "default": { "kind": "option", "option_id": "pg" }
}
```

`ask` returns a `decision_id` at once. It does not wait for the answer.

## Waiting

1. Call `await` with the `decision_id`. It waits up to `timeout_seconds`, 300 by default and 600 at most.
2. When it returns `pending`, call `await` again with the same `decision_id`. Repeat until the state is `answered`, `expired`, or `cancelled`.
3. Never ask the same question twice. Never create a second decision while the first is `pending`.
4. Act on the returned `answer` and read its `note`. An `expired` decision with `applied_by_default` carries the `default` as its `answer`.

A coordinator that runs several tasks may call `check` with `decision_ids` between tasks instead of waiting on each decision.

When a pending question no longer matters, call `cancel` with its `decision_id`.

## Status

Call `status` with `topic`, `state`, and `line`:

- When you start a task, set `working`.
- When you finish a stage, set `working` and name the finished stage.
- When you become blocked, set `blocked` and name the blocker.
- While you wait on a decision, set `waiting`.
- When you finish the task, set `done`.

Keep `line` shorter than 200 characters. Set `link` to an http or https URL, such as a pull request, when one exists.
