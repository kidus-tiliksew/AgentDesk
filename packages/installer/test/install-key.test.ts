import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENROLL_REFUSALS,
  KEY_FILE_UNREADABLE,
  KEY_MALFORMED,
  KEY_STDIN_UNREADABLE,
  MAX_KEY_INPUT_LENGTH,
  readStream,
} from "../src/install-key.js";
import { CODE_INSTRUCTION } from "../src/signin.js";
import { statePath } from "../src/state.js";
import {
  allFiles,
  cleanupSandboxes,
  type EnrollStep,
  FakeClock,
  FakeGateway,
  type Harnessed,
  HOSTNAME,
  makeContext,
  makeSandbox,
  read,
  readJson,
  type Sandbox,
  SERVER,
  stubExecutable,
  write,
} from "./helpers.js";

// `agentdesk install --key-file` (overlay-install-keys §Installer;
// req-install-keys REQ-2, AC-2.1 to AC-2.4).

afterEach(cleanupSandboxes);

const KEY = "adk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const ALL = ["claude-code", "codex", "cursor"];

function withHarnesses(names = ["claude", "codex", "cursor-agent"]): Sandbox {
  const sandbox = makeSandbox();
  for (const name of names) stubExecutable(sandbox, name);
  return sandbox;
}

function setup(names?: string[]) {
  const sandbox = withHarnesses(names);
  const clock = new FakeClock();
  const gateway = new FakeGateway(clock);
  return { sandbox, clock, gateway };
}

/** Writes the key file outside the home directory, as a provider's secret mount would be. */
function keyFile(sandbox: Sandbox, content = `${KEY}\n`): string {
  const path = join(sandbox.root, "secrets", "agentdesk-install-key");
  write(path, content);
  return path;
}

/** Every file under `dir` with its content. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(allFiles(dir).map((file) => [file, read(file)]));
}

/**
 * The key, or its random part, appears in no output line and in no file the
 * run could have written: harness configurations, backups, hooks, skills,
 * state, recovery records, and the stub harnesses' argument log.
 */
function expectNoKey(h: Harnessed, sandbox: Sandbox, key = KEY): void {
  const secretPart = key.slice("adk_".length);
  expect(h.output()).not.toContain(secretPart);
  const source = join(sandbox.root, "secrets", "agentdesk-install-key");
  for (const file of allFiles(sandbox.root)) {
    if (file === source) continue;
    expect(read(file), file).not.toContain(secretPart);
  }
}

function tokensIn(sandbox: Sandbox): { claude?: string; codex: string; cursor?: string } {
  const claudeFile = join(sandbox.home, ".claude.json");
  const cursorFile = join(sandbox.home, ".cursor", "mcp.json");
  const header = (file: string) =>
    existsSync(file)
      ? (readJson(file).mcpServers as Record<string, { headers: Record<string, string> }>).agentdesk
          ?.headers.Authorization
      : undefined;
  const codexFile = join(sandbox.home, ".codex", "config.toml");
  return {
    claude: header(claudeFile),
    codex: existsSync(codexFile) ? read(codexFile) : "",
    cursor: header(cursorFile),
  };
}

function connectionIds(h: Harnessed): Record<string, string | undefined> {
  const harnesses = readJson(statePath(h.ctx)).harnesses as Record<
    string,
    { connectionId?: string }
  >;
  return Object.fromEntries(Object.entries(harnesses).map(([id, r]) => [id, r.connectionId]));
}

