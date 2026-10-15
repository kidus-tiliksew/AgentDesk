import { existsSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RETRY_DELAY_MS,
  resumeMessage,
  resumes,
  type SettledDecision,
  WAIT_TIMEOUT_SECONDS,
} from "../../src/resume/waiter.js";
import { allFiles, cleanupSandboxes, mode, SERVER, write } from "../helpers.js";
import {
  decision,
  installSandbox,
  malformedDecisions,
  pump,
  resumeContext,
  resumeRoot,
  stubCodex,
  TOKENS,
} from "./helpers.js";

// component-resume §Waiter, §Resume message, and §Claims, against a fake
// `POST /device/wait` gateway (component-gateway §Waiter endpoint) on a fake
// clock.

afterEach(cleanupSandboxes);

const ID = "dec_1";
const MESSAGE = `AgentDesk decision ${ID} settled. Read it with check, tell the user the answer and where it was given, then act on it.`;

describe("the resume rule (DEC-15(6))", () => {
  const base = { id: ID, answered_via: null, applied_by_default: false };
  it.each([
    ["answered in the app", { state: "answered", answered_via: "app" }, true],
    ["answered from a notification", { state: "answered", answered_via: "notification" }, true],
    ["answered through the API", { state: "answered", answered_via: "api" }, true],
    ["answered by default", { state: "answered", answered_via: "default" }, true],
    ["answered in chat", { state: "answered", answered_via: "chat" }, false],
    ["expired with the default applied", { state: "expired", applied_by_default: true }, true],
    ["expired without a default", { state: "expired", applied_by_default: false }, false],
    ["cancelled", { state: "cancelled" }, false],
    ["pending", { state: "pending" }, false],
    ["answered with no recorded surface", { state: "answered", answered_via: null }, false],
  ])("%s resumes: %s", (_label, fields, expected) => {
    expect(resumes({ ...base, ...fields } as SettledDecision)).toBe(expected);
  });

  it("the message names only the decision", () => {
    expect(resumeMessage(ID)).toBe(MESSAGE);
  });
});

