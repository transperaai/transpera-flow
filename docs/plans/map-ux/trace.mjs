import { chromium } from "playwright-core";

// Where the main thread's time goes during an interaction (production build): style, layout, paint, script.
const BASE = process.env.BASE ?? "http://127.0.0.1:3477";
const [path, what] = [process.argv[2] ?? "/demo/overview", process.argv[3] ?? "play"];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
await p.goto(BASE + path, { waitUntil: "networkidle" });
await p.waitForSelector(".react-flow__node");
await p.waitForTimeout(3000);
await browser.startTracing(p, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
if (what === "play") {
  await p.locator("button[aria-label*='Play' i]").first().click();
  await p.waitForTimeout(2000);
} else if (what === "zoom") {
  for (let i = 0; i < 3; i++) {
    await p.locator("button[aria-label*='Zoom in' i]").first().click();
    await p.waitForTimeout(300);
    await p.locator("button[aria-label*='Zoom out' i]").first().click();
    await p.waitForTimeout(300);
  }
}
const buf = await browser.stopTracing();
const events = JSON.parse(buf.toString()).traceEvents;
const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
const sum = new Map();
const count = new Map();
for (const e of events) {
  if (e.ph !== "X" || !e.dur || (main && e.tid !== main.tid)) continue;
  if (!["UpdateLayoutTree", "Layout", "Paint", "PrePaint", "Layerize", "Commit", "FunctionCall", "TimerFire", "FireAnimationFrame", "EventDispatch", "HitTest", "ParseHTML", "UpdateLayer", "RunTask", "PaintImage", "ScrollLayer"].includes(e.name)) continue;
  sum.set(e.name, (sum.get(e.name) ?? 0) + e.dur / 1000);
  count.set(e.name, (count.get(e.name) ?? 0) + 1);
}
for (const [k, v] of [...sum].sort((a, b) => b[1] - a[1])) console.log(`${k.padEnd(20)} ${v.toFixed(0).padStart(6)} ms  x${count.get(k)}`);
await browser.close();
