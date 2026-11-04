// CDP browser check for "/" and "/privacy" (component-website §Verification, Browser).
import { writeFileSync } from "node:fs";
const [OUT, ORIGIN, CDP] = process.argv.slice(2);
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const waiters = []; let requests = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method) {
    if (m.method === "Network.requestWillBeSent") requests.push({ url: m.params.request.url, type: m.params.type });
    for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.res(m.params); }
  }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const once = (method) => new Promise((res) => waiters.push({ method, res }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJS = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
const report = [];
for (const [route, slug] of [["/", "landing"], ["/privacy", "privacy"]])
for (const width of [320, 1280]) for (const scheme of ["light", "dark"]) for (const js of [true, false]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Emulation.setScriptExecutionDisabled", { value: !js });
  await send("Network.clearBrowserCookies");
  requests = [];
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: ORIGIN + route }); await loaded;
  await sleep(300);
  const info = await evalJS(`(() => {
    const d = document.documentElement;
    const main = document.querySelector('main').textContent.replace(/\\s+/g,' ');
    const a = document.querySelector('a[href^="mailto:"]');
    return { title: document.title, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth,
      overflowing: [...document.querySelectorAll('body *')].filter(e => !e.closest('pre') && e.getBoundingClientRect().right > d.clientWidth + 0.5).map(e => e.tagName).slice(0,5),
      scripts: document.querySelectorAll('script').length, inlineOrSrcScripts: [...document.querySelectorAll('script')].map(s => s.src || 'inline'),
      cookie: document.cookie, bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color,
      mailto: document.querySelectorAll('a[href^="mailto:"]').length,
      mailColor: a ? getComputedStyle(a).color : null, mailUnderline: a ? getComputedStyle(a).textDecorationLine : null,
      copyHidden: document.querySelector('[data-copy]')?.hidden ?? null,
      hasAnalyticsCopy: main.includes('The app has no setting to turn analytics off'),
      hasIdentifyCopy: main.includes('Once you sign in, the app identifies you to PostHog'),
      hasAnonymousClaim: /carry no account or identity|Anonymous app usage/.test(main),
      hasEffective: main.includes('Effective 4 November 2026') };
  })()`);
  info.horizontalScroll = info.scrollWidth > info.clientWidth;
  info.requests = requests.map((r) => r.url);
  info.crossOriginRequests = requests.filter((r) => !r.url.startsWith(ORIGIN) && !r.url.startsWith("data:")).map((r) => r.url);
  info.cookies = (await send("Network.getCookies")).cookies.length;
  // Keyboard: walk every focusable element until focus wraps.
  await evalJS("document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)");
  const order = [];
  for (let i = 0; i < 40; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const t = await evalJS(`(() => { const a = document.activeElement; if (!a || a === document.body) return null; const s = getComputedStyle(a); const r = a.getBoundingClientRect();
      return { tag: a.tagName.toLowerCase(), name: (a.getAttribute('aria-label') || a.textContent).replace(/\\s+/g,' ').trim().slice(0,48), href: a.getAttribute('href'), focusVisible: a.matches(':focus-visible'), outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor + ' offset ' + s.outlineOffset, top: r.top + scrollY }; })()`);
    if (!t) break; order.push(t);
  }
  info.tabOrder = order;
  info.allFocusVisible = order.every((t) => t.focusVisible);
  info.tabInReadingOrder = order.every((t, i) => i === 0 || t.top >= order[i - 1].top - 700);
  const tag = `${slug}-${width}-${scheme}-${js ? "js" : "nojs"}`;
  // Load lazy images, then capture the whole page.
  await evalJS(`document.querySelectorAll('img[loading=lazy]').forEach(i => i.loading = 'eager')`);
  await sleep(350);
  info.imagesLoaded = await evalJS(`[...document.images].every(i => i.complete && i.naturalWidth > 0)`);
  await evalJS("document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)");
  const m = await send("Page.getLayoutMetrics");
  const h = Math.ceil(m.cssContentSize.height);
  const full = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
  writeFileSync(`${OUT}/${tag}.png`, Buffer.from(full.data, "base64"));
  if (slug === "privacy") {
    // The Analytics section with its contact link focused, to show the ring.
    await evalJS(`document.querySelector('#analytics').closest('section').querySelector('a').focus({ focusVisible: true })`);
    const r = await evalJS(`(() => { const r = document.querySelector('#analytics').closest('section').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; })()`);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: Math.min(width, r.w + 24), height: r.h + 24, scale: 1 } });
    writeFileSync(`${OUT}/analytics-${width}-${scheme}-${js ? "js" : "nojs"}.png`, Buffer.from(shot.data, "base64"));
    info.analyticsLinkFocusRing = await evalJS(`(() => { const a = document.activeElement; const s = getComputedStyle(a); return a.getAttribute('href') + ' ' + s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor + ' offset ' + s.outlineOffset; })()`);
  }
  report.push({ tag, ...info });
}
writeFileSync(`${OUT}/browser-check.json`, JSON.stringify(report, null, 2));
for (const r of report) {
  console.log(r.tag, `hscroll=${r.horizontalScroll} (${r.scrollWidth}/${r.clientWidth}) overflow=[${r.overflowing}] scripts=${r.scripts} cookies=${r.cookies}+${JSON.stringify(r.cookie)} xorigin=${r.crossOriginRequests.length} requests=${r.requests.length} imgs=${r.imagesLoaded} copyHidden=${r.copyHidden} fv=${r.allFocusVisible} anon=${r.hasAnonymousClaim} identify=${r.hasIdentifyCopy} analyticsCopy=${r.hasAnalyticsCopy} effective=${r.hasEffective} mailto=${r.mailto} ${r.mailColor} ${r.mailUnderline} bg=${r.bodyBg}`);
  console.log("  tab:", r.tabOrder.map((t) => `${t.tag}:${t.name}${t.focusVisible ? "" : "(!fv)"}`).join(" > "));
  console.log("  ring:", r.tabOrder[0]?.outline, r.analyticsLinkFocusRing ?? "");
}
ws.close();
