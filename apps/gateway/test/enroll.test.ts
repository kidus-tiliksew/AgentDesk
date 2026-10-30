import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth.js";
import { ServiceError, type ServiceRoute, UpstreamError } from "../src/convex.js";
import { handle as route } from "../src/index.js";
import { env, fakeConvex, fakeLimiter, routeRequest } from "./fake.js";

// component-gateway §Sign-in endpoints: `POST /device/enroll`, install-key
// enrollment (req-install-keys REQ-2), with Convex faked.

const IP = "203.0.113.9";
// A sentinel install key: any log line or response carrying it, or its body
// without the prefix, fails the secret checks below.
const KEY = `adk_${"K".repeat(20)}sentinel${"k".repeat(15)}`;
const KEY_BODY = KEY.slice(4);
const MACHINE_ID = "0123456789abcdef0123456789abcdef";

const ENROLL = {
  install_key: KEY,
  machine_name: " sandbox-1 ",
  harnesses: ["codex", "claude-code"],
};

const ENROLLED = {
  status: "enrolled",
  machine_id: MACHINE_ID,
  connections: [
    { harness: "codex", connection_id: "cred_1", token: `adc_${"c".repeat(43)}` },
    { harness: "claude-code", connection_id: "cred_2", token: `adc_${"d".repeat(43)}` },
  ],
};

function enrollRequest(body: unknown, headers: Record<string, string | null> = {}): Request {
  return routeRequest("POST", "/device/enroll", body, { "CF-Connecting-IP": IP, ...headers });
}

function withLimiter(limiter = fakeLimiter(60)) {
  return { ...env, DEVICE_ENROLL_LIMIT: limiter.binding };
}

function enrollConvex(answer: (body: Record<string, unknown>) => unknown = () => ENROLLED) {
  return fakeConvex({ "identity/enroll": answer });
}

// Every console line written during a test, so a test can assert that none
// carries the install key.
let logged: string[];

