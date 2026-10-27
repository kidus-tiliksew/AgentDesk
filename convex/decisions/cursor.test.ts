import { describe, expect, test } from "vitest";
import { base64url, decodeCursorJson, encodeCursorJson, fromBase64url } from "./cursor";

// component-decisions §Public API reads: the cursor codec never throws, so a
// malformed cursor always reaches the routes' `invalid` answer.
describe("fromBase64url", () => {
  test("round-trips every byte length from 1 to 8", () => {
    for (let length = 1; length <= 8; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 250) % 256);
      expect(fromBase64url(base64url(bytes))).toEqual(bytes);
    }
  });

  test.each([
    ["a length of 1 modulo 4", "a"],
    ["a length of 5", "aaaaa"],
    ["a length of 9", "aaaaaaaaa"],
    ["a character outside the alphabet", "ab+c"],
    ["padding", "YQ=="],
    ["an empty string", ""],
  ])("returns null for %s without throwing", (_name, text) => {
    expect(() => fromBase64url(text)).not.toThrow();
    expect(fromBase64url(text)).toBeNull();
  });
});

describe("decodeCursorJson", () => {
  test("returns the encoded value", () => {
    const value = { v: 1, state: null, topic: "acme", cursor: "x" };

    expect(decodeCursorJson(encodeCursorJson(value))).toEqual(value);
  });

  test.each(["a", "aaaaa", "!!", base64url(new TextEncoder().encode("{not json"))])(
    "returns undefined for %s without throwing",
    (cursor) => {
      expect(() => decodeCursorJson(cursor)).not.toThrow();
      expect(decodeCursorJson(cursor)).toBeUndefined();
    },
  );
});
