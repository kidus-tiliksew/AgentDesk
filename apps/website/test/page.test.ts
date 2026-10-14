import { readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import Index from "../src/pages/index.astro";
import { INSTALL_COMMAND, REPOSITORY_URL, SITE_DESCRIPTION, SITE_TITLE } from "../src/site";

// component-website §Verification: the rendered page carries every element
// req-website REQ-1 requires.
let html = "";

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(Index, {
    request: new Request("https://agentdesk.kidus.sh/"),
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function text(): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function meta(attribute: "name" | "property", key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta[^>]*${attribute}="${escapeRegExp(key)}"[^>]*>`))?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1];
}

describe("install block", () => {
  test("shows the install command inside the focusable, labelled pre's code (AC-1.3)", () => {
    expect(html).toMatch(
      new RegExp(
        `<pre[^>]*tabindex="0"[^>]*aria-label="Install command"[^>]*><code>${escapeRegExp(INSTALL_COMMAND)}</code></pre>`,
      ),
    );
  });

  test("renders the copy button hidden with its label, beside a live status region (AC-1.3, AC-1.7)", () => {
    const button = html.match(/<button[^>]*data-copy[^>]*>([\s\S]*?)<\/button>/);
    const opening = button?.[0].match(/^<button[^>]*>/)?.[0];
    expect(opening).toMatch(/\shidden[\s>]/);
    expect(opening).toMatch(/type="button"/);
    const content = button?.[1] ?? "";
    // The accessible name is the button's whole text content.
    expect(content.replace(/<[^>]+>/g, "")).toBe("Copy install command");
    // Only "Copy" shows; " install command" is in a visually hidden span.
    expect(content).toMatch(/^Copy<span class="visually-hidden"> install command<\/span>$/);
    expect(html).toMatch(/<span[^>]*role="status"[^>]*aria-live="polite"[^>]*>/);
  });
});

describe("phone figures", () => {
  const images = () =>
    [...html.matchAll(/<img\s[^>]*src="\/screens\/[^"]*"[^>]*>/g)].map((m) => m[0]);
  const attribute = (tag: string, name: string) =>
    tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

  test("shows the four screens, hero first, each in a figure", () => {
    expect(images().map((tag) => attribute(tag, "src"))).toEqual([
      "/screens/decision.webp",
      "/screens/inbox.webp",
      "/screens/notification.webp",
      "/screens/agents.webp",
    ]);
    expect(html.match(/<figure class="phone[^"]*">\s*<img\s[^>]*src="\/screens\//g)).toHaveLength(
      4,
    );
  });

  test("gives each screen its size and a non-empty alt text", () => {
    for (const tag of images()) {
      expect(attribute(tag, "width"), tag).toBe("906");
      expect(attribute(tag, "height"), tag).toBe("1968");
      expect(attribute(tag, "alt")?.trim(), tag).toBeTruthy();
    }
  });

  test("loads the hero eagerly and the step screens lazily", () => {
    const [hero = "", ...steps] = images();
    expect(hero).toContain("/screens/decision.webp");
    expect(attribute(hero, "loading")).toBeUndefined();
    expect(steps).toHaveLength(3);
    for (const tag of steps) expect(attribute(tag, "loading"), tag).toBe("lazy");
  });
});

describe("content", () => {
  test("states what AgentDesk does (AC-1.1)", () => {
    const body = text();
    expect(body).toMatch(/ask you for decisions and report their status over MCP/);
    expect(body).toMatch(/answer from your phone/);
    expect(body).toMatch(/keeps going/);
  });

  test("has a heading for each AC-1.2 capability, in order (AC-1.2)", () => {
    const headings = [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1]);
    const capabilities = [
      "Decision requests",
      "Live agent status",
      "Notification rules and the daily digest",
      "One install per machine",
      "Open HTTP API and webhooks",
    ];
    const positions = capabilities.map((title) => headings.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("describes each AC-1.2 capability (AC-1.2)", () => {
    const body = text();
    for (const phrase of [
      "approve-or-reject",
      "multiple-choice",
      "free-text",
      "recommendation",
      "deadline",
      "default",
      "gone quiet",
      "daily digest",
      "every repository",
      "SSH",
      "HTTP API and webhooks",
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  test("names the three supported harnesses (AC-1.4)", () => {
    for (const name of ["Claude Code", "Codex", "Cursor"]) {
      expect(html).toContain(`<li>${name}</li>`);
    }
  });

  test("links the repository and its MIT license (AC-1.5)", () => {
    expect(html).toContain(`href="${REPOSITORY_URL}"`);
    expect(html).toMatch(
      new RegExp(
        `<a href="${escapeRegExp(`${REPOSITORY_URL}/blob/main/LICENSE`)}">[^<]*MIT[^<]*</a>`,
      ),
    );
  });

  test("separates the footer links with a space", () => {
    expect(html).toMatch(/MIT license<\/a>\. <a /);
  });

  test("links the privacy policy from the footer (AC-3.9)", () => {
    const footer = html.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "";
    expect(footer).toContain('<a href="/privacy">Privacy</a>');
  });

  test("states early development and carries no app store links (AC-1.6)", () => {
    expect(text()).toContain("AgentDesk is in early development.");
    expect(html).not.toMatch(/apps\.apple\.com|play\.google\.com/);
  });

  test("keeps the sections in the designed order", () => {
    const order = [
      "<header",
      'id="hero-title"',
      'id="how-title"',
      'id="features-title"',
      'id="harnesses-title"',
      "<footer",
    ];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("metadata (AC-1.11)", () => {
  test("sets the language, viewport, title, and description", () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(meta("name", "viewport")).toBe("width=device-width, initial-scale=1");
    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
    expect(meta("name", "description")).toBe(SITE_DESCRIPTION);
  });

  test("sets the Open Graph and Twitter card tags", () => {
    expect(meta("property", "og:title")).toBe(SITE_TITLE);
    expect(meta("property", "og:description")).toBe(SITE_DESCRIPTION);
    expect(meta("property", "og:type")).toBe("website");
    expect(meta("property", "og:url")).toBe("https://agentdesk.kidus.sh/");
    expect(meta("property", "og:image")).toBe("https://agentdesk.kidus.sh/og.png");
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
  });

  test("links the favicon and apple-touch-icon", () => {
    expect(html).toMatch(/<link rel="icon" type="image\/png" href="\/favicon.png">/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
  });
});

describe("third-party resources", () => {
  test("loads no src or href from another origin, except <a> links", () => {
    const withoutAnchors = html.replace(/<a\s[^>]*>/g, "");
    const references = [...withoutAnchors.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference, reference).toMatch(/^\/(?!\/)/);
    }
  });

  test("the stylesheet imports nothing and loads no url() from another origin", () => {
    const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/url\(/);
  });
});
