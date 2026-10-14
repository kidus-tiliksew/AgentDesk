import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// component-website §Visual identity: every text color measures at least
// 4.5:1 against the backgrounds it sits on, in both schemes (req-website
// AC-1.8), including --glow composited over --background, the gradient's
// most opaque point. Ratios use the WCAG 2.x relative luminance formula.
const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");

// Hexadecimal colors keep their "#rrggbb" form; rgba() colors are normalized
// to "rgba(r, g, b, a)".
function properties(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(
    /(--[a-z-]+):\s*(#[0-9a-f]{6}|rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\))\s*;/gi,
  )) {
    const [, name, value] = match;
    if (name && value) result[name] = value.toLowerCase().replace(/\s+/g, "").replace(/,/g, ", ");
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

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return [r ?? 0, g ?? 0, b ?? 0];
}

function rgba(value: string): [...Rgb, number] {
  const parts = /^rgba\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)$/.exec(value);
  if (!parts) throw new Error(`not an rgba() color: ${value}`);
  const [r, g, b, a] = parts.slice(1).map(Number);
  return [r ?? 0, g ?? 0, b ?? 0, a ?? 0];
}

// Source-over compositing of a translucent color on an opaque one, per sRGB
// channel. The result keeps fractional channels for the luminance formula.
function composite(over: string, under: string): Rgb {
  const [r, g, b, a] = rgba(over);
  const base = rgb(under);
  return [r, g, b].map((c, i) => c * a + (base[i] ?? 0) * (1 - a)) as Rgb;
}

function luminance(color: string | Rgb): number {
  const [r, g, b] = typeof color === "string" ? rgb(color) : color;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string | Rgb, b: string | Rgb): number {
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
    "--separator": "rgba(60, 60, 67, 0.18)",
    "--glow": "rgba(79, 70, 229, 0.08)",
  },
  dark: {
    "--background": "#000000",
    "--surface": "#1c1c1e",
    "--text": "#ffffff",
    "--text-secondary": "#9a9aa1",
    "--accent": "#9993ff",
    "--accent-fill": "#4f46e5",
    "--on-accent": "#ffffff",
    "--separator": "rgba(255, 255, 255, 0.12)",
    "--glow": "rgba(79, 70, 229, 0.28)",
  },
};

// Text colors that may sit over the --glow gradient.
const glowTexts = ["--text", "--text-secondary", "--accent"];

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

  test.each(glowTexts)("%s on --glow over --background measures at least 4.5:1", (text) => {
    const fg = palette[text];
    const glow = palette["--glow"];
    const background = palette["--background"];
    if (!fg || !glow || !background) throw new Error(`missing ${text}, --glow, or --background`);
    expect(contrast(fg, composite(glow, background))).toBeGreaterThanOrEqual(4.5);
  });
});

test("--text-secondary measures the designed ratios at the glow peak", () => {
  // component-website v3 states 4.63:1 in light and 6.22:1 in dark, to two
  // truncated decimals.
  const ratio = (palette: Record<string, string>) =>
    Math.floor(
      contrast(
        palette["--text-secondary"] ?? "",
        composite(palette["--glow"] ?? "", palette["--background"] ?? ""),
      ) * 100,
    ) / 100;
  expect(ratio(light)).toBe(4.63);
  expect(ratio(dark)).toBe(6.22);
});

test("compositing matches the endpoints", () => {
  expect(composite("rgba(79, 70, 229, 0)", "#ffffff")).toEqual([255, 255, 255]);
  expect(composite("rgba(79, 70, 229, 1)", "#ffffff")).toEqual([79, 70, 229]);
});

test("the formula matches known WCAG ratios", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
});
