import { afterEach, describe, expect, it } from "vitest";
import { USAGE } from "../../src/cli.js";
import { parseHookArgs, parseWaitArgs } from "../../src/resume/commands.js";
import { cleanupSandboxes, makeContext } from "../helpers.js";
import { installSandbox } from "./helpers.js";

// component-installer §Commands: the `wait` and `hook` rows of the `agentdesk`
// dispatch, with usage errors at status 2.

afterEach(cleanupSandboxes);

describe("command line for wait and hook", () => {
  it("lists both commands in the help text", () => {
    expect(USAGE).toContain("wait --harness <id> [--codex-thread <thread>] <decision-id>");
    expect(USAGE).toContain("hook <event> --harness <id>");
  });

  it("parses wait with and without a Codex thread", () => {
    expect(parseWaitArgs(["--harness", "claude-code", "dec_1"])).toEqual({
      harness: "claude-code",
      decisionId: "dec_1",
    });
    expect(parseWaitArgs(["dec_1", "--codex-thread", "thr-1", "--harness", "codex"])).toEqual({
      harness: "codex",
      decisionId: "dec_1",
      codexThread: "thr-1",
    });
  });

  it("parses each supported hook", () => {
    expect(parseHookArgs(["stop", "--harness", "codex"])).toEqual({
      event: "stop",
      harness: "codex",
    });
    expect(parseHookArgs(["stop", "--harness", "cursor"])).toEqual({
      event: "stop",
      harness: "cursor",
    });
    expect(parseHookArgs(["--harness", "cursor", "after-mcp"])).toEqual({
      event: "after-mcp",
      harness: "cursor",
    });
  });

  it.each([
    ["wait with no arguments", ["wait"]],
    ["wait without --harness", ["wait", "dec_1"]],
    ["wait without a decision", ["wait", "--harness", "codex"]],
    ["wait with two decisions", ["wait", "--harness", "codex", "dec_1", "dec_2"]],
    ["wait with an unknown harness", ["wait", "--harness", "vim", "dec_1"]],
    ["wait with an unknown option", ["wait", "--harness", "codex", "--fast", "dec_1"]],
    ["wait with an unsafe decision id", ["wait", "--harness", "codex", "../dec"]],
    [
      "wait with an empty Codex thread",
      ["wait", "--harness", "codex", "--codex-thread", "", "dec_1"],
    ],
    ["wait with --harness and no value", ["wait", "dec_1", "--harness"]],
    ["hook with no arguments", ["hook"]],
    ["hook without --harness", ["hook", "stop"]],
    ["hook with an unknown event", ["hook", "start", "--harness", "codex"]],
    ["hook with an unknown harness", ["hook", "stop", "--harness", "vim"]],
    ["hook after-mcp for Codex", ["hook", "after-mcp", "--harness", "codex"]],
    ["hook stop for Claude Code", ["hook", "stop", "--harness", "claude-code"]],
    ["hook with an extra argument", ["hook", "stop", "extra", "--harness", "codex"]],
    ["hook with an unknown option", ["hook", "stop", "--harness", "codex", "--x"]],
  ])("%s is a usage error with status 2 and no request", async (_label, argv) => {
    const sandbox = installSandbox();
    const h = makeContext(sandbox);
    expect(await h.run(argv)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("Usage: agentdesk <command>");
    expect(h.gateway.requests).toEqual([]);
  });
});