describe("agentdesk wait", () => {
  it.each([
    ["app", { state: "answered", answered_via: "app" }],
    ["notification", { state: "answered", answered_via: "notification" }],
    ["api", { state: "answered", answered_via: "api" }],
    ["default expiry", { state: "expired", answered_via: "default", applied_by_default: true }],
  ])("prints the resume message once for a settlement from %s", async (_label, fields) => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, fields) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(0);
    expect(h.out).toEqual([MESSAGE]);
    expect(h.err).toEqual([]);
    expect(existsSync(join(resumeRoot(sandbox), "claims", ID))).toBe(true);
  });

  it.each([
    ["a chat answer", { state: "answered", answered_via: "chat", chat_message: "yes" }],
    ["a cancel", { state: "cancelled", answer: null, answered_via: null }],
    ["an expiry with no default", { state: "expired", answer: null, answered_via: null }],
  ])("exits 0 with no output and no claim for %s", async (_label, fields) => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, fields) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(0);
    expect(h.output()).toBe("");
    expect(existsSync(join(resumeRoot(sandbox), "claims", ID))).toBe(false);
  });

  it("calls POST /device/wait with the harness token and timeout_seconds 600, repeating pending answers", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, ["pending", "pending", { decision: decision(ID, {}) }]);
    const { value, elapsed } = await pump(h.clock, h.run(["wait", "--harness", "codex", ID]), {
      stepMs: 10_000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual([MESSAGE]);
    const requests = h.waits.requests;
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({
        method: "POST",
        path: "/device/wait",
        body: { decision_id: ID, timeout_seconds: WAIT_TIMEOUT_SECONDS },
        authorization: `Bearer ${TOKENS.codex}`,
        accept: "text/event-stream",
      });
    }
    // Each pending answer came at the gateway's limit, and the next call
    // followed at once.
    expect(requests.map((r) => r.at)).toEqual([0, 600_000, 1_200_000]);
    expect(elapsed).toBe(1_200_000);
    // The waiter never opens an MCP session (DEC-15(2); AC-12.7).
    expect(h.waits.requests.some((r) => r.path === "/mcp")).toBe(false);
  });

  it("uses the server recorded for the harness", async () => {
    const sandbox = installSandbox(["cursor"], "https://agentdesk.test/prefix");
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, {}) }]);
    await pump(h.clock, h.run(["wait", "--harness", "cursor", ID]));
    expect(h.waits.requests[0]?.path).toBe("/prefix/device/wait");
    expect(h.waits.requests[0]?.authorization).toBe(`Bearer ${TOKENS.cursor}`);
  });

  it.each([
    ["a network failure", "network" as const],
    ["a 5xx answer", { status: 503 }],
    ["a 500 answer", { status: 500 }],
    ["a stream that ends without its event", "truncated" as const],
    ["an unavailable event", "unavailable" as const],
  ])("retries after 15 seconds on %s", async (_label, step) => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [step, step, { decision: decision(ID, {}) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(0);
    expect(h.out).toEqual([MESSAGE]);
    expect(h.waits.requests.map((r) => r.at)).toEqual([0, RETRY_DELAY_MS, 2 * RETRY_DELAY_MS]);
  });

  it("parses an event stream split into small chunks with CRLF line endings", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.chunkSize = 3;
    h.waits.lineEnding = "\r\n";
    h.waits.script(ID, ["pending", { decision: decision(ID, { title: "Déployer ☕" }) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]), {
      stepMs: 60_000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual([MESSAGE]);
  });

  it("abandons a request that stays open past its bound and retries it", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, ["hang", { decision: decision(ID, {}) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]), {
      stepMs: 5000,
    });
    expect(value).toBe(0);
    expect(h.out).toEqual([MESSAGE]);
    expect(h.waits.aborted).toBe(1);
    const [first, second] = h.waits.requests;
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBe(660_000 + RETRY_DELAY_MS);
  });

  it("prints that the connection was revoked and exits 1 on a 401, without the token", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ status: 401 }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "codex", ID]));
    expect(value).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("connection for Codex was revoked");
    expect(h.output()).not.toContain(TOKENS.codex);
    expect(h.waits.requests).toHaveLength(1);
  });

  it("exits 0 with no output on not_found", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, ["not_found"]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(0);
    expect(h.output()).toBe("");
    expect(h.waits.requests).toHaveLength(1);
  });

  it.each([
    ["a 400 answer", { status: 400 }],
    ["an unreadable event", "garbage" as const],
    ["another error event", { errorCode: "invalid" }],
  ])("stops with status 1 and no resume on %s", async (_label, step) => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [step]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toMatch(/^agentdesk wait stopped: /);
    expect(existsSync(join(resumeRoot(sandbox), "claims", ID))).toBe(false);
  });

  it.each(malformedDecisions(ID))(
    "stops with status 1, no claim, and no resume for a decision with %s",
    async (_label, malformed) => {
      const sandbox = installSandbox();
      const log = stubCodex(sandbox, 0);
      for (const thread of [undefined, "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b"]) {
        const h = resumeContext(sandbox);
        h.waits.script(ID, [{ decision: malformed }]);
        const argv = [
          "wait",
          "--harness",
          "codex",
          ...(thread ? ["--codex-thread", thread] : []),
          ID,
        ];
        const { value } = await pump(h.clock, h.run(argv));
        expect(value).toBe(1);
        expect(h.out).toEqual([]);
        expect(h.err).toEqual([
          "agentdesk wait stopped: the server sent a decision the waiter cannot read.",
        ]);
        expect(h.waits.requests).toHaveLength(1);
      }
      expect(existsSync(join(resumeRoot(sandbox), "claims", ID))).toBe(false);
      expect(existsSync(log)).toBe(false);
    },
  );

  it("exits 0 with no claim and no resume for an answer with no recorded surface", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, { answered_via: null }) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(0);
    expect(h.output()).toBe("");
    expect(existsSync(join(resumeRoot(sandbox), "claims", ID))).toBe(false);
  });

  it("refuses a malformed pending decision instead of waiting on it", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, { state: "pending", answered_via: 3 }) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(1);
    expect(h.waits.requests).toHaveLength(1);
  });

  it("refuses a decision answered for another id", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision("dec_other", {}) }]);
    const { value } = await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(value).toBe(1);
    expect(h.out).toEqual([]);
  });

  it("fails without a request when the harness is not installed or has no token", async () => {
    const notInstalled = installSandbox(["cursor"]);
    rmSync(join(notInstalled.home, ".config", "agentdesk", "state.json"));
    const a = resumeContext(notInstalled);
    expect(await a.run(["wait", "--harness", "cursor", ID])).toBe(1);
    expect(a.err.join("\n")).toContain("AgentDesk is not installed for Cursor");
    expect(a.waits.requests).toHaveLength(0);

    const noToken = installSandbox(["cursor"]);
    write(
      join(noToken.home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { agentdesk: { url: `${SERVER}/mcp` } } }),
    );
    const b = resumeContext(noToken);
    expect(await b.run(["wait", "--harness", "cursor", ID])).toBe(1);
    expect(b.err.join("\n")).toContain("Cursor has no AgentDesk connection");
    expect(b.waits.requests).toHaveLength(0);
  });

  it("leaves the harness configuration and state unchanged", async () => {
    const sandbox = installSandbox();
    const files = [
      join(sandbox.home, ".codex", "config.toml"),
      join(sandbox.home, ".config", "agentdesk", "state.json"),
    ];
    const before = files.map((f) => readFileSync(f, "utf8"));
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, {}) }]);
    await pump(h.clock, h.run(["wait", "--harness", "codex", ID]));
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
  });
});

