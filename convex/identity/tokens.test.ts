import { describe, expect, test } from "vitest";
import { hashToken, mintToken } from "./tokens";

// Computes the digest separately from hashToken, so the test does not check
// the helper against itself.
async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64url(text: string) {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );
}

describe("mintToken", () => {
  test("returns an adc_ token encoding 32 bytes in base64url", async () => {
    const { plaintext } = await mintToken();

    expect(plaintext).toMatch(/^adc_[A-Za-z0-9_-]{43}$/);
    expect(decodeBase64url(plaintext.slice("adc_".length))).toHaveLength(32);
  });

  test("returns the SHA-256 hex of the plaintext as its hash", async () => {
    const { plaintext, hash } = await mintToken();

    expect(hash).toBe(await sha256Hex(plaintext));
  });

  test("returns a different token on each call", async () => {
    const [a, b] = await Promise.all([mintToken(), mintToken()]);

    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe("hashToken", () => {
  test("returns 64 lowercase hex characters", async () => {
    expect(await hashToken("adc_example")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the SHA-256 hex digest", async () => {
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
