import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath } from "../src/state.js";
import {
  cleanupSandboxes,
  FakeClock,
  FakeGateway,
  makeContext,
  makeSandbox,
  read,
  readJson,
  type Sandbox,
  SERVER,
  stubExecutable,
  write,
} from "./helpers.js";

// Review round 3: no issued connection is forgotten unless it is revoked or
// the person explicitly forgets it with --forget-unrevoked. install keeps a
// non-secret recovery record (harness, connection id, server) for each
// connection whose revocation is not established.

afterEach(cleanupSandboxes);

interface Unrevoked {
  harness: string;
  connectionId: string;
  server: string;
  reason: string;
}

function setup(executables: string[]) {
  const sandbox = makeSandbox();
  for (const name of executables) stubExecutable(sandbox, name);
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  return { sandbox, clock, gateway };
}

function stateOf(sandbox: Sandbox) {
  const file = join(sandbox.home, ".config", "agentdesk", "state.json");
  return {
    file,
    state: readJson(file) as {
      harnesses: Record<string, Record<string, string>>;
      unrevoked?: Unrevoked[];
    },
  };
}

function expectNoTokens(sandbox: Sandbox, gateway: FakeGateway) {
  const { file } = stateOf(sandbox);
  const text = read(file);
  for (const issued of gateway.issued) expect(text).not.toContain(issued.token);
}

/** status and uninstall list the id; uninstall exits 1 until --forget-unrevoked. */
async function expectListedUntilForgotten(
  sandbox: Sandbox,
  gateway: FakeGateway,
  clock: FakeClock,
  connectionId: string,
) {
  const status = makeContext(sandbox, { gateway, clock });
  expect(await status.run(["status"])).toBe(0);
  expect(status.output()).toContain(connectionId);

  const uninstall = makeContext(sandbox, { gateway, clock });
  expect(await uninstall.run(["uninstall"])).toBe(1);
  expect(uninstall.err.join("\n")).toContain(connectionId);
  expect(uninstall.err.join("\n")).toContain("agentdesk uninstall --forget-unrevoked");
  expect(stateOf(sandbox).state.unrevoked?.map((u) => u.connectionId)).toContain(connectionId);
  expectNoTokens(sandbox, gateway);

  const forget = makeContext(sandbox, { gateway, clock });
  expect(await forget.run(["uninstall", "--forget-unrevoked"])).toBe(0);
  expect(forget.out.join("\n")).toContain(`Forgot connection ${connectionId}`);
  expect(existsSync(statePath(forget.ctx))).toBe(false);
}

describe("install keeps connections it cannot revoke", () => {
  it("records the old connection when --server replaces it and its DELETE fails", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const old = gateway.issued[0];
    gateway.deleteStatus.set(old?.token ?? "", 503);

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--server", "https://other.example"])).toBe(1);
    expect(h.err.join("\n")).toContain(`${old?.connectionId}`);
    const { state } = stateOf(sandbox);
    expect(state.harnesses.codex?.connectionId).toBe(gateway.issued[1]?.connectionId);
    expect(state.unrevoked).toEqual([
      expect.objectContaining({
        harness: "codex",
        connectionId: old?.connectionId,
        server: SERVER,
      }),
    ]);
    expectNoTokens(sandbox, gateway);
    await expectListedUntilForgotten(sandbox, gateway, clock, old?.connectionId ?? "");
  });

  it("records the old connection when a reinstall replaces one whose local token was lost", async () => {
    const { sandbox, clock, gateway } = setup(["cursor-agent"]);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const old = gateway.issued[0];
    write(join(sandbox.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));

    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    const { state } = stateOf(sandbox);
    expect(state.harnesses.cursor?.connectionId).toBe(gateway.issued[1]?.connectionId);
    expect(state.unrevoked).toEqual([
      expect.objectContaining({
        harness: "cursor",
        connectionId: old?.connectionId,
        server: SERVER,
      }),
    ]);
    expectNoTokens(sandbox, gateway);
    await expectListedUntilForgotten(sandbox, gateway, clock, old?.connectionId ?? "");
    // The new connection was revoked by the uninstall that listed the old one.
    expect(gateway.revoked).toEqual([gateway.issued[1]?.token]);
  });

  it("records a new connection whose configuration write failed and whose cleanup DELETE failed", async () => {
    const { sandbox, clock, gateway } = setup(["claude"]);
    gateway.deleteStatusAll = 503;
    const h = makeContext(sandbox, { gateway, clock, env: { FAKE_CLAUDE_FAIL: "1" } });
    expect(await h.run(["install", "--yes"])).toBe(1);
    const issued = gateway.issued[0];
    const { state } = stateOf(sandbox);
    expect(state.unrevoked).toEqual([
      expect.objectContaining({
        harness: "claude-code",
        connectionId: issued?.connectionId,
        server: SERVER,
      }),
    ]);
    expect(state.harnesses["claude-code"]?.connectionId).toBeUndefined();
    expectNoTokens(sandbox, gateway);
    gateway.deleteStatusAll = undefined;
    await expectListedUntilForgotten(sandbox, gateway, clock, issued?.connectionId ?? "");
  });

  it("records nothing when every replaced connection is revoked", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--server", "https://other.example"])).toBe(0);
    expect(stateOf(sandbox).state.unrevoked ?? []).toEqual([]);
  });
});

