import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { ensureUser, getUserByClerkId } from "./users";

const identity = { subject: "user_a", email: "a@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };

describe("getUserByClerkId", () => {
  test("returns the active row", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" }),
    );

    expect((await t.run((ctx) => getUserByClerkId(ctx, "user_a")))?._id).toBe(id);
  });

  test("returns null when no row exists", async () => {
    const t = convexTest(schema, modules);

    expect(await t.run((ctx) => getUserByClerkId(ctx, "user_a"))).toBeNull();
  });

  test("returns null when deletingAt is set", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 0 }),
    );

    expect(await t.run((ctx) => getUserByClerkId(ctx, "user_a"))).toBeNull();
  });
});

describe("ensureUser", () => {
  // req-accounts-and-connections AC-2.1
  test("creates one row on first use and returns the same row on the second call", async () => {
    const t = convexTest(schema, modules).withIdentity(identity);

    const first = await t.run((ctx) => ensureUser(ctx));
    const second = await t.run((ctx) => ensureUser(ctx));

    expect(first).toMatchObject({ clerkUserId: "user_a", email: "a@example.com" });
    expect(second).toEqual(first);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
  });

  test("throws unauthenticated for a deleting user without inserting a row", async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 1 }),
    );

    await expect(t.run((ctx) => ensureUser(ctx))).rejects.toMatchObject(unauthenticated);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
  });

  test("throws unauthenticated without an identity", async () => {
    const t = convexTest(schema, modules);

    await expect(t.run((ctx) => ensureUser(ctx))).rejects.toMatchObject(unauthenticated);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  });

  test("throws unauthenticated for an identity with no email without inserting a row", async () => {
    const t = convexTest(schema, modules).withIdentity({ subject: "user_a" });

    await expect(t.run((ctx) => ensureUser(ctx))).rejects.toMatchObject(unauthenticated);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  });
});
