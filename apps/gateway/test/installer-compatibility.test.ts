import { describe, expect, it } from "vitest";
import type { Context } from "../../../packages/installer/src/context.js";
import { CODE_INSTRUCTION, signIn } from "../../../packages/installer/src/signin.js";
import { handle } from "../src/index.js";
import { env, fakeConvex, fakeLimiter } from "./fake.js";

// The installer's own sign-in code (component-installer §Sign-in) against this
// gateway's `/device/start` and `/device/poll`, with Convex faked. Each
// package's tests fake the other side, so only this test catches a wire
// format one side changes alone, such as the hyphenated `user_code` of review
// round 1.

const SERVER = "https://agentdesk.example";
const CODE = "K7Q2M9XD";
const SECRET = "s".repeat(43);
const CONNECTIONS = [
  { harness: "claude-code", connection_id: "cred_1", token: `adc_${"1".repeat(43)}` },
  { harness: "codex", connection_id: "cred_2", token: `adc_${"2".repeat(43)}` },
];

// One sign-in on the installer's side: a Context whose fetch goes through the
// gateway's `handle`, a clock that `sleep` advances, and recorded output.
// `rewrite` can alter a gateway response before the installer reads it.
function installerAgainstGateway(
  rewrite: (path: string, body: Record<string, unknown>) => Record<string, unknown> = (_p, b) => b,
) {
  let polls = 0;
  const convex = fakeConvex({
    "identity/device-start": () => ({ code: CODE, device_secret: SECRET, expires_at: 600_000 }),
    "identity/device-collect": () =>
      ++polls < 2 ? { status: "pending" } : { status: "approved", connections: CONNECTIONS },
  });
  const limited = { ...env, DEVICE_START_LIMIT: fakeLimiter().binding };
  const out: string[] = [];
  const paths: string[] = [];
  let now = 0;
  const ctx = {
    env: {},
    home: "/home/test",
    hostname: "devbox",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      // Cloudflare adds the client IP in front of the Worker.
      const request = new Request(input, init);
      request.headers.set("CF-Connecting-IP", "203.0.113.7");
      const path = new URL(request.url).pathname;
      paths.push(path);
      const response = await handle(request, limited, convex.svc);
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json(rewrite(path, body), {
        status: response.status,
        headers: response.headers,
      });
    },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    run: async () => {
      throw new Error("sign-in runs no command");
    },
    io: { out: (line: string) => out.push(line), err: (line: string) => out.push(line) },
    skill: { content: "", version: "0.0.0" },
    defaultServer: undefined,
    harnesses: [],
    secrets: new Set<string>(),
  } satisfies Context;
  return { ctx, convex, out, paths };
}

describe("the installer's sign-in against the gateway", () => {
  it("shows the code as XXXX-XXXX and returns one connection per harness", async () => {
    const { ctx, convex, out, paths } = installerAgainstGateway();

    const connections = await signIn(ctx, SERVER, ["claude-code", "codex"]);

    expect(connections).toEqual([
      { harness: "claude-code", connectionId: "cred_1", token: CONNECTIONS[0]?.token },
      { harness: "codex", connectionId: "cred_2", token: CONNECTIONS[1]?.token },
    ]);
    expect(out).toContain("  K7Q2-M9XD");
    expect(out).toContain(CODE_INSTRUCTION);
    expect(paths).toEqual(["/device/start", "/device/poll", "/device/poll"]);
    expect(convex.calls).toEqual([
      {
        route: "identity/device-start",
        body: { machine_name: "devbox", harnesses: ["claude-code", "codex"] },
      },
      { route: "identity/device-collect", body: { device_secret: SECRET } },
      { route: "identity/device-collect", body: { device_secret: SECRET } },
    ]);
  });

  it("is refused by the installer before polling when user_code carries a hyphen", async () => {
    const { ctx, paths } = installerAgainstGateway((path, body) =>
      path === "/device/start" ? { ...body, user_code: "K7Q2-M9XD" } : body,
    );

    await expect(signIn(ctx, SERVER, ["codex"])).rejects.toThrow(
      `AgentDesk at ${SERVER} returned an invalid sign-in request.`,
    );
    expect(paths).toEqual(["/device/start"]);
  });
});