describe("recovery records stay until the person forgets them", () => {
  async function withUnrevoked() {
    const { sandbox, clock, gateway } = setup(["codex", "claude"]);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const old = gateway.issued.find((i) => i.harness === "codex");
    gateway.deleteStatus.set(old?.token ?? "", 503);
    expect(
      await makeContext(sandbox, { gateway, clock }).run([
        "install",
        "--yes",
        "--server",
        "https://other.example",
      ]),
    ).toBe(1);
    gateway.deleteStatus.clear();
    return { sandbox, clock, gateway, connectionId: old?.connectionId ?? "" };
  }

  it("agentdesk forget removes one record and keeps the installation", async () => {
    const { sandbox, clock, gateway, connectionId } = await withUnrevoked();
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["forget", connectionId])).toBe(0);
    expect(h.out.join("\n")).toContain(`Forgot connection ${connectionId}`);
    const { state } = stateOf(sandbox);
    expect(state.unrevoked).toBeUndefined();
    expect(Object.keys(state.harnesses).sort()).toEqual(["claude-code", "codex"]);
    const status = makeContext(sandbox, { gateway, clock });
    expect(await status.run(["status"])).toBe(0);
    expect(status.output()).not.toContain(connectionId);
  });

  it("agentdesk forget refuses an id that is not recorded and a missing id", async () => {
    const { sandbox, clock, gateway } = await withUnrevoked();
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["forget", "conn_nope"])).toBe(1);
    expect(h.err.join("\n")).toContain("No unrevoked connection conn_nope is recorded");
    expect(await h.run(["forget"])).toBe(2);
    expect(stateOf(sandbox).state.unrevoked).toHaveLength(1);
  });

  it("a later install that resolves nothing keeps the record, reminds the person, and exits 0", async () => {
    const { sandbox, clock, gateway, connectionId } = await withUnrevoked();
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(0);
    expect(h.err.join("\n")).toContain(`connection ${connectionId} at ${SERVER} is not revoked`);
    expect(stateOf(sandbox).state.unrevoked?.map((u) => u.connectionId)).toEqual([connectionId]);
  });

  it("skill install keeps the records", async () => {
    const { sandbox, clock, gateway, connectionId } = await withUnrevoked();
    expect(await makeContext(sandbox, { gateway, clock }).run(["skill", "install"])).toBe(0);
    expect(stateOf(sandbox).state.unrevoked?.map((u) => u.connectionId)).toEqual([connectionId]);
  });

  it("status lists the records after an uninstall that removed everything else", async () => {
    const { sandbox, clock, gateway, connectionId } = await withUnrevoked();
    expect(await makeContext(sandbox, { gateway, clock }).run(["uninstall"])).toBe(1);
    const { state } = stateOf(sandbox);
    expect(state.harnesses).toEqual({});
    const status = makeContext(sandbox, { gateway, clock });
    expect(await status.run(["status"])).toBe(0);
    expect(status.output()).toContain(connectionId);
    expect(status.output()).not.toContain("not installed");
  });

  it("records connections from a rejected sign-in result that cannot be revoked", async () => {
    const { sandbox, clock, gateway } = setup(["codex", "cursor-agent"]);
    gateway.approvedOverride = [
      { harness: "codex", connection_id: "conn_a", token: "adc_rejected0000000000000000000000000" },
      { harness: "codex", connection_id: "conn_b", token: "adc_rejected1111111111111111111111111" },
    ];
    gateway.deleteStatusAll = 503;
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(h.err.join("\n")).toContain("returned an invalid sign-in result");
    const { state, file } = stateOf(sandbox);
    expect(state.unrevoked?.map((u) => u.connectionId)).toEqual(["conn_a", "conn_b"]);
    expect(read(file)).not.toContain("adc_rejected");
    expect(h.output()).not.toContain("adc_rejected");
  });

  it("revokes connections from a rejected sign-in result when it can, and records none", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    gateway.approvedOverride = [
      {
        harness: "vscode",
        connection_id: "conn_c",
        token: "adc_rejected2222222222222222222222222",
      },
    ];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes"])).toBe(1);
    expect(gateway.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(existsSync(join(sandbox.home, ".config", "agentdesk", "state.json"))).toBe(false);
  });

  it("refuses a state file whose records it cannot read instead of dropping them", async () => {
    const { sandbox, clock, gateway } = await withUnrevoked();
    const { file, state } = stateOf(sandbox);
    write(file, JSON.stringify({ ...state, unrevoked: [{ harness: "codex", server: SERVER }] }));
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["uninstall", "--forget-unrevoked"])).toBe(1);
    expect(h.err.join("\n")).toContain("unreadable unrevoked connection");
    write(
      file,
      JSON.stringify({
        ...state,
        harnesses: { ...state.harnesses, vscode: { connectionId: "x" } },
      }),
    );
    expect(await h.run(["status"])).toBe(1);
    expect(h.err.join("\n")).toContain("cannot read");
    write(
      file,
      JSON.stringify({ ...state, harnesses: { ...state.harnesses, codex: { connectionId: 42 } } }),
    );
    expect(await h.run(["uninstall"])).toBe(1);
    expect(h.err.join("\n")).toContain("unreadable connectionId for codex");
  });
});
