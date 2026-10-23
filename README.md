<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/header-dark.png">
  <img alt="Claude Code, Codex, Cursor, and any other MCP client connect to AgentDesk over MCP. AgentDesk sends their questions to the AgentDesk phone app, and other clients such as Slack, email, or your own can connect through the HTTP API and webhooks." src=".github/readme/header-light.png">
</picture>

# AgentDesk

AgentDesk is an inbox for your coding agents. Agents ask you for decisions and report their status over MCP. You answer from an AgentDesk client, such as the mobile app, and the agent picks up the answer and keeps going.

- Agents ask approve-or-reject, multiple-choice, or free-text questions, with a recommendation and an optional deadline and default.
- Live status cards show what each agent is doing and flag agents that have gone quiet.
- Server-side notification rules decide what notifies you right away, what waits for the daily digest, and what stays silent.
- One install per machine covers every repository. It works on remote devboxes over SSH, and you approve the machine from your phone.
- A published HTTP API and webhooks let anyone build another client, such as Slack or email.

AgentDesk is in early development. The Android app is on [Google Play](https://play.google.com/store/apps/details?id=sh.kidus.agentdesk). The iOS app is not in the App Store yet.

## Install

On macOS or Linux, run:

```sh
curl -fsSL https://agentdesk.kidus.sh/install | sh
```

The script downloads the `agentdesk` binary, checks its checksum, and installs it to `~/.local/bin`. It then runs `agentdesk install`, which finds Claude Code, Codex, and Cursor on the machine and sets up the ones you keep at user scope, so every repository on the machine can reach AgentDesk. To sign the machine in, it shows a short code, and you approve the machine from your phone. It works the same over SSH, with no browser on the machine. When the install finishes, start a new agent session.

To pass flags to `agentdesk install`, put them after `sh -s --`. For example, to set up only Codex:

```sh
curl -fsSL https://agentdesk.kidus.sh/install | sh -s -- --only codex
```

`--only` takes a comma-separated list of `claude-code`, `codex`, and `cursor`. `--yes` keeps every detected harness without asking.

Afterwards:

- `agentdesk status` shows each harness AgentDesk set up and whether its connection works.
- `agentdesk uninstall` revokes the machine's connections and removes everything the installer wrote.

If `~/.local/bin` is not on your `PATH`, the script says so. Add it, for example with `export PATH="$HOME/.local/bin:$PATH"`.

In Cursor, if you type a reply in the chat while the agent is waiting on a question, Cursor queues the message. Press Enter on the queued message to steer it to the agent.

To run the mobile app on an iOS simulator, follow [apps/mobile/README.md](apps/mobile/README.md).

## License

MIT. See [LICENSE](LICENSE).
