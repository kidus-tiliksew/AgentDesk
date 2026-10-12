// Stub harness CLI for tests. Each stub executable on the fake PATH runs this
// script with its own name first. It appends {name, args} to
// AGENTDESK_TEST_LOG. As `claude`, it applies `mcp add` and `mcp remove` to
// $HOME/.claude.json the way Claude Code does at user scope, and echoes the
// header it was given so tests can prove the installer never forwards output.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [name, ...args] = process.argv.slice(2);
const log = process.env.AGENTDESK_TEST_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ name, args })}\n`);

if (name === "claude" && args[0] === "mcp") {
  const file = join(process.env.HOME ?? "", ".claude.json");
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  data.mcpServers ??= {};
  if (args[1] === "remove") {
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
