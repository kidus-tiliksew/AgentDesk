import { describe, expect, test } from "vitest";
import { normalizeTopic, topicMatches, topicSchema } from "../src/index.js";

// req-agent-tools AC-8.1, AC-8.2; component-contract §Topics.
describe("normalizeTopic", () => {
  test.each([
    ["Repo/Feature", "repo/feature"],
    ["ABC", "abc"],
    ["a", "a"],
    ["az09._/-", "az09._/-"],
    ["x".repeat(100), "x".repeat(100)],
    ["X".repeat(100), "x".repeat(100)],
  ])("accepts %j as %j", (raw, normalized) => {
    expect(normalizeTopic(raw)).toEqual({ success: true, data: normalized });
  });

  test.each([
    ["empty", ""],
    ["101 characters", "x".repeat(101)],
    ["space", "a b"],
    ["leading space", " a"],
    ["colon", "a:b"],
    ["backslash", "a\\b"],
    ["plus", "a+b"],
    ["non-ASCII letter", "café"],
    ["emoji", "a🙂"],
  ])("rejects %s", (_name, raw) => {
    expect(normalizeTopic(raw).success).toBe(false);
  });

  test.each([undefined, null, 42, ["a"], { topic: "a" }])("rejects non-string %j", (raw) => {
    expect(normalizeTopic(raw).success).toBe(false);
  });

  test("the canonical schema does not lowercase", () => {
    expect(topicSchema.safeParse("Repo").success).toBe(false);
    expect(topicSchema.safeParse("repo").success).toBe(true);
  });
});

describe("topicMatches", () => {
  test.each([
    ["a/b", "a/b", true],
    ["a/b", "a/b/c", true],
    ["a/b", "a/b/c/d", true],
    ["a/b", "a/bc", false],
    ["a/b", "a", false],
    ["a/b", "x/a/b", false],
    ["a", "b", false],
  ])("rule %j against topic %j is %j", (rule, topic, expected) => {
    expect(topicMatches(rule, topic)).toBe(expected);
  });
});
