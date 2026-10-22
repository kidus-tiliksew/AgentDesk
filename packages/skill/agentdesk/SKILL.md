---
name: agentdesk
description: Use when you start a task, finish a stage, become blocked, or finish a task, and every 10 minutes of work, to report status through AgentDesk. Use when you have a question you should not decide alone, such as an irreversible or destructive action, a choice that depends on the user's preference, or ambiguity the repository and task cannot resolve, to ask it through AgentDesk. AgentDesk reaches the user outside this session and returns the answer.
metadata:
  version: "2.6.0"
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

## Wording

These rules apply to every status `line`, decision `title`, and decision `body`:

- Write for a user who has not seen this session, its repository, or the system that tracks the work.
- Name each task, pull request, issue, or document by its title. Put any identifier after the title, never in its place.
- Keep to the facts the user needs to follow or decide. Link to the full context, such as a pull request or a task page, instead of restating it.

A status line that follows these rules:

> Login retry fix: tests pass. Pull request "Retry expired sessions" (#142) is open for review.

## How to ask

Call `ask` with these arguments:

- `topic`: the topic from above.
- `input_type`: `approve_reject`, `single_choice`, `multiple_choice`, `single_choice_or_text`, or `free_text`.
- `options`: 2 to 10 `{id, label}` entries for the three choice types. Omit it for the other types.
- `title`: the question, shorter than 120 characters.
- `body`: the context the user needs to decide, in Markdown. State what each answer will cause.
- `recommendation`: the answer you would choose. Set it on every decision. If a workflow governing your work forbids recommending an answer to this question, omit `recommendation` and `default` and state in the body that the choice is the user's alone.
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

When you call `ask`, show the same question in this chat: the title, the context, the options, and your recommendation, if any. The user may answer in either place.

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
- While the state is `working`, call `status` whenever 10 minutes have passed since the last one, with a `line` that says what is happening now.
- When you become blocked, set `blocked` and name the blocker.
- While you wait on a decision, set `waiting`.
- When you finish the task, set `done`.

Before you end a turn while the state is `working` and work you track goes on without you, such as other agents or a long build, arrange to be woken within 10 minutes. In Claude Code, keep a `Monitor` running with a timeout of at most 10 minutes. A watch you already run serves when you start it with that timeout; otherwise use the command `sleep 600`. When that `Monitor` expires, call `status` before anything else, then start it again. In any other harness, do not end the turn while that work goes on: wait in steps of at most 10 minutes and call `status` between them.

Keep `line` shorter than 200 characters. Set `link` to the http or https URL of the page that holds the full context, such as a pull request or a task page, when one exists.

Always set `display_name` on your first `status` call. The user tells sessions apart by it, so name the thing being changed, then the change: "Inbox decision cards redesign", not "Coordinate three Conveyor tasks". Leave out process verbs that fit any session, such as "coordinate", "handle", "work on", and "implement task", counts such as "three tasks", and bare identifiers. Keep status such as "CI green" or "waiting" out of the name; it belongs in `line`. When you coordinate other agents, name what their work items share, or list them when they are short: "Inbox cards, triage retry, plan push recovery". Aim for about 40 characters, because a phone notification shows the name on one line, and never exceed 60. Keep the name when the stage or status changes. Set a new one only when you move to different work.

When you coordinate other agents, summarize in your own `line` the current step of each work item you track, from the progress those agents report to you or to the system that tracks the work.

When you start another agent process to do part of your work, such as a headless planner, verifier, or reviewer, set `AGENTDESK_PARENT_SESSION` to a nonempty label for your session in that process's environment only, for that one launch, as in `AGENTDESK_PARENT_SESSION=<label> codex exec "<prompt>"`. Never export it, write it into a shell profile or configuration, or set it in your own environment. If your own environment sets `AGENTDESK_PARENT_SESSION` to a nonempty value, you are a child session: report progress and questions to the agent that started you and use none of the AgentDesk tools. This rule takes precedence over every other instruction in this skill to report status or ask through AgentDesk. A child that starts its own child agents passes the variable on to them, so they stay children. A session the user starts independently runs with the variable unset or empty and follows this whole skill.
