import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/auth.js";
import { ServiceError, UpstreamError } from "../src/convex.js";
import { handle } from "../src/index.js";
import { CREDENTIAL, env, fakeConvex, fakeLimiter, routeRequest, TOKEN, USER } from "./fake.js";

// component-gateway §Sign-in endpoints: the installer's short-code sign-in,
// connection check, and connection revoke, with Convex faked.

const IP = "203.0.113.7";
const SECRET = "s".repeat(43);
const CODE = "K7Q2M9XD";
const OTHER_TOKEN = `adc_${"b".repeat(43)}`;

function startRequest(body: unknown, headers: Record<string, string | null> = {}): Request {
  return routeRequest("POST", "/device/start", body, { "CF-Connecting-IP": IP, ...headers });
}

const START = { machine_name: "devbox", harnesses: ["claude-code", "codex"] };

const STARTED = { code: CODE, device_secret: SECRET, expires_at: 1_791_806_400_000 };

function startConvex() {
  return fakeConvex({ "identity/device-start": () => STARTED });
}

function withLimiter(limiter = fakeLimiter()) {
  return { ...env, DEVICE_START_LIMIT: limiter.binding };
}

function bearer(token: string | null): Record<string, string | null> {
  return { Authorization: token === null ? null : `Bearer ${token}` };
}

// Identity's credential table for one connection token: resolve-token refuses
// it once revoke-self has revoked it, as component-identity does.
async function connectionConvex(
  overrides: Parameters<typeof fakeConvex>[0] = {},
): Promise<ReturnType<typeof fakeConvex>> {
  const live = await hashToken(TOKEN);
  const revoked = new Set<string>();
  return fakeConvex({
    "identity/resolve-token": (body) => {
      if (body.token_hash !== live || revoked.has(live)) {
        throw new ServiceError("unauthenticated", "Invalid credential");
      }
      return {
        userId: USER,
        credentialId: CREDENTIAL,
        kind: "connection_token",
        harness: "codex",
        name: "Codex",
      };
    },
    "identity/revoke-self": (body) => {
      if (body.token_hash !== live || revoked.has(live)) {
        throw new ServiceError("unauthenticated", "Invalid credential");
      }
      revoked.add(live);
      return null;
    },
    ...overrides,
  });
}

