// Browser evidence for task 261014-bafaf2 (component-website §Verification,
// Browser). Drives headless Google Chrome over the DevTools protocol against
// `astro preview` and writes screenshots plus results.json beside this file.
// Usage: node browser-check.mjs <origin>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const origin = process.argv[2] ?? "http://127.0.0.1:4329";
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "screenshots");
mkdirSync(shots, { recursive: true });
const port = 9339;
const chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(here, ".chrome-profile")}`,
  "--no-first-run",
  "--hide-scrollbars",
  "about:blank",
]);

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const waiters = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

await send("Page.enable");
await send("Runtime.enable");

async function load(path) {
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: origin + path });
  await loaded;
  // Full-page captures reach below the viewport, so load lazy images first.
  await evaluate(`Promise.all([...document.images].map(img => {
    img.loading = "eager";
    return img.complete && img.naturalWidth > 0 ? null : new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 3000); });
  })).then(() => new Promise(r => setTimeout(r, 300)))`);
}

async function shot(name, fullPage = true) {
  const params = { format: "png" };
  if (fullPage) {
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  const { data } = await send("Page.captureScreenshot", params);
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
  return `screenshots/${name}.png`;
}

const results = { origin, layout: [], keyboard: {}, noJavaScript: {} };
const routes = [
  { name: "landing", path: "/" },
  { name: "privacy", path: "/privacy" },
];

// AC-1.8, AC-1.10, AC-3.10: both schemes at 320px and 1280px, no page overflow.
for (const scheme of ["light", "dark"]) {
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
  for (const width of [320, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 800,
    });
    for (const route of routes) {
      await load(route.path);
      const metrics = await evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
        phoneImagesLoaded: [...document.querySelectorAll('figure.phone img')].map(i => i.complete && i.naturalWidth > 0),
      })`);
      const file = await shot(`${route.name}-${width}-${scheme}`);
      results.layout.push({
        route: route.path,
        width,
        scheme,
        ...metrics,
        horizontalOverflow: metrics.scrollWidth > metrics.innerWidth,
        screenshot: file,
      });
    }
  }
}

// AC-1.9: keyboard order, accessible names, and visible focus.
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
for (const route of routes) {
  await load(route.path);
  const stops = [];
  for (let i = 0; i < 40; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const stop = await evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim(),
        href: el.getAttribute('href'),
        outline: style.outlineStyle + ' ' + style.outlineWidth + ' ' + style.outlineColor,
        offset: style.outlineOffset,
        top: Math.round(r.top + window.scrollY),
      };
    })()`);
    if (!stop) break;
    if (stops.length && stops[0].tag === stop.tag && stops[0].name === stop.name && stops[0].top === stop.top) break;
    stops.push(stop);
    if (i === 0) await shot(`${route.name}-focus-first`, false);
  }
  results.keyboard[route.path] = stops;
}
await shot("privacy-focus-last", false);

// AC-1.7: JavaScript disabled.
await send("Emulation.setScriptExecutionDisabled", { value: true });
for (const route of routes) {
  await load(route.path);
  results.noJavaScript[route.path] = await evaluate(`({
    textLength: document.body.innerText.length,
    installCommand: document.querySelector('pre code')?.textContent ?? null,
    copyButtonHidden: document.querySelector('[data-copy]')?.hidden ?? null,
    footerPrivacyLink: !!document.querySelector('footer a[href="/privacy"]'),
    h2Count: document.querySelectorAll('main h2').length,
  })`);
  results.noJavaScript[route.path].screenshot = await shot(`${route.name}-no-js-1280-light`);
}

writeFileSync(join(here, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
ws.close();
chrome.kill();
console.log(JSON.stringify(results, null, 1));
