import { TOPIC_PATTERN, topicMatches } from "@agentdesk/contract";
import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import {
  clampPageSize,
  HISTORY_PAGE_MAX,
  HISTORY_PAGE_MIN,
  parseHistoryFilters,
  settledInstant,
  topicBounds,
  topicInBounds,
} from "./history";

const TOPICS = [
  "a",
  "a/b",
  "a/b/c",
  "a/bc",
  "a/b-c",
  "a/b.c",
  "a/b_c",
  "a/b0",
  "a/b/",
  "a-b",
  "a.b",
  "a_b",
  "a0",
  "a9",
  "a/",
  "a//b",
  "ab",
  "acme",
  "acme/billing",
  "acme/billing/eu",
  "acmecorp",
  "acme-x",
  "acme.x",
  "acme_x",
  "acme0",
  "acme/",
  "b",
  "0",
  "-",
  ".",
  "/",
  "_",
  "z/a",
  "repo/x",
  "repo/x/y",
  "repo/xy",
];

describe("topicInBounds", () => {
  test("covers every canonical topic character", () => {
    for (const topic of TOPICS) {
      expect(TOPIC_PATTERN.test(topic)).toBe(true);
    }
  });

  // req-mobile-app AC-2.4, AC-6.1: the same rule as notification rule topics.
  test("agrees with the contract's topicMatches for every pair", () => {
    for (const rule of TOPICS) {
      for (const topic of TOPICS) {
        expect([rule, topic, topicInBounds(rule, topic)]).toEqual([
          rule,
          topic,
          topicMatches(rule, topic),
        ]);
      }
    }
  });

  test("matches acme/billing and not acmecorp for acme", () => {
    expect(topicInBounds("acme", "acme")).toBe(true);
    expect(topicInBounds("acme", "acme/billing")).toBe(true);
    expect(topicInBounds("acme", "acmecorp")).toBe(false);
    expect(topicBounds("acme")).toEqual({ lower: "acme/", upper: "acme0" });
  });
});

describe("clampPageSize", () => {
  test.each([
    [0, HISTORY_PAGE_MIN],
    [-3, 1],
    [1, 1],
    [2.7, 2],
    [25, 25],
    [50, HISTORY_PAGE_MAX],
    [51, 50],
    [Number.POSITIVE_INFINITY, 50],
    [Number.NEGATIVE_INFINITY, 1],
    [Number.NaN, 1],
  ])("clamps %s to %s", (requested, expected) => {
    expect(clampPageSize(requested)).toBe(expected);
  });
});

describe("parseHistoryFilters", () => {
  test("treats absent and whitespace text as empty and trims text", () => {
    expect(parseHistoryFilters({})).toEqual({ text: "", state: undefined, topic: undefined });
    expect(parseHistoryFilters({ query: " \t " }).text).toBe("");
    expect(parseHistoryFilters({ query: "  ship it " }).text).toBe("ship it");
  });

  test("accepts settled states and normalizes topics", () => {
    for (const state of ["answered", "expired", "cancelled"]) {
      expect(parseHistoryFilters({ state }).state).toBe(state);
    }
    expect(parseHistoryFilters({ topic: "Acme/Billing" }).topic).toBe("acme/billing");
  });

  test.each([
    [{ state: "pending" }, "state"],
    [{ state: "ANSWERED" }, "state"],
    [{ topic: "" }, "topic"],
    [{ topic: "a b" }, "topic"],
    [{ topic: "x".repeat(101) }, "topic"],
  ])("refuses %j as invalid naming %s", (raw, field) => {
    expect(() => parseHistoryFilters(raw)).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "invalid", field }) }),
    );
  });
});

describe("settledInstant", () => {
  const row = (patch: Partial<Doc<"decisions">>) =>
    ({ _id: "d1", state: "answered", settledAt: 1, ...patch }) as Doc<"decisions">;

  test("returns the settlement time as ISO 8601", () => {
    const at = Date.UTC(2026, 9, 12, 8, 30, 0, 123);
    expect(settledInstant(row({ settledAt: at }))).toBe("2026-10-12T08:30:00.123Z");
  });

  test("fails a settled row without a settlement time instead of inventing one", () => {
    expect(() => settledInstant(row({ settledAt: undefined }))).toThrow(/settlement time/);
    expect(() => settledInstant(row({ settledAt: 0 }))).toThrow(/settlement time/);
    expect(() => settledInstant(row({ state: "pending" }))).toThrow(/settlement time/);
  });
});
