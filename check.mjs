// CDP browser check for "/" (component-website §Verification, Browser).
import { writeFileSync } from "node:fs";
const OUT = process.argv[2];
const URL_ = "http://127.0.0.1:4321/";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const waiters = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method) for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.res(m.params); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const once = (method) => new Promise((res) => waiters.push({ method, res }));
const evalJS = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
await send("Page.enable"); await send("Runtime.enable");
const report = [];
for (const width of [320, 1280]) for (const scheme of ["light", "dark"]) for (const js of [true, false]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: width < 600 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Emulation.setScriptExecutionDisabled", { value: !js });
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: URL_ }); await loaded;
  await new Promise((r) => setTimeout(r, 300));
  const info = await evalJS(`(() => {
    const note = [...document.querySelectorAll('p.note')].find(p => p.textContent.includes('early development'));
    const links = [...note.querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.getAttribute('href'), color: getComputedStyle(a).color, underline: getComputedStyle(a).textDecorationLine }));
    const r = note.getBoundingClientRect();
    return { noteText: note.textContent.replace(/\\s+/g,' ').trim(), links, imgs: note.querySelectorAll('img').length,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      noteRect: { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height },
      copyHidden: document.querySelector('[data-copy]').hidden, bodyBg: getComputedStyle(document.body).backgroundColor };
  })()`);
  info.horizontalScroll = info.scrollWidth > info.clientWidth;
  // Keyboard tab order and focus ring.
  await evalJS("document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)");
  const order = [];
  for (let i = 0; i < 9; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    order.push(await evalJS(`(() => { const a = document.activeElement; const s = getComputedStyle(a);
      return { tag: a.tagName.toLowerCase(), name: (a.getAttribute('aria-label') || a.textContent).replace(/\\s+/g,' ').trim().slice(0,40), href: a.getAttribute('href'), focusVisible: a.matches(':focus-visible'), outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor + ' offset ' + s.outlineOffset }; })()`));
  }
  info.tabOrder = order;
  const tag = `${width}-${scheme}-${js ? "js" : "nojs"}`;
  // Screenshot of the hero note (padded), with the App Store link focused to show the ring.
  await evalJS(`document.querySelector('p.note a[href*="apps.apple.com"]').focus({ focusVisible: true })`);
  const kb = await evalJS(`(() => { const a = document.querySelector('p.note a[href*="apps.apple.com"]'); return a.matches(':focus-visible'); })()`);
  info.storeLinkFocusVisibleAfterKeyboard = kb;
  const pad = 16; const r = info.noteRect;
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(width, r.w + 2 * pad), height: r.h + 2 * pad, scale: 1 } });
  writeFileSync(`${OUT}/hero-note-${tag}.png`, Buffer.from(shot.data, "base64"));
  await evalJS("window.scrollTo(0,0)"); await new Promise((r) => setTimeout(r, 150));
  const full = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: 900, scale: 1 } });
  writeFileSync(`${OUT}/hero-${tag}.png`, Buffer.from(full.data, "base64"));
  report.push({ tag, ...info });
}
writeFileSync(`${OUT}/browser-check.json`, JSON.stringify(report, null, 2));
for (const r of report) console.log(r.tag, "hscroll=" + r.horizontalScroll, `(${r.scrollWidth}/${r.clientWidth})`, "imgs=" + r.imgs, "copyHidden=" + r.copyHidden, JSON.stringify(r.links.map(l => [l.text, l.href, l.color, l.underline])), "\n  tab:", r.tabOrder.map(t => `${t.tag}:${t.name}${t.focusVisible ? "" : "(!fv)"}`).join(" > "), "\n  ring:", r.tabOrder[4]?.outline, r.tabOrder[5]?.outline);
ws.close();