describe("--key-file input", () => {
  it("enrolls every selected harness with one request and shows no code (AC-2.1, AC-2.4)", async () => {
    const { sandbox, clock, gateway } = setup();
    const h = makeContext(sandbox, { gateway, clock, answers: [] });
    const path = keyFile(sandbox, `\n  ${KEY}  \n\n`);
    expect(await h.run(["install", "--yes", "--key-file", path])).toBe(0);

    const enrolls = gateway.enrollRequests();
    expect(enrolls).toHaveLength(1);
    expect(enrolls[0]?.url).toBe(`${SERVER}/device/enroll`);
    expect(enrolls[0]?.body).toEqual({ install_key: KEY, machine_name: HOSTNAME, harnesses: ALL });
    expect(gateway.requests.map((r) => r.path)).toEqual(["/device/enroll"]);
    expect(h.prompts).toEqual([]);
    expect(h.out).not.toContain(CODE_INSTRUCTION);
    expect(h.output()).not.toMatch(/Waiting for approval|enter this code/);
    expect(h.out).toContain("Connecting Claude Code, Codex, Cursor with the install key.");

    // Each harness has its own connection and token (AC-2.1).
    const issued = gateway.issued;
    expect(new Set(issued.map((i) => i.token)).size).toBe(3);
    const tokens = tokensIn(sandbox);
    expect(tokens.claude).toBe(`Bearer ${gateway.tokenFor("claude-code")}`);
    expect(tokens.codex).toContain(`"Bearer ${gateway.tokenFor("codex")}"`);
    expect(tokens.cursor).toBe(`Bearer ${gateway.tokenFor("cursor")}`);
    expect(connectionIds(h)).toEqual({
      "claude-code": issued[0]?.connectionId,
      codex: issued[1]?.connectionId,
      cursor: issued[2]?.connectionId,
    });
    // The rest of the pipeline runs as for a short-code sign-in.
    expect(existsSync(join(sandbox.home, ".claude", "skills", "agentdesk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sandbox.home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(sandbox.home, ".cursor", "hooks.json"))).toBe(true);
    expect(h.err).toEqual([]);
    expectNoKey(h, sandbox);
  });

  it("reads the key from standard input for -, and never prompts on it", async () => {
    const { sandbox, clock, gateway } = setup();
    // The context is interactive: a prompt would take the next answer.
    const h = makeContext(sandbox, { gateway, clock, answers: ["2"], stdin: `${KEY}\r\n` });
    expect(await h.run(["install", "--key-file", "-"])).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(gateway.enrollRequests()[0]?.body).toEqual({
      install_key: KEY,
      machine_name: HOSTNAME,
      harnesses: ALL,
    });
    expect(h.out).toContain(
      "No terminal is attached, so every detected harness is selected. Use --only to choose.",
    );
    expectNoKey(h, sandbox);
  });

  it("keeps the selection prompt when the key comes from a file", async () => {
    const { sandbox, clock, gateway } = setup();
    const h = makeContext(sandbox, { gateway, clock, answers: ["2"] });
    expect(await h.run(["install", "--key-file", keyFile(sandbox)])).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(gateway.enrollRequests()[0]?.body).toMatchObject({
      harnesses: ["claude-code", "cursor"],
    });
    expect(existsSync(join(sandbox.home, ".codex", "config.toml"))).toBe(false);
  });

  it("passes --only and --server through to the enrollment", async () => {
    const { sandbox, clock, gateway } = setup();
    const h = makeContext(sandbox, { gateway, clock });
    expect(
      await h.run([
        "install",
        "--only",
        "codex",
        "--server",
        "https://other.example/",
        "--key-file",
        keyFile(sandbox),
      ]),
    ).toBe(0);
    expect(gateway.enrollRequests()[0]?.url).toBe("https://other.example/device/enroll");
    expect(gateway.enrollRequests()[0]?.body).toMatchObject({ harnesses: ["codex"] });
  });

  const refusals: {
    name: string;
    content?: string;
    path?: (s: Sandbox) => string;
    message: string;
  }[] = [
    { name: "a missing file", path: (s) => join(s.root, "missing"), message: KEY_FILE_UNREADABLE },
    { name: "a directory", path: (s) => s.root, message: KEY_FILE_UNREADABLE },
    // A key passed where the path belongs is never echoed.
    { name: "the key given as the path", path: () => KEY, message: KEY_FILE_UNREADABLE },
    { name: "an empty path", path: () => "", message: KEY_FILE_UNREADABLE },
    { name: "an empty file", content: "", message: KEY_MALFORMED },
    { name: "only whitespace", content: " \n\t\n", message: KEY_MALFORMED },
    { name: "a truncated key", content: KEY.slice(0, -1), message: KEY_MALFORMED },
    { name: "a key with one extra character", content: `${KEY}a`, message: KEY_MALFORMED },
    { name: "a connection token prefix", content: `adc_${KEY.slice(4)}`, message: KEY_MALFORMED },
    { name: "an uppercase prefix", content: `ADK_${KEY.slice(4)}`, message: KEY_MALFORMED },
    { name: "a padding character", content: `${KEY.slice(0, -1)}=`, message: KEY_MALFORMED },
    {
      name: "whitespace inside the key",
      content: `${KEY.slice(0, 20)} ${KEY.slice(20)}`,
      message: KEY_MALFORMED,
    },
    { name: "two keys on two lines", content: `${KEY}\n${KEY}\n`, message: KEY_MALFORMED },
    { name: "a variable assignment", content: `AGENTDESK_KEY=${KEY}`, message: KEY_MALFORMED },
    // A device that never ends is read only up to the limit.
    { name: "an endless device", path: () => "/dev/zero", message: KEY_MALFORMED },
    {
      name: "an oversized file",
      content: KEY.repeat(MAX_KEY_INPUT_LENGTH),
      message: KEY_MALFORMED,
    },
  ];

  it.each(refusals)(
    "refuses $name with status 1 before any output or request, with harnesses already connected",
    async ({ content, path, message }) => {
      const { sandbox, clock, gateway } = setup();
      expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
      gateway.requests = [];
      const before = snapshot(sandbox.home);

      const h = makeContext(sandbox, { gateway, clock, answers: [] });
      const file = path ? path(sandbox) : keyFile(sandbox, content);
      expect(await h.run(["install", "--key-file", file])).toBe(1);
      expect(h.err).toEqual([message]);
      expect(h.out).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(gateway.requests).toEqual([]);
      expect(snapshot(sandbox.home)).toEqual(before);
      expectNoKey(h, sandbox);
    },
  );

  it.each([
    { name: "no standard input reader", stdin: undefined, message: KEY_STDIN_UNREADABLE },
    {
      name: "a read error carrying the key",
      stdin: new Error(`EIO ${KEY}`),
      message: KEY_STDIN_UNREADABLE,
    },
    { name: "a malformed key", stdin: `${KEY.slice(0, 30)}\n`, message: KEY_MALFORMED },
  ])("refuses standard input with $name before any request", async ({ stdin, message }) => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    const h = makeContext(sandbox, { gateway, clock, ...(stdin !== undefined ? { stdin } : {}) });
    expect(await h.run(["install", "--yes", "--key-file", "-"])).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.out).toEqual([]);
    expect(gateway.requests).toEqual([]);
    expect(allFiles(sandbox.home)).toEqual([]);
    expectNoKey(h, sandbox);
  });

  it("keeps status 2 for --key-file without a value", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--key-file"])).toBe(2);
    expect(h.err.join("\n")).toContain("Usage: agentdesk");
    expect(gateway.requests).toEqual([]);
  });

  it("lists --key-file in the help", async () => {
    const h = makeContext(makeSandbox());
    expect(await h.run(["--help"])).toBe(0);
    const help = h.out.join("\n");
    expect(help).toContain(
      "install [--server <url>] [--only <harnesses>] [--yes] [--key-file <path>]",
    );
    expect(help).toContain("--key-file <path>  Connect with the install key in this file");
    expect(help).toContain("Use - to read\n                     the key from standard input.");
  });
});

