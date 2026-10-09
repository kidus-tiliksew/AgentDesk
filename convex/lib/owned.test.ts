import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { tables as identity } from "../identity/schema";
import { modules } from "../test.modules";
import { getOwned } from "./owned";

// No production table carries userId yet, so the test composes an owned
// fixture table beside the real users table.
const fixtureSchema = defineSchema({
  ...identity,
  notes: defineTable({ userId: v.id("users"), body: v.string() }),
});

async function setup() {
  const t = convexTest(fixtureSchema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { clerkUserId: "user_a", email: "a@example.com" });
    const other = await ctx.db.insert("users", { clerkUserId: "user_b", email: "b@example.com" });
    const note = await ctx.db.insert("notes", { userId: owner, body: "hello" });
    return { owner, other, note };
  });
  return { t, ...ids };
}

// req-accounts-and-connections AC-1.1
describe("getOwned", () => {
  test("returns the document to its owner", async () => {
    const { t, owner, note } = await setup();

    const doc = await t.run((ctx) => getOwned(ctx, "notes", note, owner));

    expect(doc?._id).toBe(note);
  });

  test("returns null for another account's document", async () => {
    const { t, other, note } = await setup();

    expect(await t.run((ctx) => getOwned(ctx, "notes", note, other))).toBeNull();
  });

  test("returns null for a missing document", async () => {
    const { t, owner, note } = await setup();
    await t.run((ctx) => ctx.db.delete("notes", note));

    expect(await t.run((ctx) => getOwned(ctx, "notes", note, owner))).toBeNull();
  });
});
