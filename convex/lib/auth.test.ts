import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { requireUser } from "./auth";
import { modules } from "./test.modules";

const unauthenticated = { data: { code: "unauthenticated" } };

describe("requireUser", () => {
  test("returns the active user for the signed-in subject", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    );

    const user = await t.withIdentity({ subject: "user_a" }).run((ctx) => requireUser(ctx));

    expect(user._id).toBe(id);
  });

  test("throws unauthenticated without an identity", async () => {
    const t = convexTest(schema, modules);

    await expect(t.run((ctx) => requireUser(ctx))).rejects.toMatchObject(unauthenticated);
  });

  test("throws unauthenticated for an identity with no users row", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity({ subject: "user_missing" }).run((ctx) => requireUser(ctx)),
    ).rejects.toMatchObject(unauthenticated);
  });

  test("throws unauthenticated for a user whose deletingAt is set", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 0 }),
    );

    await expect(
      t.withIdentity({ subject: "user_a" }).run((ctx) => requireUser(ctx)),
    ).rejects.toMatchObject(unauthenticated);
  });
});