describe("Codex delivery (DEC-15(4))", () => {
  const THREAD = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";

  it("runs codex queue --thread <thread> --message <message> and keeps its output private", async () => {
    const sandbox = installSandbox();
    const log = stubCodex(sandbox, 0);
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, { answer: { value: "secret answer" } }) }]);
    const { value } = await pump(
      h.clock,
      h.run(["wait", "--harness", "codex", "--codex-thread", THREAD, ID]),
    );
    expect(value).toBe(0);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(calls).toEqual([["queue", "--thread", THREAD, "--message", MESSAGE]]);
    // The message never carries the answer (DEC-15(7)).
    expect(JSON.stringify(calls)).not.toContain("secret answer");
    expect(JSON.stringify(calls)).not.toContain(TOKENS.codex);
    expect(h.output()).toBe("");
  });

  it("exits with codex queue's status and does not queue twice", async () => {
    const sandbox = installSandbox();
    const log = stubCodex(sandbox, 7);
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, {}) }]);
    const { value } = await pump(
      h.clock,
      h.run(["wait", "--harness", "codex", "--codex-thread", THREAD, ID]),
    );
    expect(value).toBe(7);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(h.output()).toBe("");
  });

  it("exits 1 when codex cannot be started", async () => {
    const sandbox = installSandbox();
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, {}) }]);
    const { value } = await pump(
      h.clock,
      h.run(["wait", "--harness", "codex", "--codex-thread", THREAD, ID]),
    );
    expect(value).toBe(1);
    expect(h.err).toEqual(["codex queue could not be started."]);
  });
});

describe("claims (§Claims; AC-12.4)", () => {
  it("two waiters racing on one decision resume once", async () => {
    const sandbox = installSandbox();
    const a = resumeContext(sandbox);
    const b = resumeContext(sandbox);
    a.waits.script(ID, ["pending", { decision: decision(ID, {}) }]);
    b.waits.script(ID, ["pending", { decision: decision(ID, {}) }]);
    const [ra, rb] = await Promise.all([
      pump(a.clock, a.run(["wait", "--harness", "claude-code", ID]), { stepMs: 60_000 }),
      pump(b.clock, b.run(["wait", "--harness", "claude-code", ID]), { stepMs: 60_000 }),
    ]);
    expect([ra.value, rb.value]).toEqual([0, 0]);
    expect([...a.out, ...b.out]).toEqual([MESSAGE]);
    expect([...a.err, ...b.err]).toEqual([]);
  });

  it("a waiter that finds the claim taken exits 0 with no output", async () => {
    const sandbox = installSandbox();
    const first = resumeContext(sandbox);
    first.waits.script(ID, [{ decision: decision(ID, {}) }]);
    await pump(first.clock, first.run(["wait", "--harness", "claude-code", ID]));
    const second = resumeContext(sandbox);
    second.waits.script(ID, [{ decision: decision(ID, {}) }]);
    const { value } = await pump(
      second.clock,
      second.run(["wait", "--harness", "claude-code", ID]),
    );
    expect(value).toBe(0);
    expect(second.output()).toBe("");
  });

  it("uses 0700 directories and 0600 files under XDG_CONFIG_HOME and holds no token", async () => {
    const sandbox = installSandbox();
    const xdg = join(sandbox.root, "xdg");
    // The installer's state lives under XDG_CONFIG_HOME too.
    write(
      join(xdg, "agentdesk", "state.json"),
      readFileSync(join(sandbox.home, ".config", "agentdesk", "state.json"), "utf8"),
    );
    sandbox.env.XDG_CONFIG_HOME = xdg;
    const h = resumeContext(sandbox);
    h.waits.script(ID, [{ decision: decision(ID, {}) }]);
    await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    const root = join(xdg, "agentdesk", "resume");
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, "claims"))).toBe(0o700);
    expect(mode(join(root, "claims", ID))).toBe(0o600);
    expect(existsSync(resumeRoot(sandbox))).toBe(false);
    for (const file of allFiles(root)) {
      expect(readFileSync(file, "utf8")).not.toContain(TOKENS["claude-code"]);
    }
  });

  it("each waiter run deletes claims older than 30 days and keeps newer ones", async () => {
    const sandbox = installSandbox();
    const now = Date.now();
    const claims = join(resumeRoot(sandbox), "claims");
    write(join(claims, "dec_old"), "");
    write(join(claims, "dec_recent"), "");
    const day = 24 * 60 * 60;
    utimesSync(join(claims, "dec_old"), now / 1000 - 31 * day, now / 1000 - 31 * day);
    utimesSync(join(claims, "dec_recent"), now / 1000 - 29 * day, now / 1000 - 29 * day);
    const h = resumeContext(sandbox, { now });
    h.waits.script(ID, ["not_found"]);
    await pump(h.clock, h.run(["wait", "--harness", "claude-code", ID]));
    expect(readdirSync(claims).sort()).toEqual(["dec_recent"]);
  });
});
