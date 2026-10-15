---
name: agentdesk
description: Use when you start a task, finish a stage, become blocked, or finish a task, to report status through AgentDesk. Use when you have a question you should not decide alone, such as an irreversible or destructive action, a choice that depends on the user's preference, or ambiguity the repository and task cannot resolve, to ask it through AgentDesk. AgentDesk reaches the user outside this session and returns the answer.
metadata:
  version: "2.1.0"
---

AgentDesk reaches the user outside this session. Its MCP server offers `ask`, `await`, `check`, `cancel`, `resolve`, and `status`.

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
- `interactive`: set `interactive: true` when the session is interactive, one the user may be watching. Omit it otherwise.

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

When you call `ask`, show the same question in this chat: the title, the context, the options, and your recommendation. The user may answer in either place.

`ask` returns a `decision_id` at once. It does not wait for the answer.

## Waiting

Wait for the answer in resume mode or in await mode. Resume mode applies when all three hold:

- The session is interactive.
- The harness is Claude Code, Codex, or Cursor.
- `command -v agentdesk` finds the installed binary.

Await mode applies in every other session. In both modes, never ask the same question twice, and never create a second decision while the first is `pending`.

In resume mode, after you call `ask` and show the question in this chat:

1. Call `status` with `state` set to `waiting`.
2. In Claude Code, start `Monitor` with the command `agentdesk wait --harness claude-code <decision_id>`, a description that names the question, and the maximum timeout of 30 minutes. When it expires without an event, start it again the same way.
3. In Codex and Cursor, start nothing. The installed hooks resume the session.
4. End your turn without calling `await`.

A turn that begins with `AgentDesk decision <id> settled` is a resume. Call `check` with that id in `decision_ids`. In your first chat message, state the answer and where it was given, from `answered_via`. Then act on it.

In await mode:

1. Call `await` with the `decision_id`. It waits up to `timeout_seconds`. Set `timeout_seconds` to 60 when the session is interactive, so a chat answer reaches you within a minute. Otherwise use a value up to 600.
2. When it returns `pending`, call `await` again with the same `decision_id`. Repeat until the state is `answered`, `expired`, or `cancelled`.
3. Act on the returned `answer` and read its `note`. An `expired` decision with `applied_by_default` carries the `default` as its `answer`.

A coordinator that runs several tasks may call `check` with `decision_ids` between tasks instead of waiting on each decision.

When a pending question no longer matters, call `cancel` with its `decision_id`.

When a chat message arrives while the decision is `pending`, in either mode:

- If it answers the decision, call `resolve` with the `decision_id`, the `answer`, and `chat_message` holding the user's message word for word. Write the `answer` in the shapes shown above for `recommendation` and `default`. In Claude Code, stop the running `Monitor` with `TaskStop`. Never relay an answer the user did not write.
- If it does not answer the decision, handle the message and leave the decision pending. In await mode, call `await` again with the same `decision_id`. In resume mode, end your turn again and leave any running `Monitor` in place. When the message makes the question moot, call `cancel` with the `decision_id` instead.
- If `resolve` is rejected because the decision is already settled, act on the `answer` in the decision it returns.

## Status

Call `status` with `topic`, `state`, and `line`:

- When you start a task, set `working`.
- When you finish a stage, set `working` and name the finished stage.
- When you become blocked, set `blocked` and name the blocker.
- While you wait on a decision, set `waiting`.
- When you finish the task, set `done`.

Keep `line` shorter than 200 characters. Set `link` to an http or https URL, such as a pull request, when one exists.
