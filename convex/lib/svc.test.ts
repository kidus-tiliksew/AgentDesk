import { type ErrorCode, errorBodySchema } from "@agentdesk/contract";
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import schema from "../schema";
import { modules } from "../test.modules";
import { serviceRoute } from "./svc";

const SECRET = "test-service-secret";
const PATH = "/svc/test/echo";

// No domain defines a service route yet, so each test mounts the wrapper on a
// fixture router in place of convex/http.ts.
function setup(handler: (input: { name: string }) => Promise<unknown>) {
  const spy = vi.fn(handler);
  const router = httpRouter();
  router.route({
    path: PATH,
    method: "POST",
    handler: serviceRoute(z.object({ name: z.string() }), (_ctx, input) => spy(input)),
  });
  const t = convexTest(schema, { ...modules, "./http.ts": async () => ({ default: router }) });
  return { t, spy };
}

function post(t: ReturnType<typeof setup>["t"], body: string, authorization?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization !== undefined) {
    headers.Authorization = authorization;
  }
  return t.fetch(PATH, { method: "POST", headers, body });
}

async function errorOf(response: Response) {
  return errorBodySchema.parse(await response.json()).error;
}

const validBody = JSON.stringify({ name: "a" });

describe("serviceRoute", () => {
  beforeEach(() => {
    vi.stubEnv("SERVICE_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("runs the handler with the parsed body for the right secret", async () => {
    const { t, spy } = setup(async (input) => ({ greeting: `hi ${input.name}` }));

    const response = await post(t, validBody, `Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ greeting: "hi a" });
    expect(spy).toHaveBeenCalledWith({ name: "a" });
  });

  test("returns 401 for a missing secret without running the handler", async () => {
    const { t, spy } = setup(async () => null);

    const response = await post(t, validBody);

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
    expect(spy).not.toHaveBeenCalled();
  });

  test("returns 401 for a wrong secret without running the handler", async () => {
    const { t, spy } = setup(async () => null);

    const response = await post(t, validBody, `Bearer ${SECRET}x`);

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  test("authenticates before parsing the body", async () => {
    const { t, spy } = setup(async () => null);

    const response = await post(t, "not json", "Bearer wrong");

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  test("refuses every call when SERVICE_SECRET is unset", async () => {
    vi.stubEnv("SERVICE_SECRET", undefined);
    const { t, spy } = setup(async () => null);

    for (const authorization of ["Bearer undefined", "Bearer ", undefined]) {
      expect((await post(t, validBody, authorization)).status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test("returns 400 naming the failing field for an invalid body", async () => {
    const { t, spy } = setup(async () => null);

    const response = await post(t, JSON.stringify({ name: 5 }), `Bearer ${SECRET}`);

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid", field: "name" });
    expect(spy).not.toHaveBeenCalled();
  });

  test("returns 400 for a body that is not JSON", async () => {
    const { t, spy } = setup(async () => null);

    const response = await post(t, "not json", `Bearer ${SECRET}`);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid");
    expect(spy).not.toHaveBeenCalled();
  });

  test.each<[ErrorCode, number]>([
    ["invalid", 400],
    ["unauthenticated", 401],
    ["not_found", 404],
    ["conflict", 409],
    ["locked", 423],
    ["rate_limited", 429],
  ])("maps ConvexError code %s to %i", async (code, status) => {
    const { t } = setup(async () => {
      throw new ConvexError({ code, message: `failed with ${code}`, field: "name" });
    });

    const response = await post(t, validBody, `Bearer ${SECRET}`);

    expect(response.status).toBe(status);
    expect(await errorOf(response)).toEqual({
      code,
      message: `failed with ${code}`,
      field: "name",
    });
  });
});
