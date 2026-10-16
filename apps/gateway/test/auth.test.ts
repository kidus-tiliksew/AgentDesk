import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken as backendHashToken, mintToken } from "../../../convex/identity/tokens.js";
import { hashToken } from "../src/auth.js";
import { ServiceError, serviceClient, UpstreamError } from "../src/convex.js";
import { handle } from "../src/index.js";
import { env, fakeConvex, mcpRequest, rpc, TOKEN, USER } from "./fake.js";

const CHALLENGE =
  'Bearer resource_metadata="https://agentdesk.example/.well-known/oauth-protected-resource"';

describe("hashToken", () => {
  it("is the lowercase SHA-256 hex digest", async () => {
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the identity helper for a minted token", async () => {
    const { plaintext, hash } = await mintToken();
    expect(await hashToken(plaintext)).toBe(hash);
    expect(await hashToken(TOKEN)).toBe(await backendHashToken(TOKEN));
  });
});

describe("credential dispatch", () => {
  it.each([
    ["no Authorization header", null],
    ["another scheme", `Basic ${TOKEN}`],
    ["an empty connection token", "Bearer adc_"],
    ["a malformed connection token", "Bearer adc_not/base64url"],
    ["an API token", `Bearer adp_${"a".repeat(43)}`],
    ["a bearer value with neither prefix", "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"],
  ])("answers %s with the 401 challenge and calls nothing", async (_name, authorization) => {
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("tools/list"), { Authorization: authorization }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    expect(convex.calls).toEqual([]);
  });

  it("resolves a connection token by its hash and refuses an unknown one", async () => {
    const unknown = `adc_${"b".repeat(43)}`;
    const convex = fakeConvex();

    const response = await handle(
      mcpRequest(rpc("tools/list"), { Authorization: `Bearer ${unknown}` }),
      env,
      convex.svc,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    expect(convex.calls).toEqual([
      { route: "identity/resolve-token", body: { token_hash: await hashToken(unknown) } },
    ]);
    expect(await response.text()).not.toContain(unknown);
  });

  it("refuses a credential that resolves to another kind", async () => {
    const convex = fakeConvex({
      "identity/resolve-token": () => ({ userId: USER, credentialId: "c", kind: "api_token" }),
    });

    const response = await handle(mcpRequest(rpc("tools/list")), env, convex.svc);

    expect(response.status).toBe(401);
  });

  it("resolves the credential again on every request, so a revocation applies at once", async () => {
    let revoked = false;
    const convex = fakeConvex({
      "identity/resolve-token": () => {
        if (revoked) {
          throw new ServiceError("unauthenticated", "Invalid credential");
        }
        return { userId: USER, credentialId: "cred_a", kind: "connection_token" };
      },
    });

    const first = await handle(mcpRequest(rpc("tools/list")), env, convex.svc);
    expect(first.status).toBe(200);
    revoked = true;
    const second = await handle(mcpRequest(rpc("tools/list")), env, convex.svc);

    expect(second.status).toBe(401);
    expect(second.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    expect(convex.routes().filter((route) => route === "identity/resolve-token")).toHaveLength(2);
  });

  it("answers a Convex outage with a JSON-RPC error rather than 401, naming no secret", async () => {
    const convex = fakeConvex({
      "identity/resolve-token": () => {
        throw new UpstreamError("Service call identity/resolve-token timed out");
      },
    });

    const response = await handle(mcpRequest(rpc("tools/list", undefined, 3)), env, convex.svc);

    expect(response.status).toBe(200);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32603,
        message: "AgentDesk is temporarily unavailable",
        data: { code: "unavailable" },
      },
    });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(env.SERVICE_SECRET);
    expect(text).not.toContain("identity/resolve-token");
  });

  it("answers a Convex outage on a request without a JSON-RPC id with 503", async () => {
    const convex = fakeConvex({
      "identity/resolve-token": () => {
        throw new UpstreamError("Service call identity/resolve-token timed out");
      },
    });

    for (const request of [
      mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
      mcpRequest("{not json"),
      new Request("https://agentdesk.example/mcp", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    ]) {
      const response = await handle(request, env, convex.svc);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" },
      });
    }
  });

  it.each([
    ["no credential", null],
    ["a malformed credential", "Bearer adc_!!"],
    ["a revoked credential", `Bearer adc_${"b".repeat(43)}`],
  ])("answers %s with 401 whatever the body holds, before any other call", async (_, auth) => {
    for (const body of [rpc("tools/list"), "{not json", { jsonrpc: "2.0", method: "x" }]) {
      const convex = fakeConvex();

      const response = await handle(mcpRequest(body, { Authorization: auth }), env, convex.svc);

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
      expect(convex.routes()).toEqual(
        auth === `Bearer adc_${"b".repeat(43)}` ? ["identity/resolve-token"] : [],
      );
    }
  });

  describe("through the service client", () => {
    // Answers identity/resolve-token with a status and a contract error body,
    // the way Convex service routes do.
    function convexAnswering(status: number, code: string) {
      const fetcher = (async () =>
        Response.json(
          { error: { code, message: `${code} from identity` } },
          { status },
        )) as unknown as typeof fetch;
      return serviceClient(env, fetcher);
    }

    it("answers a revoked or unknown token, refused as unauthenticated, with 401", async () => {
      const response = await handle(
        mcpRequest(rpc("tools/list")),
        env,
        convexAnswering(401, "unauthenticated"),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    });

    it.each([
      [429, "rate_limited"],
      [400, "invalid"],
      [409, "conflict"],
    ])(
      "answers a resolution failing with %i %s with a JSON-RPC error keeping the code, not 401",
      async (status, code) => {
        const response = await handle(
          mcpRequest(rpc("tools/list", undefined, "list-1")),
          env,
          convexAnswering(status, code),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("WWW-Authenticate")).toBeNull();
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          jsonrpc: "2.0",
          id: "list-1",
          error: { code: -32603, data: { code } },
        });
        // The service's own message stays inside the gateway.
        expect(text).not.toContain("from identity");
        expect(text).not.toContain("unavailable");
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(env.SERVICE_SECRET);
      },
    );
  });

  it("challenges with the deployed PUBLIC_ORIGIN through the Worker entrypoint", async () => {
    const response = await exports.default.fetch("http://localhost:8787/mcp", { method: "POST" });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource"',
    );
  });
});
