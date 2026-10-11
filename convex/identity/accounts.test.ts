import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { modules } from "../lib/test.modules";
import schema from "../schema";
import { identity } from "./refs";

const asUserA = { subject: "user_a", email: "a@example.com" };
const unauthenticated = { data: { code: "unauthenticated" } };

describe("ensureAccount", () => {
  // req-accounts-and-connections AC-2.1
  test("creates one row on the first call and returns the same row on later calls", async () => {
    const t = convexTest(schema, modules).withIdentity(asUserA);

    const first = await t.mutation(identity.accounts.ensureAccount, {});
    const second = await t.mutation(identity.accounts.ensureAccount, {});

    expect(first).toMatchObject({ clerkUserId: "user_a", email: "a@example.com" });
    expect(second).toEqual(first);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
  });

  test("refuses a user whose deletingAt is set without inserting a row", async () => {
    const t = convexTest(schema, modules).withIdentity(asUserA);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com", deletingAt: 1 }),
    );

    await expect(t.mutation(identity.accounts.ensureAccount, {})).rejects.toMatchObject(
      unauthenticated,
    );
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
  });

  test("refuses a call without an identity", async () => {
    const t = convexTest(schema, modules);

    await expect(t.mutation(identity.accounts.ensureAccount, {})).rejects.toMatchObject(
      unauthenticated,
    );
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  });

  test("refuses an identity with no email without inserting a row", async () => {
    const t = convexTest(schema, modules).withIdentity({ subject: "user_a" });

    await expect(t.mutation(identity.accounts.ensureAccount, {})).rejects.toMatchObject(
      unauthenticated,
    );
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  });
});
