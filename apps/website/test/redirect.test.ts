import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// component-website §Install redirect: Vercel answers GET /install with a 307
// to the gateway's /install.sh (req-website AC-2.1, DEC-14(2)).
const root = new URL("../", import.meta.url);

describe("install redirect", () => {
  test("vercel.json declares exactly one temporary /install redirect to the gateway", () => {
    const config = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8")) as {
      redirects: Array<Record<string, unknown>>;
    };
    expect(config.redirects).toEqual([
      {
        source: "/install",
        destination: "https://agentdesk-gateway.kidus-tiliksew.workers.dev/install.sh",
        permanent: false,
      },
    ]);
  });

  test("no Astro route or Astro redirect shadows /install", () => {
    const pages = readdirSync(new URL("src/pages/", root));
    expect(pages.filter((name) => name.startsWith("install"))).toEqual([]);
    expect(existsSync(new URL("src/pages/install", root))).toBe(false);
    const astroConfig = readFileSync(new URL("astro.config.mjs", root), "utf8");
    expect(astroConfig).not.toMatch(/redirects/);
  });
});