describe("enrollment answers (AC-2.2)", () => {
  const statuses: { step: EnrollStep; message: string }[] = [
    { step: "unknown", message: ENROLL_REFUSALS.unknown },
    { step: "revoked", message: ENROLL_REFUSALS.revoked },
    { step: "expired", message: ENROLL_REFUSALS.expired },
    { step: "limit_reached", message: ENROLL_REFUSALS.limit_reached },
    {
      step: { status: "harness_not_allowed", harness: "codex" },
      message:
        "This install key does not allow Codex. Leave it out with --only. Nothing was connected.",
    },
    // A harness the run did not request, or one that is not a harness id, is not named.
    {
      step: { status: "harness_not_allowed", harness: "cursor" },
      message: ENROLL_REFUSALS.harness_not_allowed,
    },
    {
      step: { status: "harness_not_allowed", harness: KEY },
      message: ENROLL_REFUSALS.harness_not_allowed,
    },
    { step: { status: "harness_not_allowed" }, message: ENROLL_REFUSALS.harness_not_allowed },
  ];

  it.each(statuses)(
    "refuses $step with its message, status 1, and nothing connected",
    async ({ step, message }) => {
      const { sandbox, clock, gateway } = setup(["claude", "codex"]);
      gateway.enrollScript = [step];
      const h = makeContext(sandbox, { gateway, clock });
      expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
      expect(h.err).toEqual([message]);
      expect(gateway.enrollRequests()).toHaveLength(1);
      expect(gateway.requests.map((r) => r.path)).toEqual(["/device/enroll"]);
      expect(allFiles(sandbox.home)).toEqual([]);
      expectNoKey(h, sandbox);
    },
  );

  it("leaves a previous installation unchanged when the key is refused", async () => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    gateway.refused.add(gateway.tokenFor("codex"));
    const before = snapshot(sandbox.home);
    gateway.enrollScript = ["revoked"];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(h.err).toEqual([ENROLL_REFUSALS.revoked]);
    expect(gateway.enrollRequests()[0]?.body).toMatchObject({ harnesses: ["codex"] });
    expect(gateway.revoked).toEqual([]);
    expect(snapshot(sandbox.home)).toEqual(before);
  });

  it.each([
    { name: "an unexpected status", step: { raw: '{"status":"pending"}' } as EnrollStep },
    { name: "a body that is not JSON", step: { raw: "<html>adk_</html>" } as EnrollStep },
    { name: "a JSON array", step: { raw: "[]" } as EnrollStep },
    { name: "a body without a status", step: { raw: "{}" } as EnrollStep },
  ])("refuses $name without retrying", async ({ step }) => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    gateway.enrollScript = [step];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(h.err).toEqual([`AgentDesk at ${SERVER} returned an invalid enrollment status.`]);
    expect(gateway.enrollRequests()).toHaveLength(1);
    expect(allFiles(sandbox.home)).toEqual([]);
  });

  it.each([400, 401, 403, 404, 409, 413])(
    "refuses a %i answer at once without retrying",
    async (status) => {
      const { sandbox, clock, gateway } = setup(["codex"]);
      gateway.enrollScript = [status, "enrolled"];
      const h = makeContext(sandbox, { gateway, clock });
      expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
      expect(h.err).toEqual([
        `AgentDesk at ${SERVER} answered ${status} to the enrollment request. Nothing was connected.`,
      ]);
      expect(gateway.enrollRequests()).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
      expect(allFiles(sandbox.home)).toEqual([]);
    },
  );

  function issue(gateway: FakeGateway, harness: string, n: number, token?: string) {
    const issued = {
      harness,
      connectionId: `conn_override_${n}`,
      token: token ?? `adc_override${n}${"o".repeat(32)}`,
    };
    gateway.issued.push(issued);
    return { harness, connection_id: issued.connectionId, token: issued.token };
  }

  it("refuses a result missing a harness and revokes what it issued", async () => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    gateway.enrolledOverride = [issue(gateway, "claude-code", 1)];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(h.err).toEqual([`AgentDesk at ${SERVER} returned an invalid enrollment result.`]);
    expect(gateway.revoked).toEqual([gateway.issued[0]?.token]);
    expect(allFiles(sandbox.home)).toEqual([]);
    expect(h.output()).not.toContain(gateway.issued[0]?.token);
  });

  it.each([
    {
      name: "a shared token",
      connections: (g: FakeGateway) => [
        issue(g, "claude-code", 1, `adc_shared${"s".repeat(32)}`),
        { ...issue(g, "codex", 2), token: `adc_shared${"s".repeat(32)}` },
      ],
    },
    {
      name: "a shared connection id",
      connections: (g: FakeGateway) => [
        issue(g, "claude-code", 1),
        { ...issue(g, "codex", 2), connection_id: "conn_override_1" },
      ],
    },
    {
      name: "a duplicated harness",
      connections: (g: FakeGateway) => [issue(g, "codex", 1), issue(g, "codex", 2)],
    },
    {
      name: "a harness that was not requested",
      connections: (g: FakeGateway) => [issue(g, "claude-code", 1), issue(g, "cursor", 2)],
    },
    {
      name: "an extra connection",
      connections: (g: FakeGateway) => [
        issue(g, "claude-code", 1),
        issue(g, "codex", 2),
        issue(g, "cursor", 3),
      ],
    },
    {
      name: "a token with whitespace",
      connections: (g: FakeGateway) => [
        issue(g, "claude-code", 1),
        issue(g, "codex", 2, "adc_a b"),
      ],
    },
    { name: "connections that are not a list", connections: () => ({ codex: "x" }) },
  ])("refuses a result with $name and writes no configuration", async ({ connections }) => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    gateway.enrolledOverride = connections(gateway);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(h.err).toContain(`AgentDesk at ${SERVER} returned an invalid enrollment result.`);
    expect(existsSync(join(sandbox.home, ".claude.json"))).toBe(false);
    expect(existsSync(join(sandbox.home, ".codex", "config.toml"))).toBe(false);
    for (const issued of gateway.issued) expect(h.output()).not.toContain(issued.token);
    expectNoKey(h, sandbox);
  });

  it("keeps a recovery record when an issued connection of a refused result cannot be revoked", async () => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    gateway.enrolledOverride = [issue(gateway, "claude-code", 1)];
    gateway.deleteStatusAll = 503;
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    const state = readJson(statePath(h.ctx)) as { unrevoked: { connectionId: string }[] };
    expect(state.unrevoked).toEqual([
      expect.objectContaining({ harness: "claude-code", connectionId: "conn_override_1" }),
    ]);
    expect(read(statePath(h.ctx))).not.toContain("adc_");
    expect(h.err.join("\n")).toContain("agentdesk forget conn_override_1");
    expectNoKey(h, sandbox);
  });

  it("refuses a connection token equal to the install key and never sends or stores it", async () => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    gateway.enrolledOverride = [issue(gateway, "claude-code", 1), issue(gateway, "codex", 2, KEY)];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(h.err).toContain(`AgentDesk at ${SERVER} returned an invalid enrollment result.`);
    expect(h.err.join("\n")).toContain("(the server returned an invalid enrollment result)");
    // The other connection is revoked; the key is never presented as a token.
    expect(gateway.revoked).toEqual([gateway.issued[0]?.token]);
    expect(gateway.requests.some((r) => r.authorization?.includes(KEY))).toBe(false);
    const state = readJson(statePath(h.ctx)) as { unrevoked: { connectionId: string }[] };
    expect(state.unrevoked).toEqual([
      expect.objectContaining({ harness: "codex", connectionId: "conn_override_2" }),
    ]);
    expectNoKey(h, sandbox);
  });
});

