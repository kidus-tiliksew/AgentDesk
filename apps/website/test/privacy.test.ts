import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import Privacy from "../src/pages/privacy.astro";
import { PRIVACY_CONTACT, PRIVACY_OPERATOR } from "../src/site";

// component-website §Verification: the rendered privacy policy carries every
// element req-website REQ-3 requires.
let html = "";

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(Privacy, {
    request: new Request("https://agentdesk.kidus.sh/privacy"),
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function text(): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function meta(attribute: "name" | "property", key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta[^>]*${attribute}="${escapeRegExp(key)}"[^>]*>`))?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1];
}

const TITLE = "Privacy policy · AgentDesk";

describe("operator and contact (AC-3.1)", () => {
  test("names the operator and links the contact address", () => {
    expect(text()).toContain(`${PRIVACY_OPERATOR} runs the AgentDesk service.`);
    expect(html).toContain(`<a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>`);
  });

  test("shows the effective date and how changes are published", () => {
    expect(text()).toContain("Effective 14 October 2026");
    expect(text()).toContain("published on this page with a new effective date");
  });
});

describe("sections", () => {
  test("has one h1 and the nine §Privacy policy sections, in order", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const headings = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual([
      "Who runs AgentDesk",
      "What AgentDesk stores",
      "Push notifications",
      "Service providers",
      "Analytics",
      "How long AgentDesk keeps it",
      "Deleting your data",
      "Children",
      "Contact",
    ]);
  });

  test("links the mark and wordmark to the landing page", () => {
    expect(html).toMatch(
      /<a class="brand" href="\/">\s*<img[^>]*>\s*<span>AgentDesk<\/span>\s*<\/a>/,
    );
  });
});

describe("content", () => {
  test("lists each stored category (AC-3.2)", () => {
    const body = text();
    for (const phrase of [
      "email address",
      "titles, bodies, and options",
      "your answers, your notes",
      "chat message an agent relays",
      "name, topic, status lines, and links",
      "harness it belongs to",
      "host name",
      "device name, push token, and time zone",
      "notification rules and settings",
      "only to show it to you",
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  test("says what push notifications carry and that they carry no body (AC-3.3)", () => {
    const body = text();
    expect(body).toContain("Expo push service and Apple Push Notification service");
    expect(body).toContain("title and option labels, its topic, an agent's name and status line");
    expect(body).toContain("never carries a decision's body");
  });

  test("names each service provider and shares with no one else (AC-3.4)", () => {
    const rows = [...html.matchAll(/<th scope="row">([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(rows).toEqual([
      "Clerk",
      "Convex",
      "Expo and Apple",
      "Cloudflare",
      "PostHog",
      "Vercel",
      "GitHub",
    ]);
    expect(text()).toContain("shares your data with no one else");
  });

  test("describes anonymous app analytics and a website without cookies (AC-3.5)", () => {
    const body = text();
    expect(body).toContain("carry no account or identity");
    expect(body).toContain("derives no location");
    expect(body).toContain("no touches, screen content, session recordings, or surveys");
    expect(body).toContain("sets no cookies and runs no analytics");
    expect(body).toContain("does not sell your data, does not use it for advertising");
    expect(body).toContain("does not track you");
  });

  test("states the retention periods (AC-3.6)", () => {
    const body = text();
    expect(body).toContain("ends after 24 hours without activity");
    expect(body).toContain("deleted 7 days after it ends");
    expect(body).toContain("deleted 24 hours after it starts");
    expect(body).toContain("Once sending has finished and more than 24 hours have passed");
    expect(body).toContain("since the notification was queued");
    expect(body).toContain("a copy can stay longer, with no fixed limit");
    expect(body).toContain("a newer, unsent, or unrecognized notification");
    expect(body).toContain("more than 4,000 notifications");
    expect(body).not.toMatch(/after it is delivered/);
    expect(body).toContain("for 30 days");
  });

  test("says how to delete data (AC-3.7)", () => {
    const body = text();
    expect(body).toContain("Delete Account");
    expect(body).toContain("deleted within 24 hours");
    expect(body).toContain("swipe it in History and choose Delete");
    expect(body).toContain("choose Revoke");
    expect(body).toContain("agentdesk uninstall");
    expect(body).toContain(
      `To get a copy of your data or have it deleted, email ${PRIVACY_CONTACT}`,
    );
  });

  test("states that AgentDesk is not directed at children (AC-3.8)", () => {
    expect(text()).toContain("not directed at children under 13");
  });
});

describe("footer (AC-3.9)", () => {
  test("links the privacy policy from the footer", () => {
    const footer = html.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "";
    expect(footer).toContain('<a href="/privacy">Privacy</a>');
  });
});

describe("metadata (AC-3.10)", () => {
  test("sets its own title and description", () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(meta("name", "description")).toMatch(/^What AgentDesk stores about you/);
  });

  test("sets the Open Graph and Twitter card tags", () => {
    expect(meta("property", "og:title")).toBe(TITLE);
    expect(meta("property", "og:description")).toBe(meta("name", "description"));
    expect(meta("property", "og:type")).toBe("website");
    expect(meta("property", "og:url")).toBe("https://agentdesk.kidus.sh/privacy");
    expect(meta("property", "og:image")).toBe("https://agentdesk.kidus.sh/og.png");
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
  });

  test("links the favicon and apple-touch-icon", () => {
    expect(html).toMatch(/<link rel="icon" type="image\/png" href="\/favicon.png">/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
  });
});

describe("no script or third-party resources (AC-1.7)", () => {
  test("has no script", () => {
    expect(html).not.toMatch(/<script[\s>]/);
  });

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
});