describe("POST /device/start", () => {
  it("starts a request and returns identity's code without a hyphen", async () => {
    const convex = startConvex();

    const response = await handle(startRequest(START), withLimiter(), convex.svc);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      user_code: "K7Q2M9XD",
      device_secret: SECRET,
      interval: 2,
      expires_in: 600,
    });
    expect(convex.calls).toEqual([
      {
        route: "identity/device-start",
        body: { machine_name: "devbox", harnesses: ["claude-code", "codex"] },
      },
    ]);
  });

  it("trims the machine name and drops unknown fields", async () => {
    const convex = startConvex();

    await handle(
      startRequest({ machine_name: "  devbox  ", harnesses: ["cursor"], userId: "user_b" }),
      withLimiter(),
      convex.svc,
    );

    expect(convex.calls[0]?.body).toEqual({ machine_name: "devbox", harnesses: ["cursor"] });
  });

  it.each([
    ["malformed JSON", "{", undefined],
    ["a JSON array", [], undefined],
    ["JSON null", "null", undefined],
    ["a missing machine_name", { harnesses: ["codex"] }, "machine_name"],
    ["a blank machine_name", { machine_name: "   ", harnesses: ["codex"] }, "machine_name"],
    ["a non-string machine_name", { machine_name: 7, harnesses: ["codex"] }, "machine_name"],
    [
      "a machine_name over 255 characters",
      { machine_name: "m".repeat(256), harnesses: ["codex"] },
      "machine_name",
    ],
  ])("answers %s with 400 and calls nothing", async (_name, body, field) => {
    const convex = startConvex();

    const response = await handle(startRequest(body), withLimiter(), convex.svc);

    expect(response.status).toBe(400);
    const error = ((await response.json()) as { error: Record<string, unknown> }).error;
    expect(error.code).toBe("invalid");
    expect(error.field).toBe(field);
    expect(convex.calls).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["not a list", "codex"],
    ["empty", []],
    ["an unknown harness", ["claude-code", "vscode"]],
    ["a repeated harness", ["codex", "codex"]],
    ["a display name instead of an id", ["Claude Code"]],
    ["a non-string entry", [1]],
  ])("answers harnesses %s with 400 naming the field", async (_name, harnesses) => {
    const convex = startConvex();

    const response = await handle(
      startRequest({ machine_name: "devbox", harnesses }),
      withLimiter(),
      convex.svc,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid",
        message:
          "harnesses must be a non-empty list of distinct values from claude-code, codex, and cursor",
        field: "harnesses",
      },
    });
    expect(convex.calls).toEqual([]);
  });

  it("accepts every harness id once", async () => {
    const convex = startConvex();

    const response = await handle(
      startRequest({ machine_name: "devbox", harnesses: ["cursor", "codex", "claude-code"] }),
      withLimiter(),
      convex.svc,
    );

    expect(response.status).toBe(200);
    expect(convex.calls[0]?.body.harnesses).toEqual(["cursor", "codex", "claude-code"]);
  });

  it("answers the 11th start in a minute from one IP with 429 and calls nothing", async () => {
    let now = 0;
    const limiter = fakeLimiter(10, 60_000, () => now);
    const limited = withLimiter(limiter);
    const convex = startConvex();

    for (let i = 0; i < 10; i++) {
      now = i * 5_000;
      expect((await handle(startRequest(START), limited, convex.svc)).status).toBe(200);
    }
    now = 59_000;
    const response = await handle(startRequest(START), limited, convex.svc);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: { code: "rate_limited", message: "Too many sign-in requests; try again in a minute" },
    });
    expect(convex.calls).toHaveLength(10);
    expect(limiter.keys).toEqual(Array(11).fill(IP));

    const other = await handle(
      startRequest(START, { "CF-Connecting-IP": "198.51.100.4" }),
      limited,
      convex.svc,
    );
    expect(other.status).toBe(200);
    expect(convex.calls).toHaveLength(11);

    now = 60_000;
    expect((await handle(startRequest(START), limited, convex.svc)).status).toBe(200);
  });

  it("counts an invalid body against the limit", async () => {
    const limiter = fakeLimiter(1);
    const convex = startConvex();

    await handle(startRequest("{"), withLimiter(limiter), convex.svc);
    const response = await handle(startRequest(START), withLimiter(limiter), convex.svc);

    expect(response.status).toBe(429);
    expect(convex.calls).toEqual([]);
  });

  it("limits ten starts a minute per IP through the declared binding", async () => {
    const { DEVICE_START_LIMIT } = workerEnv as { DEVICE_START_LIMIT?: RateLimit };
    expect(DEVICE_START_LIMIT).toBeDefined();
    const limited = { ...env, DEVICE_START_LIMIT };
    const convex = startConvex();
    const ip = { "CF-Connecting-IP": "192.0.2.55" };

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await handle(startRequest(START, ip), limited, convex.svc)).status);
    }

    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    expect(convex.calls).toHaveLength(10);
  });

  it.each([
    ["no rate-limit binding", env, {}],
    ["no client IP", null, { "CF-Connecting-IP": null }],
  ])("refuses with 503 when there is %s", async (_name, configured, headers) => {
    const convex = startConvex();

    const response = await handle(
      startRequest(START, headers),
      configured ?? withLimiter(),
      convex.svc,
    );

    expect(response.status).toBe(503);
    expect(convex.calls).toEqual([]);
  });

  it.each([
    ["a code that is not 8 symbols", { ...STARTED, code: "K7Q2" }],
    ["a missing device secret", { code: CODE, expires_at: 1 }],
  ])("answers %s from identity with 503", async (_name, started) => {
    const convex = fakeConvex({ "identity/device-start": () => started });

    const response = await handle(startRequest(START), withLimiter(), convex.svc);

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(SECRET);
  });
});