describe("retries on the fake clock", () => {
  it("retries a network failure, 429, and 5xx every 2 seconds until enrolled", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    gateway.enrollScript = ["network", 503, 429, 500, 599, "enrolled"];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(0);
    expect(gateway.enrollRequests().map((r) => r.at)).toEqual([0, 2000, 4000, 6000, 8000, 10000]);
    expect(clock.sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(gateway.issued).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("stops at the 2-minute boundary and starts no attempt after it", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    gateway.enrollScript = [503];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    const times = gateway.enrollRequests().map((r) => r.at);
    expect(times).toHaveLength(60);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(118_000);
    expect(clock.now).toBe(120_000);
    expect(h.err).toEqual([
      `AgentDesk at ${SERVER} did not complete the enrollment within 2 minutes (the server answered 503). Run the installer again.`,
    ]);
    expect(allFiles(sandbox.home)).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("succeeds on the last attempt before the boundary", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    gateway.enrollScript = [...Array<EnrollStep>(59).fill(502), "enrolled"];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(0);
    expect(gateway.enrollRequests().at(-1)?.at).toBe(118_000);
  });

  it.each(["hang", "hang-body"] as const)(
    "aborts a request that does not answer (%s) after 30 seconds and retries it",
    async (step) => {
      const { sandbox, clock, gateway } = setup(["codex"]);
      gateway.enrollScript = [step, "enrolled"];
      const h = makeContext(sandbox, { gateway, clock });
      expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(0);
      expect(gateway.enrollRequests().map((r) => r.at)).toEqual([0, 32_000]);
      expect(gateway.enrollSignals[0]?.aborted).toBe(true);
      expect(clock.pendingTimers).toBe(0);
    },
  );

  it("gives up on requests that never answer within the 2 minutes", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    gateway.enrollScript = ["hang"];
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    // The last attempt is bounded by the time left, not by 30 seconds.
    expect(gateway.enrollRequests().map((r) => r.at)).toEqual([0, 32_000, 64_000, 96_000]);
    expect(h.err).toEqual([
      `AgentDesk at ${SERVER} did not complete the enrollment within 2 minutes (the request timed out). Run the installer again.`,
    ]);
    expect(gateway.enrollSignals.every((s) => s?.aborted)).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });

  it("gives up after network failures without printing the failure's text", async () => {
    const { sandbox, clock } = setup(["codex"]);
    const h = makeContext(sandbox, { clock });
    let calls = 0;
    h.ctx.fetch = async () => {
      calls++;
      throw new Error(`connect ECONNREFUSED while sending ${KEY}`);
    };
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(calls).toBe(60);
    expect(h.err).toEqual([
      `AgentDesk at ${SERVER} did not complete the enrollment within 2 minutes (could not reach ${SERVER}). Run the installer again.`,
    ]);
    expectNoKey(h, sandbox);
  });
});

describe("re-runs through the existing pipeline", () => {
  it("sends no enrollment when every selected harness is already connected", async () => {
    const { sandbox, clock, gateway } = setup();
    const path = keyFile(sandbox);
    expect(
      await makeContext(sandbox, { gateway, clock }).run(["install", "--yes", "--key-file", path]),
    ).toBe(0);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", path])).toBe(0);
    expect(gateway.enrollRequests()).toHaveLength(1);
    expect(h.out).toContain("Every selected harness is already connected. No sign-in is needed.");
    // The skill and hooks are refreshed as on every run (AC-9.4).
    expect(h.out).toContain(
      `Claude Code: skill 1.0.0 written to ${join(sandbox.home, ".claude", "skills", "agentdesk")}`,
    );
    expect(gateway.revoked).toEqual([]);
    expectNoKey(h, sandbox);
  });

  it("enrolls only the harness whose connection was refused and revokes the one it replaces", async () => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    const path = keyFile(sandbox);
    expect(
      await makeContext(sandbox, { gateway, clock }).run(["install", "--yes", "--key-file", path]),
    ).toBe(0);
    const oldCodex = gateway.tokenFor("codex");
    const oldClaude = gateway.tokenFor("claude-code");
    gateway.refused.add(oldCodex);
    const h = makeContext(sandbox, { gateway, clock });
    expect(await h.run(["install", "--yes", "--key-file", path])).toBe(0);
    expect(gateway.enrollRequests()[1]?.body).toEqual({
      install_key: KEY,
      machine_name: HOSTNAME,
      harnesses: ["codex"],
    });
    expect(h.out).toContain("Claude Code: connection works; keeping it.");
    expect(gateway.revoked).toEqual([oldCodex]);
    const tokens = tokensIn(sandbox);
    expect(tokens.claude).toBe(`Bearer ${oldClaude}`);
    expect(tokens.codex).toContain(`"Bearer ${gateway.tokenFor("codex")}"`);
    expect(gateway.tokenFor("codex")).not.toBe(oldCodex);
    expectNoKey(h, sandbox);
  });

  it("replaces short-code connections with enrolled ones after a --server change", async () => {
    const { sandbox, clock, gateway } = setup(["claude", "codex"]);
    expect(await makeContext(sandbox, { gateway, clock }).run(["install", "--yes"])).toBe(0);
    const old = gateway.issued.map((i) => i.token);
    const h = makeContext(sandbox, { gateway, clock });
    expect(
      await h.run([
        "install",
        "--yes",
        "--server",
        "https://other.example",
        "--key-file",
        keyFile(sandbox),
      ]),
    ).toBe(0);
    expect(gateway.enrollRequests()[0]?.url).toBe("https://other.example/device/enroll");
    expect(gateway.enrollRequests()[0]?.body).toMatchObject({
      harnesses: ["claude-code", "codex"],
    });
    expect([...gateway.revoked].sort()).toEqual([...old].sort());
    expect(readJson(statePath(h.ctx)).server).toBe("https://other.example");
    expectNoKey(h, sandbox);
  });

  it("revokes an enrolled connection whose configuration write failed", async () => {
    const { sandbox, clock, gateway } = setup(["claude"]);
    const h = makeContext(sandbox, { gateway, clock, env: { FAKE_CLAUDE_FAIL: "1" } });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(gateway.revoked).toEqual([gateway.tokenFor("claude-code")]);
    expect(h.err.join("\n")).toContain("Claude Code: its MCP entry in");
    expectNoKey(h, sandbox);
  });
});

