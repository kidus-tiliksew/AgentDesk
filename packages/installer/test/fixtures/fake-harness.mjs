// Stub harness CLI for tests. Each stub executable on the fake PATH runs this
// script with its own name first. It appends {name, args} to
// AGENTDESK_TEST_LOG. As `claude`, it applies `mcp add` and `mcp remove` to
// $HOME/.claude.json the way Claude Code does at user scope, and echoes the
// header it was given so tests can prove the installer never forwards output.
// FAKE_CLAUDE_FAIL fails `mcp add`; FAKE_CLAUDE_REMOVE_FAIL fails `mcp remove`
// without a change; FAKE_CLAUDE_REMOVE_CORRUPT fails it after corrupting the file.
//
// As `codex app-server`, it speaks the JSON-RPC that Codex 0.162.1 speaks over
// stdio (component-installer §Codex trust): it answers `initialize` and
// `hooks/list`, sends a notification before every answer and a server request
// before the hooks/list answer, and appends each message it receives to
// `$AGENTDESK_TEST_LOG.rpc` and its process id to `$AGENTDESK_TEST_LOG.pids`.
// `hooks/list` reads `hooks.json` and
// `config.toml` under CODEX_HOME (default ~/.codex): each SessionStart handler
// is keyed `<real path>:session_start:<group>:<handler>` and each Stop handler
// `<real path>:stop:<group>:<handler>`, hashed like `codexHookHash` in
// test/helpers.ts over the event and the handler's definition, never its
// position, and `trusted`, `modified`, or `untrusted` against
// `[hooks.state."<key>"] trusted_hash`.
// FAKE_CODEX_APP_SERVER=fail exits with status 2 at once; =hang never answers
// `hooks/list`; =missing leaves the AgentDesk session-start hook out of the
// list, =missing-stop the AgentDesk Stop hook, and =missing-all both;
// =project reports every hook with `source: "project"`; =malformed reports
// each hook's `currentHash` as a number; =error answers `hooks/list` with a
// JSON-RPC error.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse as parseToml } from "smol-toml";

const [name, ...args] = process.argv.slice(2);
const log = process.env.AGENTDESK_TEST_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ name, args })}\n`);

if (name === "claude" && args[0] === "mcp") {
  const file = join(process.env.HOME ?? "", ".claude.json");
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  data.mcpServers ??= {};
  if (args[1] === "remove") {
    if (process.env.FAKE_CLAUDE_REMOVE_FAIL === "1") {
      process.stderr.write("remove failed\n");
      process.exit(4);
    }
    if (process.env.FAKE_CLAUDE_REMOVE_CORRUPT === "1") {
      writeFileSync(file, "{ broken");
      process.exit(1);
    }
    if (!data.mcpServers.agentdesk) {
      process.stderr.write("No user-scoped MCP server found with name: agentdesk\n");
      process.exit(1);
    }
    delete data.mcpServers.agentdesk;
  } else if (args[1] === "add") {
    const entryName = args[6];
    const url = args[7];
    const header = args[9] ?? "";
    if (process.env.FAKE_CLAUDE_FAIL === "1") {
      process.stderr.write(`failed to add ${entryName} with header ${header}\n`);
      process.exit(3);
    }
    const separator = header.indexOf(": ");
    data.mcpServers[entryName] = {
      type: "http",
      url,
      headers: { [header.slice(0, separator)]: header.slice(separator + 2) },
    };
    process.stdout.write(`Added HTTP MCP server ${entryName} with header ${header}\n`);
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function codexHookHash(matcher, handler, event = "session_start") {
  const definition = JSON.stringify([
    event,
    matcher ?? null,
    handler?.type ?? null,
    handler?.command ?? null,
    handler?.timeout ?? null,
  ]);
  return `sha256:${createHash("sha256").update(definition).digest("hex")}`;
}

/** The events the stub lists: the configuration key, the key segment, and the reported name. */
const EVENTS = [
  ["SessionStart", "session_start", "sessionStart"],
  ["Stop", "stop", "stop"],
];

const LEFT_OUT = {
  missing: [" context --harness codex"],
  "missing-stop": [" hook stop --harness codex"],
  "missing-all": [" context --harness codex", " hook stop --harness codex"],
};

function listCodexHooks(codexHome, mode) {
  const file = join(codexHome, "hooks.json");
  if (!existsSync(file)) return [];
  const real = realpathSync(file);
  const document = JSON.parse(readFileSync(file, "utf8"));
  const config = join(codexHome, "config.toml");
  const state = existsSync(config)
    ? (parseToml(readFileSync(config, "utf8")).hooks?.state ?? {})
    : {};
  const hooks = [];
  for (const [name, segment, eventName] of EVENTS) {
    const groups = document?.hooks?.[name];
    // Codex lists no hook from an event whose value is not a list.
    (Array.isArray(groups) ? groups : []).forEach((group, groupIndex) => {
      (Array.isArray(group?.hooks) ? group.hooks : []).forEach((handler, handlerIndex) => {
        const key = `${real}:${segment}:${groupIndex}:${handlerIndex}`;
        const currentHash = codexHookHash(group.matcher, handler, segment);
        const trusted = state[key]?.trusted_hash;
        hooks.push({
          key,
          eventName,
          handlerType: "command",
          command: handler?.command,
          matcher: group.matcher ?? null,
          sourcePath: real,
          source: mode === "project" ? "project" : "user",
          currentHash: mode === "malformed" ? 7 : currentHash,
          trustStatus:
            trusted === undefined ? "untrusted" : trusted === currentHash ? "trusted" : "modified",
        });
      });
    });
  }
  const leftOut = LEFT_OUT[mode] ?? [];
  return hooks.filter((hook) => !leftOut.some((suffix) => String(hook.command).endsWith(suffix)));
}

if (name === "codex" && args[0] === "app-server") {
  const mode = process.env.FAKE_CODEX_APP_SERVER ?? "ok";
  if (log) appendFileSync(`${log}.pids`, `${process.pid}\n`);
  if (mode === "fail") {
    process.stderr.write("app-server failed\n");
    process.exit(2);
  }
  const home = process.env.HOME ?? "";
  const codexHome = process.env.CODEX_HOME
    ? resolve(home, process.env.CODEX_HOME)
    : join(home, ".codex");
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (log) appendFileSync(`${log}.rpc`, `${JSON.stringify(message)}\n`);
    if (message.id === undefined) return;
    send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-codex/0.162.1" } });
    } else if (message.method === "hooks/list") {
      if (mode === "hang") return;
      if (mode === "error") {
        send({ id: message.id, error: { code: -32603, message: "hooks unavailable" } });
        return;
      }
      // A server request reusing the client's id is not the answer.
      send({ id: message.id, method: "item/tool/requestUserInput", params: {} });
      send({
        id: message.id,
        result: {
          data: [
            {
              cwd: message.params?.cwds?.[0],
              hooks: listCodexHooks(codexHome, mode),
              warnings: [],
              errors: [],
            },
          ],
        },
      });
    } else {
      send({ id: message.id, error: { code: -32601, message: "unknown method" } });
    }
  });
  input.on("close", () => process.exit(0));
}
