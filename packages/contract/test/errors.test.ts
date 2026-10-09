import { describe, expect, test } from "vitest";
import { ERROR_CODES, errorBodySchema, errorCodeSchema } from "../src/index.js";

describe("error codes", () => {
  test("are exactly the six codes the service routes map", () => {
    expect([...ERROR_CODES]).toEqual([
      "invalid",
      "unauthenticated",
      "not_found",
      "conflict",
      "locked",
      "rate_limited",
    ]);
  });

  test.each(["internal", "forbidden", "INVALID", "", 400])("rejects %j", (code) => {
    expect(errorCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe("error body", () => {
  test.each([
    { error: { code: "invalid", message: "title is required", field: "title" } },
    { error: { code: "not_found", message: "no such decision" } },
  ])("accepts %j", (body) => {
    expect(errorBodySchema.safeParse(body).success).toBe(true);
  });

  test.each([
    { error: { code: "teapot", message: "x" } },
    { error: { code: "invalid" } },
    { code: "invalid", message: "x" },
  ])("rejects %j", (body) => {
    expect(errorBodySchema.safeParse(body).success).toBe(false);
  });
});