describe("secrecy of the key (AC-2.3)", () => {
  it("keeps the key out of configurations, backups, state, and output, and each token in its own configuration", async () => {
    const { sandbox, clock, gateway } = setup(["codex", "cursor-agent"]);
    // Existing files, so the run makes backups before its edits.
    write(join(sandbox.home, ".codex", "config.toml"), 'model = "o4"\n');
    write(join(sandbox.home, ".cursor", "mcp.json"), '{"mcpServers":{"other":{"url":"x"}}}\n');
    write(join(sandbox.home, ".cursor", "hooks.json"), '{"version":1,"hooks":{}}\n');
    const h = makeContext(sandbox, { gateway, clock, stdin: `${KEY}\n` });
    expect(await h.run(["install", "--yes", "--key-file", "-"])).toBe(0);
    const files = allFiles(sandbox.home);
    expect(files.some((f) => f.endsWith(".agentdesk-backup"))).toBe(true);
    for (const issued of gateway.issued) {
      const holders = files.filter((f) => read(f).includes(issued.token));
      expect(holders).toEqual([
        issued.harness === "codex"
          ? join(sandbox.home, ".codex", "config.toml")
          : join(sandbox.home, ".cursor", "mcp.json"),
      ]);
    }
    expect(read(statePath(h.ctx))).not.toContain("adc_");
    expectNoKey(h, sandbox);
  });

  it("keeps the key out of output when an error body echoes it", async () => {
    const { sandbox, clock } = setup(["codex"]);
    const h = makeContext(sandbox, { clock });
    h.ctx.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "invalid", message: `bad key ${KEY}` } }), {
        status: 400,
      });
    expect(await h.run(["install", "--yes", "--key-file", keyFile(sandbox)])).toBe(1);
    expect(h.err).toEqual([
      `AgentDesk at ${SERVER} answered 400 to the enrollment request. Nothing was connected.`,
    ]);
    expectNoKey(h, sandbox);
  });

  it("redacts the key and the raw input from any later output line", async () => {
    const { sandbox, clock, gateway } = setup(["codex"]);
    const h = makeContext(sandbox, { gateway, clock, stdin: ` ${KEY}\n` });
    expect(await h.run(["install", "--yes", "--key-file", "-"])).toBe(0);
    expect(h.ctx.secrets.has(KEY)).toBe(true);
    expect(h.ctx.secrets.has(` ${KEY}\n`)).toBe(true);
    h.ctx.io.err(`echo ${KEY}`);
    expect(h.err.at(-1)).toBe("echo [redacted]");
  });
});

describe("readStream", () => {
  it("reads every chunk of the stream as UTF-8", async () => {
    const input = new PassThrough();
    const read = readStream(input);
    input.write(Buffer.from(KEY.slice(0, 10)));
    input.write(KEY.slice(10));
    input.end("\n");
    expect(await read).toBe(`${KEY}\n`);
  });

  it("rejects on a read error", async () => {
    const input = new PassThrough();
    const read = readStream(input);
    input.destroy(new Error("EIO"));
    await expect(read).rejects.toThrow("EIO");
  });

  it("stops reading once the input exceeds the limit", async () => {
    const input = new PassThrough();
    const read = readStream(input);
    input.write("a".repeat(MAX_KEY_INPUT_LENGTH + 1));
    const data = await read;
    expect(data.length).toBe(MAX_KEY_INPUT_LENGTH + 1);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });
});