describe("POST /device/poll", () => {
  function pollRequest(body: unknown = { device_secret: SECRET }): Request {
    return routeRequest("POST", "/device/poll", body);
  }

  it.each([["pending"], ["declined"], ["expired"], ["not_found"]])(
    "returns identity's %s status",
    async (status) => {
      const convex = fakeConvex({ "identity/device-collect": () => ({ status }) });

      const response = await handle(pollRequest(), env, convex.svc);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status });
      expect(convex.calls).toEqual([
        { route: "identity/device-collect", body: { device_secret: SECRET } },
      ]);
    },
  );

  it("returns one connection per harness once approved, then not_found", async () => {
    const connections = [
      { harness: "claude-code", connection_id: "cred_1", token: `adc_${"1".repeat(43)}` },
      { harness: "codex", connection_id: "cred_2", token: `adc_${"2".repeat(43)}` },
    ];
    // Identity consumes an approved request in the same mutation that mints
    // its tokens, so the next collect for the secret finds nothing.
    let consumed = false;
    const convex = fakeConvex({
      "identity/device-collect": () => {
        if (consumed) {
          return { status: "not_found" };
        }
        consumed = true;
        return { status: "approved", connections };
      },
    });

    const response = await handle(pollRequest(), env, convex.svc);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "approved", connections });

    const again = await handle(pollRequest(), env, convex.svc);
    expect(await again.json()).toEqual({ status: "not_found" });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a missing secret", {}],
    ["a short secret", { device_secret: "s".repeat(42) }],
    ["a secret outside base64url", { device_secret: `${"s".repeat(42)}+` }],
    ["a non-string secret", { device_secret: 43 }],
  ])("answers %s with 400 and calls nothing", async (_name, body) => {
    const convex = fakeConvex();

    const response = await handle(pollRequest(body), env, convex.svc);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid",
        message: "device_secret must be the secret from /device/start",
        field: "device_secret",
      },
    });
    expect(convex.calls).toEqual([]);
  });

  it.each([
    ["an unknown status", { status: "consumed" }],
    ["approved without connections", { status: "approved" }],
    ["approved with no connections", { status: "approved", connections: [] }],
    [
      "a connection for an unknown harness",
      {
        status: "approved",
        connections: [{ harness: "vscode", connection_id: "cred_1", token: TOKEN }],
      },
    ],
    [
      "a connection with an API token",
      {
        status: "approved",
        connections: [
          { harness: "codex", connection_id: "cred_1", token: `adp_${"a".repeat(43)}` },
        ],
      },
    ],
  ])("answers %s from identity with 503 and no token", async (_name, collected) => {
    const convex = fakeConvex({ "identity/device-collect": () => collected });

    const response = await handle(pollRequest(), env, convex.svc);

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(TOKEN);
  });
});

