import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// The installer's file read by the test bundler, independent of the Worker's
// Text module rule.
import source from "../../../packages/installer/install.sh?raw";
import { handle } from "../src/index.js";
import { installScript, ORIGIN_PLACEHOLDER } from "../src/install.js";
import { env, fakeConvex, routeRequest } from "./fake.js";

// component-gateway §Routes: `GET /install.sh` serves component-installer's
// script with the server origin filled in.

describe("GET /install.sh", () => {
  it("serves the installer's file with the placeholder replaced through the Worker entrypoint", async () => {
    const response = await exports.default.fetch("http://localhost:8787/install.sh");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(source).toContain(`AGENTDESK_ORIGIN="${ORIGIN_PLACEHOLDER}"`);
    expect(text).toBe(source.replace(ORIGIN_PLACEHOLDER, "http://localhost:8787"));
    expect(text).toContain('AGENTDESK_ORIGIN="http://localhost:8787"');
    expect(text).not.toContain(ORIGIN_PLACEHOLDER);
  });

  it("removes trailing slashes from PUBLIC_ORIGIN and calls nothing", async () => {
    const convex = fakeConvex();

    const response = await handle(
      routeRequest("GET", "/install.sh"),
      { ...env, PUBLIC_ORIGIN: "https://agentdesk.example//" },
      convex.svc,
    );

    expect(await response.text()).toBe(
      source.replace(ORIGIN_PLACEHOLDER, "https://agentdesk.example"),
    );
    expect(convex.calls).toEqual([]);
  });

  it("inserts the origin literally", () => {
    expect(installScript("https://a.example/$&$1")).toContain(
      'AGENTDESK_ORIGIN="https://a.example/$&$1"',
    );
  });
});