beforeEach(() => {
  logged = [];
  answered = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((arg) =>
            arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack}` : String(arg),
          )
          .join(" "),
      );
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Every response body this test received.
let answered: string[];

// The Worker's handler, keeping a copy of each response body.
async function handle(...args: Parameters<typeof route>): Promise<Response> {
  const response = await route(...args);
  answered.push(await response.clone().text());
  return response;
}

// Neither a response nor a log line carried the install key.
function expectNoSecret() {
  for (const text of [...answered, ...logged]) {
    expect(text).not.toContain(KEY_BODY);
  }
}

describe("POST /device/enroll", () => {
  it("hashes the key, sends Convex only the hash, and answers identity's enrollment", async () => {
    const convex = enrollConvex();

    const response = await handle(enrollRequest(ENROLL), withLimiter(), convex.svc);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(ENROLLED);
    expect(convex.calls).toEqual([
      {
        route: "identity/enroll",
        body: {
          key_hash: await hashToken(KEY),
          machine_name: "sandbox-1",
          harnesses: ["codex", "claude-code"],
        },
      },
    ]);
    expect(JSON.stringify(convex.calls)).not.toContain(KEY_BODY);
    expectNoSecret();
  });

  it.each([
    [{ status: "unknown" }],
    [{ status: "revoked" }],
    [{ status: "expired" }],
    [{ status: "limit_reached" }],
    [{ status: "harness_not_allowed", harness: "cursor" }],
  ])("answers identity's refusal %j with 200", async (status) => {
    const convex = enrollConvex(() => status);

    const response = await handle(enrollRequest(ENROLL), withLimiter(), convex.svc);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    expectNoSecret();
  });

  it.each<[string, unknown, string | undefined]>([
    ["a body that is not JSON", "{", undefined],
    ["an array body", [ENROLL], undefined],
    ["no install_key", { ...ENROLL, install_key: undefined }, "install_key"],
    [
      "a connection token as the key",
      { ...ENROLL, install_key: `adc_${"a".repeat(43)}` },
      "install_key",
    ],
    ["a key one character short", { ...ENROLL, install_key: KEY.slice(0, -1) }, "install_key"],
    ["a key one character long", { ...ENROLL, install_key: `${KEY}a` }, "install_key"],
    ["a key outside base64url", { ...ENROLL, install_key: `${KEY.slice(0, -1)}+` }, "install_key"],
    ["a key with whitespace", { ...ENROLL, install_key: ` ${KEY}` }, "install_key"],
    ["no machine_name", { ...ENROLL, machine_name: undefined }, "machine_name"],
    ["a blank machine_name", { ...ENROLL, machine_name: "  " }, "machine_name"],
    ["a 256-character machine_name", { ...ENROLL, machine_name: "m".repeat(256) }, "machine_name"],
    ["no harnesses", { ...ENROLL, harnesses: undefined }, "harnesses"],
    ["an empty harness list", { ...ENROLL, harnesses: [] }, "harnesses"],
    ["a repeated harness", { ...ENROLL, harnesses: ["codex", "codex"] }, "harnesses"],
    ["an unknown harness", { ...ENROLL, harnesses: ["vim"] }, "harnesses"],
    ["harnesses that are not a list", { ...ENROLL, harnesses: "codex" }, "harnesses"],
  ])("answers %s with 400 and calls nothing", async (_name, body, field) => {
    const convex = enrollConvex();

    const response = await handle(enrollRequest(body), withLimiter(), convex.svc);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { error } = (await response.json()) as { error: { code: string; field?: string } };
    expect(error.code).toBe("invalid");
    expect(error.field).toBe(field);
    expect(convex.calls).toEqual([]);
    expectNoSecret();
  });

  it("checks the key before the machine name and the machine name before the harnesses", async () => {
    const convex = enrollConvex();
    const field = async (body: unknown) =>
      (
        (await (await handle(enrollRequest(body), withLimiter(), convex.svc)).json()) as {
          error: { field: string };
        }
      ).error.field;

    expect(await field({ install_key: "x", machine_name: "", harnesses: [] })).toBe("install_key");
    expect(await field({ install_key: KEY, machine_name: "", harnesses: [] })).toBe("machine_name");
  });

  it.each([
    ["machineName", "machine_name"],
    ["harnesses", "harnesses"],
  ])("restates identity's invalid %s as 400 naming %s", async (serviceField, field) => {
    const convex = enrollConvex(() => {
      throw new ServiceError("invalid", "Invalid", serviceField);
    });

    const response = await handle(enrollRequest(ENROLL), withLimiter(), convex.svc);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "invalid", message: `${field} is not valid`, field },
    });
  });

  it("answers the 61st enrollment in a minute from one IP with 429 and calls nothing", async () => {
    let now = 0;
    const limiter = fakeLimiter(60, 60_000, () => now);
    const convex = enrollConvex();

    for (let i = 0; i < 60; i++) {
      now = i * 900;
      expect((await handle(enrollRequest(ENROLL), withLimiter(limiter), convex.svc)).status).toBe(
        200,
      );
    }
    now = 59_000;
    const request = enrollRequest(ENROLL);
    const response = await handle(request, withLimiter(limiter), convex.svc);

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "rate_limited", message: "Too many enrollments; try again in a minute" },
    });
    // The limit is taken before the body is read.
    expect(request.bodyUsed).toBe(false);
    expect(convex.calls).toHaveLength(60);
    expect(limiter.keys).toEqual(Array(61).fill(IP));

    const other = await handle(
      enrollRequest(ENROLL, { "CF-Connecting-IP": "198.51.100.4" }),
      withLimiter(limiter),
      convex.svc,
    );
    expect(other.status).toBe(200);
  });

  it("counts an invalid body against the limit", async () => {
    const limiter = fakeLimiter(1);
    const convex = enrollConvex();

    await handle(enrollRequest("{"), withLimiter(limiter), convex.svc);
    const response = await handle(enrollRequest(ENROLL), withLimiter(limiter), convex.svc);

    expect(response.status).toBe(429);
    expect(convex.calls).toEqual([]);
  });

  // The local binding counts in fixed one-minute windows. A run that crosses
  // a window's end sees no refusal, so it is repeated once from another IP:
  // two runs of a few seconds cannot both cross one.
  it("limits 60 enrollments a minute per IP through the declared binding", async () => {
    const { DEVICE_ENROLL_LIMIT } = workerEnv as { DEVICE_ENROLL_LIMIT?: RateLimit };
    expect(DEVICE_ENROLL_LIMIT).toBeDefined();
    const limited = { ...env, DEVICE_ENROLL_LIMIT };

    let statuses: number[] = [];
    for (const ip of ["192.0.2.77", "192.0.2.78"]) {
      const convex = enrollConvex();
      statuses = [];
      for (let i = 0; i < 61; i++) {
        const request = enrollRequest(ENROLL, { "CF-Connecting-IP": ip });
        statuses.push((await handle(request, limited, convex.svc)).status);
      }
      // No refusal before the 61st call, whether or not a window ended.
      expect(statuses.slice(0, 60)).toEqual(Array(60).fill(200));
      if (statuses[60] === 429) {
        expect(convex.calls).toHaveLength(60);
        break;
      }
    }

    expect(statuses[60]).toBe(429);
  }, 60_000); // 122 calls through the workerd binding can outlast 5 seconds under load.

  it.each([
    ["no rate-limit binding", false, {}],
    ["no client IP", true, { "CF-Connecting-IP": null }],
    ["an empty client IP", true, { "CF-Connecting-IP": "" }],
  ])("refuses with 503 before reading the body when there is %s", async (_name, bound, headers) => {
    const limiter = fakeLimiter(60);
    const convex = enrollConvex();
    const request = enrollRequest(ENROLL, headers);

    const response = await handle(request, bound ? withLimiter(limiter) : env, convex.svc);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
    });
    expect(request.bodyUsed).toBe(false);
    expect(limiter.keys).toEqual([]);
    expect(convex.calls).toEqual([]);
    expectNoSecret();
  });

  // A Convex outage, an unexpected refusal, an unexpected result, or any other
  // failure answers 503, and neither the key nor the failure's text reaches a
  // log line or the response, even when the failure carries the key.
  it.each<[string, () => unknown]>([
    [
      "an outage",
      () => {
        throw new UpstreamError(`Service call identity/enroll failed ${KEY}`);
      },
    ],
    [
      "an unexpected refusal",
      () => {
        throw new ServiceError("unauthenticated", `Install key owner is not active ${KEY}`);
      },
    ],
    [
      "an invalid refusal naming another field",
      () => {
        throw new ServiceError("invalid", `bad ${KEY}`, "key_hash");
      },
    ],
    [
      "an unexpected exception",
      () => {
        throw new Error(`boom ${KEY}`);
      },
    ],
    [
      "a thrown string",
      () => {
        throw `boom ${KEY}`;
      },
    ],
    [
      "a malformed result",
      () => ({ status: "enrolled", machine_id: MACHINE_ID, connections: [], key: KEY }),
    ],
    ["an unknown status", () => ({ status: "approved", install_key: KEY })],
    [
      "a token that is not a connection token",
      () => ({
        ...ENROLLED,
        connections: [{ harness: "codex", connection_id: "cred_1", token: KEY }],
      }),
    ],
  ])("answers %s with 503 and logs no secret", async (_name, answer) => {
    const convex = enrollConvex(answer);

    const response = await handle(enrollRequest(ENROLL), withLimiter(), convex.svc);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
    });
    expect(logged.length).toBeGreaterThan(0);
    expectNoSecret();
  });

  it("logs no secret when the limiter itself fails", async () => {
    const convex = enrollConvex();
    const binding: RateLimit = {
      async limit() {
        throw new Error(`limiter down ${KEY}`);
      },
    };

    const response = await handle(
      enrollRequest(ENROLL),
      { ...env, DEVICE_ENROLL_LIMIT: binding },
      convex.svc,
    );

    expect(response.status).toBe(503);
    expectNoSecret();
  });

  it("serves POST only", async () => {
    const convex = enrollConvex();

    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await handle(
        routeRequest(method, "/device/enroll", method === "GET" ? undefined : ENROLL, {
          "CF-Connecting-IP": IP,
        }),
        withLimiter(),
        convex.svc,
      );
      expect(response.status).toBe(404);
    }
    expect(convex.routes()).toEqual([] as ServiceRoute[]);
  });
});
