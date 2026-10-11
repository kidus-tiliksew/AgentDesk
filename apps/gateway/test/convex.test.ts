import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_TIMEOUT_MS, ServiceError, serviceClient, UpstreamError } from "../src/convex.js";

const ENV = { CONVEX_SITE_URL: "https://convex.example/", SERVICE_SECRET: "service-secret-value" };

function respond(status: number, body: string) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail");
}

describe("serviceClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts JSON to the service route with the service secret", async () => {
    const { fetcher, requests } = respond(200, JSON.stringify({ agentSessionId: "s" }));
    const svc = serviceClient(ENV, fetcher);

    await expect(svc("agents/session", { userId: "u", mcpSessionId: "m" })).resolves.toEqual({
      agentSessionId: "s",
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://convex.example/svc/agents/session");
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers).toEqual({
      Authorization: "Bearer service-secret-value",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(request?.init.body))).toEqual({ userId: "u", mcpSessionId: "m" });
  });

  it("returns a null result", async () => {
    const { fetcher } = respond(200, "null");
    await expect(serviceClient(ENV, fetcher)("agents/status", {})).resolves.toBeNull();
  });

  it("parses a contract error body into a ServiceError", async () => {
    const body = { error: { code: "invalid", message: "Invalid topic", field: "topic" } };
    const { fetcher } = respond(400, JSON.stringify(body));

    const error = await failure(serviceClient(ENV, fetcher)("agents/status", {}));
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid", message: "Invalid topic", field: "topic" });
  });

  it("keeps a contract error without a field", async () => {
    const body = { error: { code: "not_found", message: "Not found" } };
    const { fetcher } = respond(404, JSON.stringify(body));

    const error = await failure(serviceClient(ENV, fetcher)("decisions/cancel", {}));
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).field).toBeUndefined();
  });

  it.each([
    ["a body that is not JSON", 200, "<html>", "not JSON"],
    ["an error without a contract body", 500, '{"message":"Server Error"}', "status 500"],
    ["an unknown error code", 418, '{"error":{"code":"teapot","message":"x"}}', "status 418"],
  ])("raises UpstreamError for %s", async (_name, status, body, message) => {
    const { fetcher } = respond(status, body);

    const error = await failure(serviceClient(ENV, fetcher)("agents/open", {}));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toContain(message);
  });

  it("raises UpstreamError without the request on a network failure", async () => {
    const fetcher = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;

    const error = await failure(
      serviceClient(ENV, fetcher)("identity/resolve-token", { token_hash: "f".repeat(64) }),
    );
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe("Service call identity/resolve-token failed");
    expect(error.message).not.toContain("service-secret-value");
  });

  it("aborts a call after 10 seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const call = serviceClient(ENV, fetcher)("agents/open", {});
    const outcome = call.then(
      () => "resolved",
      (error: Error) => error,
    );
    expect(SERVICE_TIMEOUT_MS).toBe(10_000);
    await vi.advanceTimersByTimeAsync(SERVICE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(signal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).toBe("Service call agents/open timed out");
  });

  it("cancels a call in flight when the caller's signal aborts", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const caller = new AbortController();

    const outcome = serviceClient(ENV, fetcher)("decisions/poll", {}, caller.signal).then(
      () => "resolved",
      (error: Error) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal?.aborted).toBe(false);
    caller.abort();

    const error = await outcome;
    expect(signal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).toBe("Service call decisions/poll was cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels at once for a signal that already aborted", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = (async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const caller = new AbortController();
    caller.abort();

    const error = await failure(serviceClient(ENV, fetcher)("decisions/poll", {}, caller.signal));
    expect(signal?.aborted).toBe(true);
    expect(error.message).toBe("Service call decisions/poll was cancelled");
  });
});
