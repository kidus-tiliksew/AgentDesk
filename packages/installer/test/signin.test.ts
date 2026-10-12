import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_INSTRUCTION, DECLINED_MESSAGE } from "../src/signin.js";
import { statePath } from "../src/state.js";
import {
  cleanupSandboxes,
  makeContext,
  makeSandbox,
  read,
  readJson,
  type Sandbox,
  SERVER,
  stubExecutable,
} from "./helpers.js";

afterEach(cleanupSandboxes);

function allThree(): Sandbox {
  const sandbox = makeSandbox();
  stubExecutable(sandbox, "claude");
  stubExecutable(sandbox, "codex");
  stubExecutable(sandbox, "cursor-agent");
  return sandbox;
}

describe("short-code sign-in (component-installer §Sign-in)", () => {
  it("sends the host name and harness ids, prints the code, and writes one token per harness (AC-6.1, AC-6.3, AC-6.4)", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox);
    expect(await h.run(["install", "--yes"])).toBe(0);

    const start = h.gateway.startRequests();
    expect(start).toHaveLength(1);
    expect(start[0]?.url).toBe(`${SERVER}/device/start`);
    expect(start[0]?.body).toEqual({
      machine_name: "devbox-1",
      harnesses: ["claude-code", "codex", "cursor"],
    });
    expect(h.out).toContain("  ABCD-1001");
    expect(h.out).toContain(CODE_INSTRUCTION);

    const poll = h.gateway.requests.filter((r) => r.path === "/device/poll");
    expect(poll[0]?.body).toEqual({ device_secret: h.gateway.deviceSecrets[0] });

    const tokens = ["claude-code", "codex", "cursor"].map((id) => h.gateway.tokenFor(id));
    expect(new Set(tokens).size).toBe(3);
    const claude = readJson(join(sandbox.home, ".claude.json")).mcpServers as Record<
      string,
      { headers: Record<string, string> }
    >;
    expect(claude.agentdesk?.headers.Authorization).toBe(`Bearer ${tokens[0]}`);
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toContain(`"Bearer ${tokens[1]}"`);
    const cursor = readJson(join(sandbox.home, ".cursor", "mcp.json")).mcpServers as Record<
      string,
      { headers: Record<string, string> }
    >;
    expect(cursor.agentdesk?.headers.Authorization).toBe(`Bearer ${tokens[2]}`);

    const state = readJson(statePath(h.ctx)).harnesses as Record<string, { connectionId: string }>;
    expect(state["claude-code"]?.connectionId).toBe(h.gateway.issued[0]?.connectionId);
    expect(state.codex?.connectionId).toBe(h.gateway.issued[1]?.connectionId);
    expect(state.cursor?.connectionId).toBe(h.gateway.issued[2]?.connectionId);
  });

  it("polls every 2 seconds on the clock while the request is pending", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    h.gateway.scripts = [["pending", "pending", "pending", "approved"]];
    expect(await h.run(["install", "--yes"])).toBe(0);
    const polls = h.gateway.requests.filter((r) => r.path === "/device/poll").map((r) => r.at);
    expect(polls).toEqual([2000, 4000, 6000, 8000]);
    expect(h.clock.sleeps).toEqual([2000, 2000, 2000, 2000]);
  });

  it("keeps polling through a transient server error", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    h.gateway.scripts = [["pending", 503, "approved"]];
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.gateway.requests.filter((r) => r.path === "/device/poll")).toHaveLength(3);
  });

  it("exits with status 1 and the decline message when the user declines (AC-6.6)", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox);
    h.gateway.scripts = [["pending", "declined"]];
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err).toEqual([DECLINED_MESSAGE]);
    expect(existsSync(join(sandbox.home, ".codex"))).toBe(false);
    expect(existsSync(join(sandbox.home, ".cursor"))).toBe(false);
    expect(existsSync(statePath(h.ctx))).toBe(false);
  });

  it("offers a new code after expiry and continues with it", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox, { answers: [""] });
    h.gateway.scripts = [["pending", "expired"], ["approved"]];
    expect(await h.run(["install", "--only", "codex"])).toBe(0);
    expect(h.prompts).toEqual(["Press Enter for a new code, or type q to stop: "]);
    expect(h.gateway.startRequests()).toHaveLength(2);
    expect(h.out).toContain("The code expired.");
    expect(h.out).toContain("  ABCD-1001");
    expect(h.out).toContain("  ABCD-1002");
    expect(read(join(sandbox.home, ".codex", "config.toml"))).toContain(
      h.gateway.tokenFor("codex"),
    );
  });

  it("stops when the user declines a new code after expiry", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox, { answers: ["q"] });
    h.gateway.scripts = [["expired"]];
    expect(await h.run(["install", "--only", "codex"])).toBe(1);
    expect(h.gateway.startRequests()).toHaveLength(1);
    expect(existsSync(join(sandbox.home, ".codex"))).toBe(false);
  });

  it("requests new codes automatically without a terminal, up to three codes", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    h.gateway.scripts = [["expired"], ["expired"], ["expired"], ["approved"]];
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.gateway.startRequests()).toHaveLength(3);
    expect(h.err.join("\n")).toContain("The code expired 3 times");

    const secondSandbox = makeSandbox();
    stubExecutable(secondSandbox, "codex");
    const second = makeContext(secondSandbox);
    second.gateway.scripts = [["expired"], ["approved"]];
    expect(await second.run(["install", "--yes"])).toBe(0);
    expect(second.gateway.startRequests()).toHaveLength(2);
  });

  it("treats a code as expired when its lifetime passes while pending", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    h.gateway.expiresIn = 6;
    h.gateway.scripts = [["pending"], ["approved"]];
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.gateway.requests.filter((r) => r.path === "/device/poll").map((r) => r.at)).toEqual([
      2000, 4000, 6000, 8000,
    ]);
    expect(h.gateway.startRequests()).toHaveLength(2);
  });

  it.each([
    ["a missing harness", (c: unknown[]) => c.slice(1)],
    ["a duplicate token", (c: { token: string }[]) => c.map((x) => ({ ...x, token: c[0]?.token }))],
    [
      "a duplicate connection id",
      (c: { connection_id: string }[]) => c.map((x) => ({ ...x, connection_id: "same" })),
    ],
    [
      "an unrequested harness",
      (c: { harness: string }[]) => c.map((x, i) => (i === 0 ? { ...x, harness: "vscode" } : x)),
    ],
  ])("refuses an approved result with %s and prints no token", async (_label, mutate) => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    stubExecutable(sandbox, "cursor-agent");
    const h = makeContext(sandbox);
    const connections = [
      { harness: "codex", connection_id: "c1", token: "adc_secretcodex000000000000000000000" },
      { harness: "cursor", connection_id: "c2", token: "adc_secretcursor00000000000000000000" },
    ];
    h.gateway.approvedOverride = (mutate as (c: typeof connections) => unknown)(connections);
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err).toEqual([`AgentDesk at ${SERVER} returned an invalid sign-in result.`]);
    expect(h.output()).not.toContain("adc_secret");
    expect(existsSync(join(sandbox.home, ".codex", "config.toml"))).toBe(false);
  });

  it("reports a failed start by status without the response body", async () => {
    const sandbox = makeSandbox();
    stubExecutable(sandbox, "codex");
    const h = makeContext(sandbox);
    h.gateway.startStatus = 500;
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err).toEqual([`AgentDesk at ${SERVER} answered 500 to the sign-in request.`]);
    h.gateway.startStatus = 429;
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err[1]).toContain("Too many sign-in requests");
  });

  it("never prints a device secret or a token", async () => {
    const sandbox = allThree();
    const h = makeContext(sandbox);
    h.gateway.scripts = [["pending", "approved"]];
    expect(await h.run(["install", "--yes"])).toBe(0);
    const output = h.output();
    for (const secret of [...h.gateway.deviceSecrets, ...h.gateway.issued.map((i) => i.token)]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain("[redacted]");
  });
});