describe("GET /device/connection", () => {
  it("answers a live connection token with its connection id and harness", async () => {
    const convex = await connectionConvex();

    const response = await handle(
      routeRequest("GET", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: CREDENTIAL, harness: "codex" });
    expect(convex.calls).toEqual([
      { route: "identity/resolve-token", body: { token_hash: await hashToken(TOKEN) } },
    ]);
  });

  it.each([
    ["no Authorization header", null, false],
    ["an API token", `adp_${"a".repeat(43)}`, false],
    ["a malformed connection token", "adc_not/base64url", false],
    ["an unknown connection token", OTHER_TOKEN, true],
  ])("answers %s with 401 and no MCP challenge", async (_name, token, resolves) => {
    const convex = await connectionConvex();

    const response = await handle(
      routeRequest("GET", "/device/connection", undefined, bearer(token)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Missing or invalid credential" },
    });
    expect(convex.routes()).toEqual(resolves ? ["identity/resolve-token"] : []);
  });

  it("answers a token resolved without a harness with 503", async () => {
    const convex = fakeConvex();

    const response = await handle(
      routeRequest("GET", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(503);
  });
});

describe("DELETE /device/connection", () => {
  it("revokes by the token's hash alone, then refuses the token", async () => {
    const convex = await connectionConvex();
    const hash = await hashToken(TOKEN);

    const response = await handle(
      routeRequest("DELETE", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(convex.calls).toEqual([
      { route: "identity/resolve-token", body: { token_hash: hash } },
      { route: "identity/revoke-self", body: { token_hash: hash } },
    ]);
    expect(JSON.stringify(convex.calls)).not.toContain(TOKEN);

    const check = await handle(
      routeRequest("GET", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );
    expect(check.status).toBe(401);
    expect(check.headers.get("WWW-Authenticate")).toBeNull();

    const again = await handle(
      routeRequest("DELETE", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );
    expect(again.status).toBe(401);
    expect(convex.routes().filter((route) => route === "identity/revoke-self")).toHaveLength(1);
  });

  it.each([
    ["no Authorization header", null],
    ["an API token", `adp_${"a".repeat(43)}`],
    ["an unknown connection token", OTHER_TOKEN],
  ])("answers %s with 401 and revokes nothing", async (_name, token) => {
    const convex = await connectionConvex();

    const response = await handle(
      routeRequest("DELETE", "/device/connection", undefined, bearer(token)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(convex.routes()).not.toContain("identity/revoke-self");
  });

  it("answers a revoke that loses a race with another revoke with 401", async () => {
    const convex = await connectionConvex({
      "identity/revoke-self": () => {
        throw new ServiceError("unauthenticated", "Invalid credential");
      },
    });

    const response = await handle(
      routeRequest("DELETE", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
  });

  it("answers another revoke error with 503", async () => {
    const convex = await connectionConvex({
      "identity/revoke-self": () => {
        throw new ServiceError("not_found", "Not found");
      },
    });

    const response = await handle(
      routeRequest("DELETE", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(503);
  });
});

describe("device routes during a Convex outage", () => {
  const outage = () => {
    throw new UpstreamError("Service call failed");
  };

  it.each([
    ["POST /device/start", () => startRequest(START)],
    ["POST /device/poll", () => routeRequest("POST", "/device/poll", { device_secret: SECRET })],
    [
      "GET /device/connection",
      () => routeRequest("GET", "/device/connection", undefined, bearer(TOKEN)),
    ],
    [
      "DELETE /device/connection",
      () => routeRequest("DELETE", "/device/connection", undefined, bearer(TOKEN)),
    ],
  ])("answers %s with 503 naming no secret", async (_name, request) => {
    const convex = fakeConvex({
      "identity/resolve-token": outage,
      "identity/device-start": outage,
      "identity/device-collect": outage,
    });

    const response = await handle(request(), withLimiter(), convex.svc);

    expect(response.status).toBe(503);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
    });
    expect(convex.calls.length).toBeGreaterThan(0);
  });

  it("answers an outage during revoke with 503", async () => {
    const convex = await connectionConvex({ "identity/revoke-self": outage });

    const response = await handle(
      routeRequest("DELETE", "/device/connection", undefined, bearer(TOKEN)),
      env,
      convex.svc,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(TOKEN);
  });
});

describe("routing", () => {
  it.each([
    ["GET", "/device/start"],
    ["GET", "/device/poll"],
    ["POST", "/device/connection"],
    ["POST", "/install.sh"],
    ["GET", "/device"],
    ["DELETE", "/v1/decisions"],
    ["GET", "/v1/unknown"],
  ])("answers %s %s with 404 and calls nothing", async (method, path) => {
    const convex = fakeConvex();

    const response = await handle(routeRequest(method, path), withLimiter(), convex.svc);

    expect(response.status).toBe(404);
    expect(convex.calls).toEqual([]);
  });
});
