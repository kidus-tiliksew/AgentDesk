import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// component-website §Visual identity: every text color measures at least
// 4.5:1 against the backgrounds it sits on, in both schemes (req-website
// AC-1.8). Ratios use the WCAG 2.x relative luminance formula.
const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");

function properties(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    const [, name, value] = match;
    if (name && value) result[name] = value.toLowerCase();
  }
  return result;
}

function rootBlock(source: string): string {
  const match = /:root\s*\{([^}]*)\}/.exec(source);
  if (!match?.[1]) throw new Error("no :root block");
  return match[1];
}

const light = properties(rootBlock(css));
const darkMedia = /@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?\})\s*\}/.exec(css)?.[1];
if (!darkMedia) throw new Error("no dark color-scheme block");
const dark = { ...light, ...properties(rootBlock(darkMedia)) };

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const pairs: Array<[string, string]> = [
  ["--text", "--background"],
  ["--text", "--surface"],
  ["--text-secondary", "--background"],
  ["--text-secondary", "--surface"],
  ["--accent", "--background"],
  ["--accent", "--surface"],
  ["--on-accent", "--accent-fill"],
];

const expected = {
  light: {
    "--background": "#ffffff",
    "--surface": "#f2f2f7",
    "--text": "#000000",
    "--text-secondary": "#6c6c72",
    "--accent": "#4f46e5",
    "--accent-fill": "#4f46e5",
    "--on-accent": "#ffffff",
  },
  dark: {
    "--background": "#000000",
    "--surface": "#1c1c1e",
    "--text": "#ffffff",
    "--text-secondary": "#9a9aa1",
    "--accent": "#9993ff",
    "--accent-fill": "#4f46e5",
    "--on-accent": "#ffffff",
  },
};

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s scheme", (scheme, palette) => {
  test("uses the component-website palette", () => {
    for (const [name, value] of Object.entries(expected[scheme])) {
      expect(palette[name], name).toBe(value);
    }
  });

  test.each(pairs)("%s on %s measures at least 4.5:1", (text, background) => {
    const fg = palette[text];
    const bg = palette[background];
    if (!fg || !bg) throw new Error(`missing ${text} or ${background}`);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

test("the formula matches known WCAG ratios", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
});
